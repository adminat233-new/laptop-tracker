"use strict";

const crypto = require("node:crypto");
const express = require("express");

const PAIR_CODE_TTL_MS = 10 * 60 * 1000;

function hashSecret(secret) {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

function newSecret() {
  return crypto.randomBytes(32).toString("base64url");
}

function tokenMatches(token, expectedHash) {
  if (typeof token !== "string" || typeof expectedHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(expectedHash)) return false;
  const actual = Buffer.from(hashSecret(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return crypto.timingSafeEqual(actual, expected);
}

function createSecureTrackerRouter(options) {
  const router = express.Router();
  const prisma = options.prisma;
  const smoothLocation = options.smoothLocation;
  const now = options.now || Date.now;
  const rateBuckets = new Map();

  function rateLimit(req, kind, limit) {
    const time = now();
    const key = kind + ":" + String(req.socket.remoteAddress || "unknown");
    let bucket = rateBuckets.get(key);
    if (!bucket || time - bucket.started >= 60000) {
      bucket = { started: time, count: 0 };
      rateBuckets.set(key, bucket);
    }
    bucket.count++;
    rateBuckets.forEach(function (value, bucketKey) {
      if (time - value.started >= 60000) rateBuckets.delete(bucketKey);
    });
    return bucket.count <= limit;
  }

  function failServer(res, error) {
    console.error("Secure tracker API error:", error && error.message ? error.message : error);
    return res.status(503).json({ success: false, error: "service_unavailable" });
  }

  router.post("/api/v2/pair/generate", async function (req, res) {
    if (!rateLimit(req, "pair-generate", 5)) {
      return res.status(429).json({ success: false, error: "rate_limited" });
    }
    const deviceType = req.body && req.body.deviceType;
    if (!["laptop", "phone", "server"].includes(deviceType)) {
      return res.status(400).json({ success: false, error: "invalid_device_type" });
    }
    const timestamp = BigInt(now());
    const pairCode = newSecret();
    const pairId = crypto.randomBytes(18).toString("hex");
    const deviceId = "d_" + crypto.randomBytes(18).toString("hex");
    const deviceToken = newSecret();
    try {
      await prisma.$transaction(async function (tx) {
        await tx.device.create({
          data: {
            deviceId: deviceId,
            pairCode: pairId,
            deviceType: deviceType,
            authTokenHash: hashSecret(deviceToken),
            isLost: false,
            createdAt: timestamp,
            lastSeen: timestamp
          }
        });
        await tx.securePairing.create({
          data: {
            pairId: pairId,
            pairCodeHash: hashSecret(pairCode),
            laptopDeviceId: deviceId,
            createdAt: timestamp,
            expiresAt: timestamp + BigInt(PAIR_CODE_TTL_MS)
          }
        });
      });
      return res.status(201).json({
        success: true,
        pairCode: pairCode,
        deviceId: deviceId,
        deviceToken: deviceToken,
        expiresAt: Number(timestamp + BigInt(PAIR_CODE_TTL_MS))
      });
    } catch (error) {
      return failServer(res, error);
    }
  });

  router.post("/api/v2/pair/verify", async function (req, res) {
    if (!rateLimit(req, "pair-verify", 10)) {
      return res.status(429).json({ success: false, error: "rate_limited" });
    }
    const body = req.body || {};
    if (typeof body.pairCode !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(body.pairCode) ||
        !["laptop", "phone", "server"].includes(body.deviceType)) {
      return res.status(400).json({ success: false, error: "invalid_pairing_request" });
    }
    const pairCodeHash = hashSecret(body.pairCode);
    const timestamp = BigInt(now());
    const deviceId = "d_" + crypto.randomBytes(18).toString("hex");
    const deviceToken = newSecret();
    try {
      const result = await prisma.$transaction(async function (tx) {
        const pairing = await tx.securePairing.findUnique({ where: { pairCodeHash: pairCodeHash } });
        if (!pairing || pairing.pairedAt != null || pairing.expiresAt <= timestamp) return null;
        const claimed = await tx.securePairing.updateMany({
          where: {
            pairCodeHash: pairCodeHash,
            pairedAt: null,
            expiresAt: { gt: timestamp }
          },
          data: { pairedAt: timestamp }
        });
        if (claimed.count !== 1) return null;
        await tx.device.create({
          data: {
            deviceId: deviceId,
            pairCode: pairing.pairId,
            deviceType: body.deviceType,
            authTokenHash: hashSecret(deviceToken),
            isLost: false,
            createdAt: timestamp,
            lastSeen: timestamp
          }
        });
        return { pairId: pairing.pairId, laptopDeviceId: pairing.laptopDeviceId };
      });
      if (!result) {
        return res.status(404).json({ success: false, error: "pairing_expired_or_used" });
      }
      return res.status(201).json({
        success: true,
        deviceId: deviceId,
        deviceToken: deviceToken,
        pairedDeviceId: result.laptopDeviceId,
        pairId: result.pairId
      });
    } catch (error) {
      return failServer(res, error);
    }
  });

  router.get("/api/v2/pair-info", async function (req, res) {
    const header = req.get("Authorization") || "";
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
    if (!match) return res.status(401).json({ success: false, error: "unauthorized" });
    try {
      const device = await prisma.device.findUnique({ where: { deviceId: req.query.deviceId } });
      if (!device || !tokenMatches(match[1], device.authTokenHash)) {
        return res.status(401).json({ success: false, error: "unauthorized" });
      }
      const devices = await prisma.device.findMany({ where: { pairCode: device.pairCode } });
      const members = await Promise.all(devices.map(async function (member) {
        const location = await prisma.location.findUnique({ where: { deviceId: member.deviceId } });
        return {
          deviceId: member.deviceId,
          deviceType: member.deviceType,
          online: Date.now() - Number(member.lastSeen || 0) < 60000,
          lastSeen: member.lastSeen == null ? null : Number(member.lastSeen),
          isLost: member.isLost,
          location: location && location.lat != null ? {
            lat: location.lat,
            lng: location.lng,
            accuracy: location.accuracy,
            source: location.source,
            updatedAt: location.updatedAt == null ? null : Number(location.updatedAt)
          } : null
        };
      }));
      return res.json({ success: true, deviceId: device.deviceId, devices: members });
    } catch (error) {
      return failServer(res, error);
    }
  });

  router.post("/api/v2/heartbeat", async function (req, res) {
    const body = req.body || {};
    if (typeof body.deviceId !== "string" || !body.deviceId) {
      return res.status(400).json({ success: false, error: "invalid_device_id" });
    }
    const header = req.get("Authorization") || "";
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
    if (!match) return res.status(401).json({ success: false, error: "unauthorized" });
    try {
      const device = await prisma.device.findUnique({ where: { deviceId: body.deviceId } });
      if (!device || !tokenMatches(match[1], device.authTokenHash)) {
        return res.status(401).json({ success: false, error: "unauthorized" });
      }
      const update = { lastSeen: BigInt(now()) };
      let acceptedLocation = null;
      if (body.location != null) {
        const location = body.location;
        if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng) ||
            location.lat < -90 || location.lat > 90 ||
            location.lng < -180 || location.lng > 180 ||
            (location.source != null &&
             (typeof location.source !== "string" || location.source.length > 50))) {
          return res.status(400).json({ success: false, error: "invalid_location" });
        }
        const smoothed = smoothLocation(body.deviceId, location);
        await prisma.location.upsert({
          where: { deviceId: body.deviceId },
          create: {
            deviceId: body.deviceId,
            lat: smoothed.lat,
            lng: smoothed.lng,
            source: smoothed.source || location.source || "authenticated-heartbeat",
            updatedAt: BigInt(now())
          },
          update: {
            lat: smoothed.lat,
            lng: smoothed.lng,
            source: smoothed.source || location.source || "authenticated-heartbeat",
            updatedAt: BigInt(now())
          }
        });
        acceptedLocation = smoothed;
      }
      await prisma.device.update({
        where: { deviceId: body.deviceId },
        data: update
      });
      return res.json({ success: true, locationAccepted: acceptedLocation != null });
    } catch (error) {
      return failServer(res, error);
    }
  });

  router.post("/api/v2/lost-mode", async function (req, res) {
    const body = req.body || {};
    if (typeof body.deviceId !== "string" || typeof body.active !== "boolean") {
      return res.status(400).json({ success: false, error: "invalid_lost_mode_request" });
    }
    const header = req.get("Authorization") || "";
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
    if (!match) return res.status(401).json({ success: false, error: "unauthorized" });
    try {
      const device = await prisma.device.findUnique({ where: { deviceId: body.deviceId } });
      if (!device || !tokenMatches(match[1], device.authTokenHash)) {
        return res.status(401).json({ success: false, error: "unauthorized" });
      }
      await prisma.device.update({
        where: { deviceId: body.deviceId },
        data: { isLost: body.active, lastSeen: BigInt(now()) }
      });
      return res.json({ success: true, isLost: body.active });
    } catch (error) {
      return failServer(res, error);
    }
  });

  router.post("/api/v2/revoke-device", async function (req, res) {
    const body = req.body || {};
    if (typeof body.deviceId !== "string" || typeof body.targetDeviceId !== "string") {
      return res.status(400).json({ success: false, error: "invalid_revoke_request" });
    }
    const header = req.get("Authorization") || "";
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
    if (!match) return res.status(401).json({ success: false, error: "unauthorized" });
    try {
      const actor = await prisma.device.findUnique({ where: { deviceId: body.deviceId } });
      const target = await prisma.device.findUnique({ where: { deviceId: body.targetDeviceId } });
      if (!actor || !tokenMatches(match[1], actor.authTokenHash)) {
        return res.status(401).json({ success: false, error: "unauthorized" });
      }
      if (!target || target.pairCode !== actor.pairCode) {
        return res.status(404).json({ success: false, error: "device_not_found" });
      }
      await prisma.device.update({
        where: { deviceId: target.deviceId },
        data: { authTokenHash: null }
      });
      return res.json({ success: true, revokedDeviceId: target.deviceId });
    } catch (error) {
      return failServer(res, error);
    }
  });

  return router;
}

module.exports = {
  createSecureTrackerRouter: createSecureTrackerRouter,
  hashSecret: hashSecret,
  tokenMatches: tokenMatches
};

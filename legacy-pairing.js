"use strict";

// Legacy 8-character pairing kept for every shipped client, but upgraded to
// issue the same per-device bearer credentials used by the secure v2 router.
// The short code stays a human-friendly identifier; the 43-character token is
// the actual WebSocket credential and is never stored in plaintext.

const express = require("express");
const crypto = require("crypto");
const { hashSecret, newSecret } = require("./secure-tracker-api");

const PAIR_CODE_PATTERN = /^[0-9A-F]{8}$/;

function createLegacyPairingRouter(options) {
  const router = express.Router();
  const prisma = options.prisma;
  const now = options.now || function () { return BigInt(Date.now()); };
  const broadcast = options.broadcast || function () {};

  router.post("/api/generate", async function (req, res) {
    try {
      const pairCode = crypto.randomBytes(4).toString("hex").toUpperCase();
      const laptopId = pairCode;
      const deviceToken = newSecret();
      const authTokenHash = hashSecret(deviceToken);

      await prisma.code.upsert({
        where: { pairCode: pairCode },
        create: { pairCode: pairCode, binaryCode: pairCode, deviceId: laptopId, createdAt: now() },
        update: { deviceId: laptopId }
      });

      await prisma.device.upsert({
        where: { deviceId: laptopId },
        create: {
          deviceId: laptopId,
          pairCode: pairCode,
          deviceType: "laptop",
          authTokenHash: authTokenHash,
          createdAt: now(),
          lastSeen: now()
        },
        update: {
          pairCode: pairCode,
          deviceType: "laptop",
          authTokenHash: authTokenHash,
          lastSeen: now()
        }
      });

      // Initial location keeps /api/pair-info useful before the first heartbeat.
      try {
        await prisma.location.upsert({
          where: { deviceId: laptopId },
          create: { deviceId: laptopId, lat: null, lng: null, source: "init", updatedAt: now() },
          update: { updatedAt: now() }
        });
      } catch (error) {
        console.log("Location upsert skipped:", error.message.substring(0, 80));
      }

      console.log("Generated pair code: " + pairCode + " for laptop: " + laptopId);
      return res.json({ success: true, pairCode: pairCode, deviceId: laptopId, deviceToken: deviceToken });
    } catch (error) {
      console.error("Generate Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post("/api/verify", async function (req, res) {
    try {
      const rawCode = (req.body && req.body.pairCode) || "";
      const codeValue = String(rawCode).toUpperCase().trim();
      if (!PAIR_CODE_PATTERN.test(codeValue)) {
        return res.json({ success: false, error: "Invalid code" });
      }

      const code = await prisma.code.findUnique({ where: { pairCode: codeValue } });
      if (!code) {
        console.log("Code not found:", codeValue);
        return res.json({ success: false, error: "Invalid code" });
      }

      const phoneId = codeValue + "-phone";
      const laptopId = code.deviceId || codeValue;
      const deviceToken = newSecret();
      const authTokenHash = hashSecret(deviceToken);

      await prisma.device.upsert({
        where: { deviceId: phoneId },
        create: {
          deviceId: phoneId,
          pairCode: codeValue,
          deviceType: "phone",
          authTokenHash: authTokenHash,
          createdAt: now(),
          lastSeen: now()
        },
        update: {
          pairCode: codeValue,
          deviceType: "phone",
          authTokenHash: authTokenHash,
          lastSeen: now()
        }
      });

      try {
        await prisma.location.upsert({
          where: { deviceId: phoneId },
          create: { deviceId: phoneId, lat: null, lng: null, source: "init", updatedAt: now() },
          update: { updatedAt: now() }
        });
      } catch (error) {
        console.log("Phone location upsert skipped:", error.message.substring(0, 80));
      }

      console.log("Phone " + phoneId + " paired with laptop " + laptopId);
      broadcast(laptopId, { type: "paired", phoneId: phoneId });

      return res.json({
        success: true,
        laptopId: laptopId,
        phoneId: phoneId,
        pairCode: codeValue,
        deviceToken: deviceToken
      });
    } catch (error) {
      console.error("Verify Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  return router;
}

module.exports = { createLegacyPairingRouter: createLegacyPairingRouter };

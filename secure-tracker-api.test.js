"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { createSecureTrackerRouter } = require("./secure-tracker-api");

function makePrisma() {
  const devices = new Map();
  const pairings = new Map();
  const locations = new Map();
  const prisma = {
    device: {
      create: async function (args) {
        devices.set(args.data.deviceId, Object.assign({}, args.data));
        return devices.get(args.data.deviceId);
      },
      findUnique: async function (args) {
        return devices.get(args.where.deviceId) || null;
      },
      findMany: async function (args) {
        return Array.from(devices.values()).filter(function (device) {
          return device.pairCode === args.where.pairCode;
        });
      },
      update: async function (args) {
        const device = devices.get(args.where.deviceId);
        if (!device) throw new Error("device not found");
        Object.assign(device, args.data);
        return device;
      }
    },
    securePairing: {
      create: async function (args) {
        pairings.set(args.data.pairCodeHash, Object.assign({ pairedAt: null }, args.data));
        return pairings.get(args.data.pairCodeHash);
      },
      findUnique: async function (args) {
        return pairings.get(args.where.pairCodeHash) || null;
      },
      updateMany: async function (args) {
        const pairing = pairings.get(args.where.pairCodeHash);
        if (!pairing || pairing.pairedAt !== args.where.pairedAt ||
            pairing.expiresAt <= args.where.expiresAt.gt) return { count: 0 };
        Object.assign(pairing, args.data);
        return { count: 1 };
      }
    },
    location: {
      findUnique: async function (args) {
        return locations.get(args.where.deviceId) || null;
      },
      upsert: async function (args) {
        const value = Object.assign(
          {},
          locations.get(args.where.deviceId) || args.create,
          args.update
        );
        locations.set(args.where.deviceId, value);
        return value;
      }
    }
  };
  prisma.$transaction = async function (callback) { return callback(prisma); };
  return { prisma: prisma, devices: devices, pairings: pairings, locations: locations };
}

async function startTestServer(t, prisma) {
  const app = express();
  app.use(express.json());
  app.use(createSecureTrackerRouter({
    prisma: prisma,
    now: function () { return 1000000; },
    smoothLocation: function (_deviceId, location) { return location; }
  }));
  const server = await new Promise(function (resolve) {
    const listener = app.listen(0, "127.0.0.1", function () { resolve(listener); });
  });
  t.after(function () {
    server.closeAllConnections();
    return new Promise(function (resolve) { server.close(resolve); });
  });
  return "http://127.0.0.1:" + server.address().port;
}

async function request(base, path, options) {
  const response = await fetch(base + path, {
    method: options.method || "GET",
    headers: Object.assign(
      { "Content-Type": "application/json" },
      options.token ? { Authorization: "Bearer " + options.token } : {}
    ),
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: response.status, body: await response.json() };
}

test("secure pairing issues per-device credentials and authorizes only their holder", async function (t) {
  const fixture = makePrisma();
  const base = await startTestServer(t, fixture.prisma);
  const generated = await request(base, "/api/v2/pair/generate", {
    method: "POST",
    body: { deviceType: "laptop" }
  });
  assert.equal(generated.status, 201);
  assert.match(generated.body.pairCode, /^[A-Za-z0-9_-]{43}$/);
  assert.match(generated.body.deviceToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(fixture.devices.get(generated.body.deviceId).authTokenHash, generated.body.deviceToken);
  assert.equal(fixture.pairings.values().next().value.pairCodeHash.length, 64);

  const paired = await request(base, "/api/v2/pair/verify", {
    method: "POST",
    body: { pairCode: generated.body.pairCode, deviceType: "phone" }
  });
  assert.equal(paired.status, 201);
  assert.match(paired.body.deviceToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(paired.body.deviceToken, generated.body.deviceToken);

  const reused = await request(base, "/api/v2/pair/verify", {
    method: "POST",
    body: { pairCode: generated.body.pairCode, deviceType: "phone" }
  });
  assert.equal(reused.status, 404);

  const unauthenticated = await request(base, "/api/v2/pair-info?deviceId=" +
    encodeURIComponent(generated.body.deviceId), {});
  assert.equal(unauthenticated.status, 401);
  const info = await request(base, "/api/v2/pair-info?deviceId=" +
    encodeURIComponent(generated.body.deviceId), { token: generated.body.deviceToken });
  assert.equal(info.status, 200);
  assert.equal(info.body.devices.length, 2);
  assert.equal(JSON.stringify(info.body).includes("authTokenHash"), false);
});

test("location updates require the matching device token and validate coordinates", async function (t) {
  const fixture = makePrisma();
  const base = await startTestServer(t, fixture.prisma);
  const generated = await request(base, "/api/v2/pair/generate", {
    method: "POST",
    body: { deviceType: "phone" }
  });
  const payload = {
    deviceId: generated.body.deviceId,
    location: { lat: 6.5, lng: 3.4, source: "user-approved" }
  };
  const missing = await request(base, "/api/v2/heartbeat", {
    method: "POST",
    body: payload
  });
  assert.equal(missing.status, 401);
  const mismatched = await request(base, "/api/v2/heartbeat", {
    method: "POST",
    token: generated.body.deviceToken,
    body: { deviceId: "another-device", location: payload.location }
  });
  assert.equal(mismatched.status, 401);
  const invalid = await request(base, "/api/v2/heartbeat", {
    method: "POST",
    token: generated.body.deviceToken,
    body: { deviceId: generated.body.deviceId, location: { lat: 91, lng: 3 } }
  });
  assert.equal(invalid.status, 400);
  const accepted = await request(base, "/api/v2/heartbeat", {
    method: "POST",
    token: generated.body.deviceToken,
    body: payload
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.locationAccepted, true);
  assert.equal(fixture.locations.get(generated.body.deviceId).lat, 6.5);
});

test("revocation invalidates the target credential and lost mode changes state only", async function (t) {
  const fixture = makePrisma();
  const base = await startTestServer(t, fixture.prisma);
  const generated = await request(base, "/api/v2/pair/generate", {
    method: "POST",
    body: { deviceType: "laptop" }
  });
  const paired = await request(base, "/api/v2/pair/verify", {
    method: "POST",
    body: { pairCode: generated.body.pairCode, deviceType: "phone" }
  });
  const lost = await request(base, "/api/v2/lost-mode", {
    method: "POST",
    token: generated.body.deviceToken,
    body: { deviceId: generated.body.deviceId, active: true }
  });
  assert.equal(lost.status, 200);
  assert.equal(fixture.devices.get(generated.body.deviceId).isLost, true);

  const revoked = await request(base, "/api/v2/revoke-device", {
    method: "POST",
    token: generated.body.deviceToken,
    body: { deviceId: generated.body.deviceId, targetDeviceId: paired.body.deviceId }
  });
  assert.equal(revoked.status, 200);
  const afterRevoke = await request(base, "/api/v2/heartbeat", {
    method: "POST",
    token: paired.body.deviceToken,
    body: { deviceId: paired.body.deviceId }
  });
  assert.equal(afterRevoke.status, 401);
});

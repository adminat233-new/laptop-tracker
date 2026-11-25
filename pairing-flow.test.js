"use strict";

// End-to-end pairing test without a live database. PrismaClient is replaced in
// the require cache before cloud-server.js is loaded, so the real Express app,
// WebSocket gate and location fan-out are exercised.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const WebSocket = require("ws");

function makeFixture() {
  const codes = new Map();
  const devices = new Map();
  const locations = new Map();
  const merge = (target, patch) => Object.assign({}, target || {}, patch || {});
  const prisma = {
    code: {
      upsert: async (args) => {
        const row = merge(codes.get(args.where.pairCode), args.create);
        const value = merge(row, args.update);
        codes.set(value.pairCode, value);
        return value;
      },
      findUnique: async (args) => codes.get(args.where.pairCode) || null
    },
    device: {
      upsert: async (args) => {
        const row = merge(devices.get(args.where.deviceId), args.create);
        const value = merge(row, args.update);
        devices.set(value.deviceId, value);
        return value;
      },
      findUnique: async (args) => devices.get(args.where.deviceId) || null,
      findMany: async (args) => Array.from(devices.values()).filter(d => d.pairCode === args.where.pairCode),
      update: async (args) => {
        const value = merge(devices.get(args.where.deviceId), args.data);
        devices.set(value.deviceId, value);
        return value;
      }
    },
    location: {
      upsert: async (args) => {
        const value = merge(locations.get(args.where.deviceId) || args.create, args.update);
        locations.set(value.deviceId, value);
        return value;
      },
      findUnique: async (args) => locations.get(args.where.deviceId) || null
    },
    $queryRawUnsafe: async () => [{ ok: 1 }]
  };
  return { prisma, codes, devices, locations };
}

const fixture = makeFixture();
const prismaPath = require.resolve("@prisma/client");
require.cache[prismaPath] = {
  id: prismaPath,
  filename: prismaPath,
  loaded: true,
  exports: { PrismaClient: function () { return fixture.prisma; } }
};
process.env.PORT = "0";
const { server } = require("./cloud-server");
const { hashSecret } = require("./secure-tracker-api");

function waitForListening() {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve) => server.once("listening", resolve));
}

function openSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket("ws://127.0.0.1:" + port);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for WebSocket message: " + (label || "unknown")));
    }, timeoutMs || 4000);
    function onMessage(data) {
      const msg = JSON.parse(data.toString());
      if (!predicate(msg)) return;
      cleanup();
      resolve(msg);
    }
    function cleanup() {
      clearTimeout(timer);
      socket.off("message", onMessage);
    }
    socket.on("message", onMessage);
  });
}

function waitForClose(socket) {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code: code, reason: reason.toString() }));
  });
}

async function post(base, url, body) {
  const response = await fetch(base + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  return { status: response.status, body: await response.json() };
}

test("legacy pairing issues tokens and authenticated sockets receive location fan-out", async function (t) {
  await waitForListening();
  const base = "http://127.0.0.1:" + server.address().port;
  const sockets = [];
  t.after(async function () {
    for (const socket of sockets) {
      try { socket.close(); } catch (error) {}
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const health = await fetch(base + "/api/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).database, "ok");

  const generated = await post(base, "/api/generate", { platform: "test" });
  assert.equal(generated.status, 200);
  assert.equal(generated.body.success, true);
  assert.match(generated.body.pairCode, /^[0-9A-F]{8}$/);
  assert.match(generated.body.deviceToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    fixture.devices.get(generated.body.deviceId).authTokenHash,
    hashSecret(generated.body.deviceToken)
  );
  assert.notEqual(
    fixture.devices.get(generated.body.deviceId).authTokenHash,
    generated.body.deviceToken
  );

  const verified = await post(base, "/api/verify", { pairCode: generated.body.pairCode.toLowerCase() });
  assert.equal(verified.body.success, true);
  assert.equal(verified.body.pairCode, generated.body.pairCode);
  assert.equal(verified.body.laptopId, generated.body.deviceId);
  assert.equal(verified.body.phoneId, generated.body.pairCode + "-phone");
  assert.match(verified.body.deviceToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(verified.body.deviceToken, generated.body.deviceToken);
  assert.equal(
    fixture.devices.get(verified.body.phoneId).authTokenHash,
    hashSecret(verified.body.deviceToken)
  );

  const invalid = await post(base, "/api/verify", { pairCode: "short" });
  assert.equal(invalid.body.success, false);

  const setup = await post(base, "/api/agent-setup/" + generated.body.pairCode, {
    deviceToken: generated.body.deviceToken
  });
  assert.equal(setup.body.success, true);
  assert.equal(setup.body.requiresToken, false);
  assert.match(setup.body.npxCmd, new RegExp("--token=" + generated.body.deviceToken));
  assert.match(setup.body.autoStartCmd, /--token=\$t/);

  const setupWithoutToken = await fetch(base + "/api/agent-setup/" + generated.body.pairCode);
  assert.equal((await setupWithoutToken.json()).requiresToken, true);
  const badSetup = await post(base, "/api/agent-setup/" + generated.body.pairCode, {
    deviceToken: "wrong-token"
  });
  assert.equal(badSetup.status, 401);

  const port = server.address().port;

  const browser = await openSocket(port);
  sockets.push(browser);
  const browserRegistered = nextMessage(browser, msg => msg.type === "registered", 4000, "browser registered");
  browser.send(JSON.stringify({
    type: "register",
    deviceId: verified.body.phoneId,
    deviceType: "browser",
    deviceToken: verified.body.deviceToken
  }));
  assert.equal((await browserRegistered).deviceId, verified.body.phoneId);

  const phone = await openSocket(port);
  sockets.push(phone);
  const phoneRegistered = nextMessage(phone, msg => msg.type === "registered", 4000, "phone registered");
  phone.send(JSON.stringify({
    type: "register",
    deviceId: verified.body.phoneId,
    deviceType: "phone",
    deviceToken: verified.body.deviceToken
  }));
  assert.equal((await phoneRegistered).deviceId, verified.body.phoneId);

  const agent = await openSocket(port);
  sockets.push(agent);
  const agentRegistered = nextMessage(agent, msg => msg.type === "registered", 4000, "agent registered");
  agent.send(JSON.stringify({
    type: "register",
    deviceId: generated.body.deviceId,
    deviceType: "agent",
    deviceToken: generated.body.deviceToken
  }));
  assert.equal((await agentRegistered).deviceId, generated.body.deviceId);

  const unauthenticated = await openSocket(port);
  sockets.push(unauthenticated);
  const rejected = waitForClose(unauthenticated);
  unauthenticated.send(JSON.stringify({
    type: "register",
    deviceId: generated.body.deviceId,
    deviceType: "agent"
  }));
  assert.equal((await rejected).code, 1008);

  const wrongRole = await openSocket(port);
  sockets.push(wrongRole);
  const wrongRoleClosed = waitForClose(wrongRole);
  wrongRole.send(JSON.stringify({
    type: "register",
    deviceId: verified.body.phoneId,
    deviceType: "agent",
    deviceToken: verified.body.deviceToken
  }));
  assert.equal((await wrongRoleClosed).code, 1008);

  // The phone-role socket replaces the browser socket for the same deviceId,
  // so it is the authenticated recipient here.
  const locationReceived = nextMessage(phone, msg => msg.type === "location", 4000, "location fan-out");
  agent.send(JSON.stringify({
    type: "location",
    location: { lat: 51.5, lng: -0.12, accuracy: 25, source: "test-gps" }
  }));
  const location = await locationReceived;
  assert.equal(location.fromDeviceId, generated.body.deviceId);
  assert.equal(location.location.lat, 51.5);
});

test("React Native pairing consumes the real verify response shape", function () {
  const root = __dirname;
  const pairScreen = fs.readFileSync(path.join(root, "LaptopTracker", "src", "screens", "PairScreen.tsx"), "utf8");
  const app = fs.readFileSync(path.join(root, "LaptopTracker", "App.tsx"), "utf8");
  const service = fs.readFileSync(path.join(root, "LaptopTracker", "src", "services", "ServerService.ts"), "utf8");

  assert.match(pairScreen, /data\.success && data\.phoneId && data\.laptopId && data\.deviceToken/);
  assert.doesNotMatch(pairScreen, /data\.verified|data\.phoneDeviceId|data\.laptopDeviceId/);
  assert.match(app, /AsyncStorage\.setItem\('deviceToken', newToken\)/);
  assert.match(service, /deviceToken: this\.deviceToken/);
});

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { hashSecret } = require("./secure-tracker-api");
const {
  authenticateSocketDevice,
  sendAuthenticatedPair,
  rejectRemoteControlRoutes
} = require("./cloud-security");

test("WebSocket identity requires a matching per-device token and authorized role", async function () {
  const device = {
    deviceId: "laptop-1",
    pairCode: "pair-1",
    deviceType: "laptop",
    authTokenHash: hashSecret("device-token")
  };
  const prisma = {
    device: {
      findUnique: async function (args) {
        return args.where.deviceId === device.deviceId ? device : null;
      }
    }
  };

  assert.deepEqual(
    await authenticateSocketDevice(prisma, device.deviceId, "device-token", "agent"),
    { deviceId: "laptop-1", pairCode: "pair-1", role: "agent" }
  );
  assert.equal(await authenticateSocketDevice(prisma, device.deviceId, "wrong", "agent"), null);
  assert.equal(await authenticateSocketDevice(prisma, device.deviceId, "device-token", "admin"), null);
  assert.equal(await authenticateSocketDevice(prisma, "missing", "device-token", "browser"), null);

  device.deviceType = "phone";
  assert.equal(await authenticateSocketDevice(prisma, device.deviceId, "device-token", "agent"), null);
  assert.deepEqual(
    await authenticateSocketDevice(prisma, device.deviceId, "device-token", "browser"),
    { deviceId: "laptop-1", pairCode: "pair-1", role: "browser" }
  );
});

test("WebSocket location fan-out is limited to authenticated sockets in the same pair", function () {
  const identities = new WeakMap();
  const received = [];
  function socket(name) {
    return {
      name: name,
      readyState: 1,
      send: function (payload) { received.push([name, JSON.parse(payload)]); }
    };
  }
  const samePair = socket("same-pair");
  const otherPair = socket("other-pair");
  const unauthenticated = socket("unauthenticated");
  identities.set(samePair, { deviceId: "phone-1", pairCode: "pair-1", role: "browser" });
  identities.set(otherPair, { deviceId: "phone-2", pairCode: "pair-2", role: "browser" });

  assert.equal(sendAuthenticatedPair(
    new Set([samePair, otherPair, unauthenticated]),
    identities,
    "pair-1",
    { type: "location" },
    "laptop-1"
  ), true);
  assert.deepEqual(received.map(function (entry) { return entry[0]; }), ["same-pair"]);
});

test("legacy command and shell endpoints fail closed without side effects", async function (t) {
  const app = express();
  app.use(express.json());
  rejectRemoteControlRoutes(app);
  const server = await new Promise(function (resolve) {
    const listener = app.listen(0, "127.0.0.1", function () { resolve(listener); });
  });
  t.after(function () {
    server.closeAllConnections();
    return new Promise(function (resolve) { server.close(resolve); });
  });
  const base = "http://127.0.0.1:" + server.address().port;

  for (const [path, body, expectedError] of [
    ["/api/command", { deviceId: "laptop-1", commandType: "shell-exec", params: { command: "whoami" } }, "remote_commands_disabled"],
    ["/api/result", { commandId: "any", result: "forged" }, "remote_commands_disabled"],
    ["/api/remote-shell", { deviceId: "laptop-1", command: "whoami" }, "remote_shell_disabled"]
  ]) {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 410);
    assert.equal((await response.json()).error, expectedError);
  }
});

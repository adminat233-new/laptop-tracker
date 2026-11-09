"use strict";

const { tokenMatches } = require("./secure-tracker-api");

async function authenticateSocketDevice(prisma, deviceId, token, role) {
  if (typeof deviceId !== "string" || !deviceId ||
      typeof token !== "string" || !token ||
      !["agent", "browser"].includes(role)) return null;
  const device = await prisma.device.findUnique({ where: { deviceId: deviceId } });
  if (!device || !tokenMatches(token, device.authTokenHash) ||
      (role === "agent" && device.deviceType !== "laptop")) return null;
  return {
    deviceId: device.deviceId,
    pairCode: device.pairCode,
    role: role
  };
}

function sendAuthenticatedPair(sockets, identities, pairCode, data, excludedDeviceId) {
  const payload = JSON.stringify(data);
  let sent = false;
  sockets.forEach(function (socket) {
    const identity = identities.get(socket);
    if (!identity || identity.pairCode !== pairCode ||
        (excludedDeviceId && identity.deviceId === excludedDeviceId) ||
        socket.readyState !== 1) return;
    try {
      socket.send(payload);
      sent = true;
    } catch (error) {
      console.error("Authenticated WebSocket delivery failed:", error.message);
    }
  });
  return sent;
}

function rejectRemoteControlRoutes(app) {
  app.post("/api/command", function (_req, res) {
    return res.status(410).json({
      success: false,
      error: "remote_commands_disabled",
      message: "Remote commands are disabled until authenticated, per-action approval is implemented."
    });
  });
  app.post("/api/result", function (_req, res) {
    return res.status(410).json({ success: false, error: "remote_commands_disabled" });
  });
  app.post("/api/remote-shell", function (_req, res) {
    return res.status(410).json({
      success: false,
      error: "remote_shell_disabled",
      message: "Remote shell is not supported."
    });
  });
}

module.exports = {
  authenticateSocketDevice: authenticateSocketDevice,
  sendAuthenticatedPair: sendAuthenticatedPair,
  rejectRemoteControlRoutes: rejectRemoteControlRoutes
};

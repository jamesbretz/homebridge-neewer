'use strict';

const dgram = require('dgram');
const os = require('os');

const PORT = 5052;
const HEARTBEAT_INTERVAL = 1000; // 1 second is plenty
const DISCOVERY_TIMEOUT = 10000; // 10 seconds to discover lights

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address !== '127.0.0.1') {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function buildPacket(...bytes) {
  const payload = [0x80, 0x05, ...bytes];
  const checksum = payload.reduce((a, b) => (a + b) & 0xff, 0);
  return Buffer.from([...payload, checksum]);
}

function registrationPacket(controllerIP) {
  const ipBuf = Buffer.from(controllerIP, 'ascii');
  return Buffer.from([0x80, 0x02, 0x10, 0x00, 0x00, controllerIP.length, ...ipBuf, 0x2e]);
}

function powerPacket(on) {
  return buildPacket(0x02, 0x01, on ? 0x01 : 0x00);
}

function rgbcwPacket(brightness, r, g, b, c, w) {
  return buildPacket(0x07, 0x07,
    Math.round(brightness) & 0xff,
    Math.round(r) & 0xff,
    Math.round(g) & 0xff,
    Math.round(b) & 0xff,
    Math.round(c) & 0xff,
    Math.round(w) & 0xff,
  );
}

// CCT mode brightness: 80 05 04 02 [brightness 0-100] 32 32 [checksum]
function cctBrightnessPacket(brightness) {
  return buildPacket(0x04, 0x02, Math.round(brightness) & 0xff, 0x32, 0x32);
}

// CCT mode color temperature: 80 05 05 03 [cct_raw] [gm_hi] [gm_lo] [checksum]
// HomeKit mireds 140-500 → CCT raw range (warm=high, cool=low based on captures)
// Captured: cct=0xd2=210 at warmer, cct=0x1a=26 at cooler — maps to ~32-220 range
function cctTemperaturePacket(mireds) {
  // Map 140 mireds (cool/7143K) → low CCT raw, 500 mireds (warm/2000K) → high CCT raw
  const t = (mireds - 140) / (500 - 140);
  const cctRaw = Math.round(20 + t * 200) & 0xff; // ~20 (cool) to ~220 (warm)
  return buildPacket(0x05, 0x03, cctRaw, 0x00, 0x00);
}

function heartbeatPacket() {
  return Buffer.from([0x80, 0x04, 0x84]);
}

/**
 * Parse a light's broadcast/announce packet (80 01 ...)
 * Returns { ip, model, mac } or null
 */
function parseBroadcast(msg) {
  if (msg.length < 20 || msg[0] !== 0x80 || msg[1] !== 0x01) return null;
  try {
    let offset = 4; // skip 80 01 len_hi len_lo
    const fields = {};
    while (offset < msg.length - 1) {
      const fieldLen = msg[offset];
      const fieldData = msg.slice(offset + 1, offset + 1 + fieldLen);
      const str = fieldData.toString('ascii');
      if (str.match(/^\d+\.\d+$/)) fields.firmware = str;
      else if (str.match(/^GL/)) fields.model = str;
      else if (str.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) fields.ip = str;
      else if (fieldLen === 6) fields.mac = Array.from(fieldData).map(b => b.toString(16).padStart(2, '0')).join(':');
      offset += 1 + fieldLen;
    }
    if (fields.ip && fields.model) return fields;
  } catch (e) {}
  return null;
}

// Shared socket singleton — one socket for all lights on port 5052
let sharedSocket = null;
let sharedSocketReady = false;
let sharedSocketQueue = [];
const messageHandlers = new Map(); // ip -> callback

function getSharedSocket(log, callback) {
  if (sharedSocketReady) return callback(sharedSocket);
  sharedSocketQueue.push(callback);
  if (sharedSocket) return;

  sharedSocket = dgram.createSocket('udp4');
  sharedSocket.on('error', (err) => {
    log.warn(`[Neewer] Shared socket error: ${err.message}`);
  });
  sharedSocket.on('message', (msg, rinfo) => {
    // Dispatch to per-IP handlers
    const handler = messageHandlers.get(rinfo.address);
    if (handler) handler(msg, rinfo);
    // Also dispatch broadcast to all handlers (for discovery)
    if (rinfo.address !== '255.255.255.255') {
      const broadcastHandler = messageHandlers.get('*');
      if (broadcastHandler) broadcastHandler(msg, rinfo);
    }
  });
  sharedSocket.bind(PORT, () => {
    sharedSocket.setBroadcast(true);
    sharedSocketReady = true;
    log.info(`[Neewer] Shared UDP socket bound on port ${PORT}`);
    sharedSocketQueue.forEach(cb => cb(sharedSocket));
    sharedSocketQueue = [];
  });
}

/**
 * Discover Neewer lights on the network by listening for their broadcast packets.
 * Returns a promise that resolves to an array of { ip, model, mac, name } objects.
 */
function discoverLights(log, timeout) {
  return new Promise((resolve) => {
    const found = new Map();
    const localIP = getLocalIP();

    getSharedSocket(log, (socket) => {
      // Register broadcast handler
      messageHandlers.set('*', (msg, rinfo) => {
        const info = parseBroadcast(msg);
        if (info && !found.has(info.ip)) {
          log.info(`[Neewer] Discovered light: ${info.model} at ${info.ip} (${info.mac})`);
          found.set(info.ip, info);
          // Send registration immediately when we discover a light
          const regPkt = registrationPacket(localIP);
          socket.send(regPkt, 0, regPkt.length, PORT, info.ip);
          setTimeout(() => socket.send(regPkt, 0, regPkt.length, PORT, info.ip), 100);
          setTimeout(() => socket.send(regPkt, 0, regPkt.length, PORT, info.ip), 200);
        }
      });

      setTimeout(() => {
        messageHandlers.delete('*');
        resolve(Array.from(found.values()));
      }, timeout || DISCOVERY_TIMEOUT);
    });
  });
}

class NeewerUDP {
  constructor(ip, log, controllerIP) {
    this.ip = ip;
    this.log = log;
    this.controllerIP = controllerIP || getLocalIP();
    this._heartbeatTimer = null;
    this.onPowerState = null; // callback(boolean) for power state updates
  }

  connect() {
    getSharedSocket(this.log, (socket) => {
      this.socket = socket;
      this._lastReregister = 0;

      // Listen for messages from this light
      messageHandlers.set(this.ip, (msg) => this._handleMessage(msg));

      this.log.info(`[UDP ${this.ip}] Ready, controller IP: ${this.controllerIP}`);
      this._sendRegistration(true); // true = include status request on first connect
      this._startHeartbeat();
    });
  }

  _handleMessage(msg) {
    // Status response: 80 07 02 01 [power] [checksum]
    if (msg.length >= 5 && msg[0] === 0x80 && msg[1] === 0x07) {
      if (msg[2] === 0x02 && msg[3] === 0x01) {
        const power = msg[4] === 0x01;
        this.log.debug(`[UDP ${this.ip}] Status: power=${power}`);
        if (this.onPowerState) this.onPowerState(power);
      }
    }
    // Light broadcast (80 01) - re-register when light announces itself, throttled to 5s
    if (msg[0] === 0x80 && msg[1] === 0x01) {
      const now = Date.now();
      if (now - this._lastReregister > 5000) {
        this._lastReregister = now;
        this.log.debug(`[UDP ${this.ip}] Light reannounced, re-registering`);
        this._sendRegistration(false);
      }
    }
  }

  _sendRegistration(withStatusRequest = false) {
    const pkt = registrationPacket(this.controllerIP);
    this._send(pkt);
    setTimeout(() => this._send(pkt), 100);
    setTimeout(() => this._send(pkt), 200);
    // Only request status on initial connect, not every re-registration
    if (withStatusRequest) {
      const statusReq = Buffer.from([0x80, 0x06, 0x01, 0x01, 0x88]);
      setTimeout(() => this._send(statusReq), 350);
    }
  }

  disconnect() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    messageHandlers.delete(this.ip);
  }

  _send(packet) {
    if (!this.socket) return;
    this.socket.send(packet, 0, packet.length, PORT, this.ip, (err) => {
      if (err) this.log.warn(`[UDP ${this.ip}] Send error: ${err.message}`);
    });
  }

  _startHeartbeat() {
    const regPkt = registrationPacket(this.controllerIP);
    const hbPkt = heartbeatPacket();
    let tick = 0;
    this._heartbeatTimer = setInterval(() => {
      // Send registration every 5s, heartbeat every 1s
      this._send(tick % 5 === 0 ? regPkt : hbPkt);
      tick++;
    }, HEARTBEAT_INTERVAL);
  }

  setPower(on) {
    this.log.info(`[Neewer] ${this.ip}: Power ${on ? 'ON' : 'OFF'}`);
    const pkt = powerPacket(on);
    this._send(pkt);
    setTimeout(() => this._send(pkt), 100);
    setTimeout(() => this._send(pkt), 300);
    setTimeout(() => this._send(pkt), 800);
  }

  setRGBCW(brightness, r, g, b, c, w) {
    this.log.debug(`[UDP ${this.ip}] RGBCW: brightness=${brightness} R=${r} G=${g} B=${b} C=${c} W=${w}`);
    const pkt = rgbcwPacket(brightness, r, g, b, c, w);
    this._send(pkt);
    setTimeout(() => this._send(pkt), 100);
    setTimeout(() => this._send(pkt), 200);
  }

  setCCT(brightness, mireds) {
    this.log.debug(`[UDP ${this.ip}] CCT: brightness=${brightness} mireds=${mireds}`);
    const bPkt = cctBrightnessPacket(brightness);
    const tPkt = cctTemperaturePacket(mireds);
    this._send(bPkt);
    this._send(tPkt);
    setTimeout(() => { this._send(bPkt); this._send(tPkt); }, 100);
    setTimeout(() => { this._send(bPkt); this._send(tPkt); }, 200);
  }
}

module.exports = { NeewerUDP, discoverLights };

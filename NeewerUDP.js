'use strict';

const dgram = require('dgram');
const os = require('os');

const PORT = 5052;
const HEARTBEAT_INTERVAL = 250;
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

      // Listen for messages from this light
      messageHandlers.set(this.ip, (msg) => this._handleMessage(msg));

      this.log.info(`[UDP ${this.ip}] Ready, controller IP: ${this.controllerIP}`);
      this._sendRegistration();
      this._startHeartbeat();
    });
  }

  _handleMessage(msg) {
    // Status response: 80 07 02 01 [power] [checksum]
    if (msg.length >= 5 && msg[0] === 0x80 && msg[1] === 0x07) {
      if (msg[2] === 0x02 && msg[3] === 0x01) {
        const power = msg[4] === 0x01;
        this.log.info(`[UDP ${this.ip}] Status: power=${power}`);
        if (this.onPowerState) this.onPowerState(power);
      }
    }
    // Light broadcast (80 01) - re-register when light announces itself
    if (msg[0] === 0x80 && msg[1] === 0x01) {
      this.log.debug(`[UDP ${this.ip}] Light broadcast received, re-registering`);
      this._sendRegistration();
    }
  }

  _sendRegistration() {
    const pkt = registrationPacket(this.controllerIP);
    const statusReq = Buffer.from([0x80, 0x06, 0x01, 0x01, 0x88]);
    this._send(pkt);
    setTimeout(() => this._send(pkt), 100);
    setTimeout(() => this._send(pkt), 200);
    // Send status request after registration to complete handshake
    setTimeout(() => this._send(statusReq), 350);
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
      this._send(tick % 4 === 0 ? regPkt : hbPkt);
      tick++;
    }, HEARTBEAT_INTERVAL);
  }

  setPower(on) {
    this.log.info(`[Neewer] ${this.ip}: Power ${on ? 'ON' : 'OFF'}`);
    const pkt = powerPacket(on);
    this._send(pkt);
    setTimeout(() => this._send(pkt), 100);
    setTimeout(() => this._send(pkt), 200);
  }

  setRGBCW(brightness, r, g, b, c, w) {
    this.log.debug(`[UDP ${this.ip}] RGBCW: brightness=${brightness} R=${r} G=${g} B=${b} C=${c} W=${w}`);
    const pkt = rgbcwPacket(brightness, r, g, b, c, w);
    this._send(pkt);
    setTimeout(() => this._send(pkt), 100);
    setTimeout(() => this._send(pkt), 200);
  }
}

module.exports = { NeewerUDP, discoverLights };

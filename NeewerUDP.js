'use strict';

const dgram = require('dgram');
const os = require('os');

const PORT = 5052;
const DISCOVERY_TIMEOUT = 10000;

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

// The app sends 80 04 84 as a heartbeat ACK in response to the light's 80 03 83
const HB_ACK = Buffer.from([0x80, 0x04, 0x84]);
const STATUS_REQ = Buffer.from([0x80, 0x06, 0x01, 0x01, 0x88]);

function parseBroadcast(msg) {
  if (msg.length < 20 || msg[0] !== 0x80 || msg[1] !== 0x01) return null;
  try {
    let offset = 4;
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

// Shared socket singleton
let sharedSocket = null;
let sharedSocketReady = false;
let sharedSocketQueue = [];
const messageHandlers = new Map();

function getSharedSocket(log, callback) {
  if (sharedSocketReady) return callback(sharedSocket);
  sharedSocketQueue.push(callback);
  if (sharedSocket) return;

  sharedSocket = dgram.createSocket('udp4');
  sharedSocket.on('error', (err) => {
    log.warn(`[Neewer] Shared socket error: ${err.message}`);
  });
  sharedSocket.on('message', (msg, rinfo) => {
    const handler = messageHandlers.get(rinfo.address);
    if (handler) handler(msg, rinfo);
    const broadcastHandler = messageHandlers.get('*');
    if (broadcastHandler) broadcastHandler(msg, rinfo);
  });
  sharedSocket.bind(PORT, () => {
    sharedSocket.setBroadcast(true);
    sharedSocketReady = true;
    log.info(`[Neewer] Shared UDP socket bound on port ${PORT}`);
    sharedSocketQueue.forEach(cb => cb(sharedSocket));
    sharedSocketQueue = [];
  });
}

function discoverLights(log, timeout) {
  return new Promise((resolve) => {
    const found = new Map();
    const localIP = getLocalIP();
    getSharedSocket(log, (socket) => {
      messageHandlers.set('*', (msg, rinfo) => {
        const info = parseBroadcast(msg);
        if (info && !found.has(info.ip)) {
          log.info(`[Neewer] Discovered light: ${info.model} at ${info.ip} (${info.mac})`);
          found.set(info.ip, info);
          // Register 4x at ~50ms like the Mac app does
          const reg = registrationPacket(localIP);
          socket.send(reg, 0, reg.length, PORT, info.ip);
          setTimeout(() => socket.send(reg, 0, reg.length, PORT, info.ip), 50);
          setTimeout(() => socket.send(reg, 0, reg.length, PORT, info.ip), 100);
          setTimeout(() => socket.send(reg, 0, reg.length, PORT, info.ip), 150);
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
    this._lastReregister = 0;
    this.onPowerState = null;
  }

  connect() {
    getSharedSocket(this.log, (socket) => {
      this.socket = socket;
      messageHandlers.set(this.ip, (msg) => this._handleMessage(msg));
      this.log.info(`[UDP ${this.ip}] Ready`);

      // Register 4x at ~50ms intervals, exactly like the Mac app
      const reg = registrationPacket(this.controllerIP);
      this._send(reg);
      setTimeout(() => this._send(reg), 50);
      setTimeout(() => this._send(reg), 100);
      setTimeout(() => this._send(reg), 150);
      // Request status after registration
      setTimeout(() => this._send(STATUS_REQ), 300);

      // Re-register every 30s to reclaim control if another app took over
      this._regTimer = setInterval(() => {
        this._send(registrationPacket(this.controllerIP));
      }, 30000);
    });
  }

  _handleMessage(msg) {
    // Light heartbeat: 80 03 — respond with ACK, throttled to once per second
    if (msg.length >= 3 && msg[0] === 0x80 && msg[1] === 0x03) {
      const now = Date.now();
      if (!this._lastAck || now - this._lastAck > 1000) {
        this._lastAck = now;
        this._send(HB_ACK);
      }
    }

    // Status response: 80 07 02 01 [power] [checksum]
    if (msg.length >= 5 && msg[0] === 0x80 && msg[1] === 0x07) {
      if (msg[2] === 0x02 && msg[3] === 0x01) {
        const power = msg[4] === 0x01;
        this.log.debug(`[UDP ${this.ip}] Status: power=${power}`);
        if (this.onPowerState) this.onPowerState(power);
      }
    }

    // Light reannounced (80 01) — re-register 4x, throttled to once per 10s
    if (msg[0] === 0x80 && msg[1] === 0x01) {
      const now = Date.now();
      if (now - this._lastReregister > 10000) {
        this._lastReregister = now;
        this.log.debug(`[UDP ${this.ip}] Light reannounced, re-registering`);
        const reg = registrationPacket(this.controllerIP);
        this._send(reg);
        setTimeout(() => this._send(reg), 50);
        setTimeout(() => this._send(reg), 100);
        setTimeout(() => this._send(reg), 150);
      }
    }
  }

  disconnect() {
    if (this._regTimer) { clearInterval(this._regTimer); this._regTimer = null; }
    messageHandlers.delete(this.ip);
  }

  _send(packet) {
    if (!this.socket) return;
    this.socket.send(packet, 0, packet.length, PORT, this.ip, (err) => {
      if (err) this.log.warn(`[UDP ${this.ip}] Send error: ${err.message}`);
    });
  }

  // Stagger bursts so two lights don't collide on the shared socket
  _sendBurst(packets, spacing = 50) {
    packets.forEach((pkt, i) => {
      setTimeout(() => this._send(pkt), i * spacing);
    });
  }

  setPower(on) {
    this.log.info(`[Neewer] ${this.ip}: Power ${on ? 'ON' : 'OFF'}`);
    const pkt = powerPacket(on);
    this._sendBurst([pkt, pkt, pkt]);
    setTimeout(() => this._sendBurst([pkt, pkt]), 500);
  }

  setRGBCW(brightness, r, g, b, c, w) {
    this.log.debug(`[UDP ${this.ip}] RGBCW: brightness=${brightness} R=${r} G=${g} B=${b} C=${c} W=${w}`);
    const pkt = rgbcwPacket(brightness, r, g, b, c, w);
    this._sendBurst([pkt, pkt, pkt]);
  }
}

module.exports = { NeewerUDP, discoverLights };

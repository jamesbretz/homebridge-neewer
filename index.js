'use strict';

const { NeewerUDP, discoverLights } = require('./NeewerUDP');

const PLUGIN_NAME = 'homebridge-neewer';
const PLATFORM_NAME = 'NeewerLights';

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, NeewerPlatform);
};

class NeewerPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];

    this.api.on('didFinishLaunching', () => {
      this._init();
      // Periodically re-scan to catch lights that dropped and reconnected
      setInterval(() => this._rediscover(), 5 * 60 * 1000);
    });
  }

  async _init() {
    const configuredLights = this.config.lights || [];
    const autoDiscover = this.config.autoDiscover !== false; // default true

    if (configuredLights.length > 0) {
      // Manual config mode
      this.log.info(`[Neewer] Initializing ${configuredLights.length} configured light(s)...`);
      this._syncAccessories(configuredLights);
    } else if (autoDiscover) {
      // Auto-discovery mode
      this.log.info('[Neewer] No lights configured — scanning network for Neewer lights (10s)...');
      const discovered = await discoverLights(this.log, 10000);
      if (discovered.length === 0) {
        this.log.warn('[Neewer] No lights found. Make sure lights are powered on and connected to WiFi.');
        return;
      }
      this.log.info(`[Neewer] Found ${discovered.length} light(s).`);
      const lights = discovered.map((d, i) => ({
        name: d.model + (discovered.length > 1 ? ` ${i + 1}` : ''),
        ip: d.ip,
        model: d.model,
        mac: d.mac,
      }));
      this._syncAccessories(lights);
    } else {
      this.log.warn('[Neewer] No lights configured and autoDiscover is disabled.');
    }
  }

  _syncAccessories(lights) {
    // Never remove cached accessories — a light may just be offline temporarily.
    // Only add/configure lights that are in the config or were discovered.
    // Add or reconfigure lights
    for (let i = 0; i < lights.length; i++) {
      const light = lights[i];
      if (!light.ip) {
        this.log.warn(`[Neewer] Light "${light.name}" has no IP address — skipping.`);
        continue;
      }
      const existing = this.accessories.find(a => a.context.ip === light.ip);
      if (existing) {
        existing._neewerAccessory = new NeewerAccessory(this.log, this.api, existing, light, i);
      } else {
        this._addAccessory(light, i);
      }
    }
  }

  _addAccessory(light, index = 0) {
    const uuid = this.api.hap.uuid.generate(`neewer-${light.ip}`);
    const acc = new this.api.platformAccessory(light.name || light.ip, uuid);
    acc.context.ip = light.ip;
    acc._neewerAccessory = new NeewerAccessory(this.log, this.api, acc, light, index);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
    this.accessories.push(acc);
    this.log.info(`[Neewer] Added light: ${light.name} (${light.ip})`);
  }

  async _rediscover() {
    this.log.info('[Neewer] Running periodic light scan...');
    const discovered = await discoverLights(this.log, 10000);
    for (const d of discovered) {
      const existing = this.accessories.find(a => a.context.ip === d.ip);
      if (!existing) {
        this.log.info(`[Neewer] Rediscovered new light: ${d.model} at ${d.ip}`);
        this._addAccessory({ name: d.model, ip: d.ip, model: d.model, mac: d.mac });
      } else {
        // Light is back — re-register it
        this.log.info(`[Neewer] Rediscovered existing light at ${d.ip}, re-registering`);
        const acc = existing;
        if (acc._neewerAccessory) {
          acc._neewerAccessory.udp.connect();
        }
      }
    }
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }
}

class NeewerAccessory {
  constructor(log, api, accessory, config, index = 0) {
    this.log = log;
    this.api = api;
    this.accessory = accessory;
    this.config = config;
    this.name = config.name || config.ip;
    this.cmdDelay = index * 150; // stagger lights by 150ms each

    this.udp = new NeewerUDP(config.ip, log);
    this.udp.connect();
    this._colorTimer = null; // debounce timer for color changes

    // Restore state from persistent context, or use defaults
    const ctx = accessory.context;
    this.state = {
      on:          ctx.on          !== undefined ? ctx.on          : false,
      brightness:  ctx.brightness  !== undefined ? ctx.brightness  : 100,
      hue:         ctx.hue         !== undefined ? ctx.hue         : 0,
      saturation:  ctx.saturation  !== undefined ? ctx.saturation  : 0,
      colorTemp:   ctx.colorTemp   !== undefined ? ctx.colorTemp   : 300,
    };

    // Listen for power state updates from the light
    this.udp.onPowerState = (power) => {
      if (this.state.on !== power) {
        this.state.on = power;
        this._saveState();
        const { Characteristic, Service } = this.api.hap;
        const bulb = this.accessory.getService(Service.Lightbulb);
        if (bulb) bulb.updateCharacteristic(Characteristic.On, power);
        this.log.info(`[Neewer] ${this.name}: State updated to ${power ? 'ON' : 'OFF'}`);
      }
    };

    this._setupServices();
  }

  _setupServices() {
    const { Service, Characteristic } = this.api.hap;

    // Accessory info
    const info = this.accessory.getService(Service.AccessoryInformation)
      || this.accessory.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, 'Neewer')
      .setCharacteristic(Characteristic.Model, this.config.model || 'GL25C')
      .setCharacteristic(Characteristic.SerialNumber, this.config.ip);

    // Lightbulb service
    const bulb = this.accessory.getService(Service.Lightbulb)
      || this.accessory.addService(Service.Lightbulb, this.name);

    // On/Off
    bulb.getCharacteristic(Characteristic.On)
      .onGet(() => this.state.on)
      .onSet((value) => {
        this.state.on = value;
        this._saveState();
        setTimeout(() => {
          this.udp.setPower(value);
          if (value) this._sendColor();
        }, this.cmdDelay);
        this.log.info(`[Neewer] ${this.name}: ${value ? 'ON' : 'OFF'}`);
      });

    // Brightness
    bulb.getCharacteristic(Characteristic.Brightness)
      .onGet(() => this.state.brightness)
      .onSet((value) => {
        this.state.brightness = value;
        this._saveState();
        setTimeout(() => this._sendColor(), this.cmdDelay);
        this.log.info(`[Neewer] ${this.name}: Brightness ${value}%`);
      });

    // Hue
    bulb.getCharacteristic(Characteristic.Hue)
      .onGet(() => this.state.hue)
      .onSet((value) => {
        this.state.hue = value;
        this.state.saturation = this.state.saturation || 100;
        this._saveState();
        setTimeout(() => this._sendColor(), this.cmdDelay);
        this.log.info(`[Neewer] ${this.name}: Hue ${value}`);
      });

    // Saturation
    bulb.getCharacteristic(Characteristic.Saturation)
      .onGet(() => this.state.saturation)
      .onSet((value) => {
        this.state.saturation = value;
        this._saveState();
        setTimeout(() => this._sendColor(), this.cmdDelay);
        this.log.info(`[Neewer] ${this.name}: Saturation ${value}%`);
      });

    // Color Temperature (HomeKit: 140-500 mireds)
    bulb.getCharacteristic(Characteristic.ColorTemperature)
      .setProps({ minValue: 140, maxValue: 500 })
      .onGet(() => this.state.colorTemp)
      .onSet((value) => {
        this.state.colorTemp = value;
        this.state.saturation = 0;
        this._saveState();
        setTimeout(() => this._sendColor(), this.cmdDelay);
        this.log.info(`[Neewer] ${this.name}: ColorTemp ${value} mireds`);
      });
  }

  _saveState() {
    this.accessory.context.on         = this.state.on;
    this.accessory.context.brightness  = this.state.brightness;
    this.accessory.context.hue         = this.state.hue;
    this.accessory.context.saturation  = this.state.saturation;
    this.accessory.context.colorTemp   = this.state.colorTemp;
  }

  _sendColor() {
    // Debounce — wait 80ms after last change before sending
    if (this._colorTimer) clearTimeout(this._colorTimer);
    this._colorTimer = setTimeout(() => {
      this._colorTimer = null;
      const brightness = Math.round(this.state.brightness);
      if (this.state.saturation < 10) {
        const { c, w } = this._miredsToWhiteChannels(this.state.colorTemp);
        this.udp.setRGBCW(brightness, 0, 0, 0, c, w);
      } else {
        const { r, g, b } = this._hsvToRgb(this.state.hue, this.state.saturation, 100);
        this.udp.setRGBCW(brightness, r, g, b, 0, 0);
      }
    }, 80);
  }

  _miredsToWhiteChannels(mireds) {
    const t = (mireds - 140) / (500 - 140);
    return { c: Math.round((1 - t) * 255), w: Math.round(t * 255) };
  }

  _hsvToRgb(h, s, v) {
    s /= 100; v /= 100;
    const c = v * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60)       { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else              { r = c; g = 0; b = x; }
    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255),
    };
  }
}

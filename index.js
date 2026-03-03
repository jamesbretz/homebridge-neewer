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
    // Remove accessories no longer present
    this.accessories = this.accessories.filter(acc => {
      const still = lights.find(l => l.ip === acc.context.ip);
      if (!still) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        return false;
      }
      return true;
    });

    // Add or reconfigure lights
    for (const light of lights) {
      if (!light.ip) {
        this.log.warn(`[Neewer] Light "${light.name}" has no IP address — skipping.`);
        continue;
      }
      const existing = this.accessories.find(a => a.context.ip === light.ip);
      if (existing) {
        new NeewerAccessory(this.log, this.api, existing, light);
      } else {
        this._addAccessory(light);
      }
    }
  }

  _addAccessory(light) {
    const uuid = this.api.hap.uuid.generate(`neewer-${light.ip}`);
    const acc = new this.api.platformAccessory(light.name || light.ip, uuid);
    acc.context.ip = light.ip;
    new NeewerAccessory(this.log, this.api, acc, light);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
    this.accessories.push(acc);
    this.log.info(`[Neewer] Added light: ${light.name} (${light.ip})`);
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }
}

class NeewerAccessory {
  constructor(log, api, accessory, config) {
    this.log = log;
    this.api = api;
    this.accessory = accessory;
    this.config = config;
    this.name = config.name || config.ip;

    this.udp = new NeewerUDP(config.ip, log);
    this.udp.connect();

    // Internal state — will be updated from status response
    this.state = {
      on: false,
      brightness: 100,
      hue: 0,
      saturation: 0,
      colorTemp: 300,
    };

    // Listen for power state updates from the light
    this.udp.onPowerState = (power) => {
      if (this.state.on !== power) {
        this.state.on = power;
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
        this.udp.setPower(value);
        if (value) this._sendColor();
        this.log.info(`[Neewer] ${this.name}: ${value ? 'ON' : 'OFF'}`);
      });

    // Brightness
    bulb.getCharacteristic(Characteristic.Brightness)
      .onGet(() => this.state.brightness)
      .onSet((value) => {
        this.state.brightness = value;
        this._sendColor();
        this.log.info(`[Neewer] ${this.name}: Brightness ${value}%`);
      });

    // Hue
    bulb.getCharacteristic(Characteristic.Hue)
      .onGet(() => this.state.hue)
      .onSet((value) => {
        this.state.hue = value;
        this.state.saturation = this.state.saturation || 100;
        this._sendColor();
        this.log.info(`[Neewer] ${this.name}: Hue ${value}`);
      });

    // Saturation
    bulb.getCharacteristic(Characteristic.Saturation)
      .onGet(() => this.state.saturation)
      .onSet((value) => {
        this.state.saturation = value;
        this._sendColor();
        this.log.info(`[Neewer] ${this.name}: Saturation ${value}%`);
      });

    // Color Temperature (HomeKit: 140-500 mireds)
    bulb.getCharacteristic(Characteristic.ColorTemperature)
      .setProps({ minValue: 140, maxValue: 500 })
      .onGet(() => this.state.colorTemp)
      .onSet((value) => {
        this.state.colorTemp = value;
        this.state.saturation = 0;
        this._sendColor();
        this.log.info(`[Neewer] ${this.name}: ColorTemp ${value} mireds`);
      });
  }

  _sendColor() {
    const brightness = Math.round(this.state.brightness);
    if (this.state.saturation < 10) {
      const { c, w } = this._miredsToWhiteChannels(this.state.colorTemp);
      this.udp.setRGBCW(brightness, 0, 0, 0, c, w);
    } else {
      const { r, g, b } = this._hsvToRgb(this.state.hue, this.state.saturation, 100);
      this.udp.setRGBCW(brightness, r, g, b, 0, 0);
    }
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

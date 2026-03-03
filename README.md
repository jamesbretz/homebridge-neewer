# homebridge-neewer

A Homebridge plugin for controlling Neewer WiFi LED lights via Apple HomeKit.

No Neewer app required. No cloud. Direct UDP control over your local network.

## Features

- **Auto-discovery** — lights are found automatically, no IP configuration needed
- **Full HomeKit control** — on/off, brightness, color (RGB), and color temperature (CCT)
- **Initial state sync** — HomeKit reflects the actual power state of your lights on startup
- **Zero dependencies** — pure Node.js, no Python, no Bluetooth, no external processes

## Supported Devices

Tested with:
- Neewer GL25C

Likely compatible with other Neewer WiFi lights that use the UDP protocol on port 5052 (GL1, GL25C, and similar models).

## Requirements

- [Homebridge](https://homebridge.io) v1.0.0 or later
- Node.js v14 or later
- Neewer light(s) connected to your WiFi network via the Neewer app

## Installation

Install via the Homebridge UI or manually:

```bash
npm install -g homebridge-neewer
```

Then restart Homebridge. Your lights will be discovered automatically.

## Configuration

### Auto-discovery (recommended)

Add the platform to your `config.json` with no lights array — the plugin will find them automatically:

```json
{
  "platforms": [
    {
      "platform": "NeewerLights",
      "name": "Neewer Lights"
    }
  ]
}
```

### Manual configuration (optional)

If you want to assign specific names or have lights with static IPs:

```json
{
  "platforms": [
    {
      "platform": "NeewerLights",
      "name": "Neewer Lights",
      "lights": [
        { "name": "Studio Left", "ip": "192.168.0.139" },
        { "name": "Studio Right", "ip": "192.168.0.156" }
      ]
    }
  ]
}
```

### Recommended: Set static IPs for your lights

Auto-discovered lights are identified by IP address. If your router assigns a new IP via DHCP after a reboot, the light will appear as a new accessory in HomeKit. To avoid this, assign a static/reserved IP to each light in your router's DHCP settings using the light's MAC address (logged on discovery).

## How it works

Neewer WiFi lights communicate over UDP on port 5052. The plugin:

1. Binds a UDP socket on port 5052
2. Listens for light broadcast packets (`80 01 ...`) to discover lights on the network
3. Sends a registration packet containing the controller's IP address
4. Maintains the session with periodic heartbeats
5. Sends control commands (power, brightness, RGB, CCT) as UDP packets

The protocol was reverse engineered via packet capture. Credit to [braintapper/neewer-gl1](https://github.com/braintapper/neewer-gl1) for the initial protocol documentation.

### Packet structure

```
Registration:  80 02 10 00 00 [len] [controller_ip_ascii] 2e
Heartbeat:     80 04 84
Power on:      80 05 02 01 01 89
Power off:     80 05 02 01 00 88
RGBCW:         80 05 07 07 [brightness] [R] [G] [B] [C] [W] [checksum]
Status query:  80 06 01 01 88
Status reply:  80 07 02 01 [01=on/00=off] [checksum]
```

Checksum = sum of all bytes mod 256.

## License

MIT

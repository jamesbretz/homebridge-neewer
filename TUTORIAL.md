# How to Build a Homebridge Plugin from Scratch
## A Complete Guide Using the Neewer GL25C as a Real Example

---

## Part 1: Understanding the Landscape

Before writing a single line of code, you need to understand what you're actually building and why.

### What is Homebridge?

Your iPhone's Home app speaks a language called **HomeKit**. Apple designed HomeKit to work with certified smart home devices — but certification costs manufacturers thousands of dollars and years of effort. Most cheap or niche devices never bother.

Homebridge is a translation layer. It runs on a small computer (like a Raspberry Pi) on your home network and pretends to be a HomeKit hub. You write a **plugin** that teaches Homebridge how to talk to your specific device. Homebridge then translates that into HomeKit language for your iPhone.

So the chain looks like this:

```
iPhone (HomeKit) ↔ Homebridge ↔ Your Plugin ↔ Your Device
```

Your plugin is the middle piece. You're writing a translator.

### What is a Homebridge Plugin?

A plugin is just a Node.js package — a folder of JavaScript files with a specific structure that Homebridge knows how to load. No special compiler, no App Store submission, no certification. Just JavaScript files.

Node.js is JavaScript that runs on a computer (not in a browser). If you've written JavaScript for a webpage, you already know most of the syntax. The main difference is you have access to things like the network and the file system.

### What Problem Are We Solving?

You bought a Neewer GL25C light. It has a WiFi chip. The Neewer app controls it over your local network. You want your iPhone's Home app to control it too.

The question is: **how does the Neewer app talk to the light?** If you can figure that out, you can write code that does the same thing.

---

## Part 2: Reverse Engineering the Protocol

This is the detective work. No documentation exists. You have to figure out the language the app and the light use to communicate.

### The Core Concept: Network Traffic

When the Neewer app sends a command to the light, that command travels across your WiFi network as raw data. That data passes through your router and can be intercepted and read. This is called **packet capture** and it's completely legal on your own network.

Think of it like this: imagine all the conversations in your house travel through a central room. You can stand in that room and write down everything that's said. That's packet capture.

### Tool: tcpdump

`tcpdump` is a command line program that listens to network traffic and prints what it sees. It comes pre-installed on macOS.

Open Terminal and run:

```bash
sudo tcpdump -i any -n udp -w /tmp/neewer.pcap
```

Breaking that down:
- `sudo` — run as administrator (required to access the network)
- `tcpdump` — the program
- `-i any` — listen on all network interfaces
- `-n` — don't resolve IP addresses to hostnames (faster)
- `udp` — only capture UDP traffic (explained below)
- `-w /tmp/neewer.pcap` — save to a file

Now open the Neewer app. Move some sliders. Turn the light on and off. Press Ctrl+C to stop.

To read the capture:

```bash
tcpdump -r /tmp/neewer.pcap -s 0 -xx -n
```

### Why UDP?

Network communication uses two main protocols:

**TCP** — used when every byte matters (web browsing, email). Confirms delivery of every packet. Reliable but slower.

**UDP** — used when speed matters more than perfection (video, games, IoT). Fire and forget. No confirmation.

Smart lights almost always use UDP — a missed packet just means the light doesn't respond to one tap, not a catastrophe.

### Reading the Capture

You'll see output like:

```
20:12:24.305009 IP 192.168.0.187.5052 > 192.168.0.156.5052: UDP, length 5
    0x0000: ... 8006 0101 88
```

- `192.168.0.187` — your Mac's IP (sender)
- `192.168.0.156` — the light's IP (receiver)
- `5052` — the port number (like a door number on a building)
- `8006 0101 88` — the actual data, in hexadecimal

### What is Hexadecimal?

Normal counting goes 0-9. Hexadecimal goes 0-9 then A-F. Two hex digits = one byte (0-255).

`88` hex = 136 decimal. `ff` = 255. `00` = 0.

### The Pattern Recognition Method

This is how you decode an unknown protocol. Make deliberate, isolated changes and watch which bytes change.

**Step 1:** Turn the light on. Note the exact bytes sent.

**Step 2:** Turn it off. Compare. Which byte changed?

```
Power ON:  80 05 02 01 01 89
Power OFF: 80 05 02 01 00 88
```

Position 5 went from `01` to `00` — that's clearly the on/off flag. Position 6 also changed — that's the checksum (more on this shortly).

**Step 3:** Move the brightness slider to specific values (0, 25, 50, 75, 100). Each value produces a packet — find which byte position corresponds to brightness.

**Step 4:** Set pure red, note the bytes. Then pure green, pure blue. The bytes that correspond to each channel reveal the RGB structure.

By making isolated, deliberate changes you can map every byte without any documentation.

### What is a Checksum?

Many protocols include a checksum — a value calculated from the other bytes that lets the receiver verify data wasn't corrupted. You know it's a checksum when one byte always changes to match all the others.

The Neewer checksum algorithm: **add all the bytes together, take mod 256**.

```javascript
const checksum = bytes.reduce((sum, byte) => (sum + byte) % 256, 0);
```

To verify your theory: add up all bytes in a known packet. Does the last byte match? Test this on five different packets. If it holds for all of them, you've found the algorithm.

### The Registration Handshake

The hardest part. Even after decoding all the commands, packets from a new device were silently ignored. 

The breakthrough: capture traffic at the exact moment the app first opens and connects to a light — before it sends any commands. You'll see a distinctive packet sent 3-4 times containing the controller's own IP address as ASCII text followed by a period.

```
80 02 10 00 00 0d 31 39 32 2e 31 36 38 2e 30 2e 31 36 33 2e
                   |--- "192.168.0.163." in ASCII ---------|
```

The light only accepts commands from a registered IP. To register, you send this packet with your own IP embedded in it. Without registration, all commands are silently dropped.

### Useful Tools

**Wireshark** — a free GUI for packet capture. Color coded, searchable, much easier to read than tcpdump for beginners. wireshark.org

**CyberChef** — web tool for converting between hex, ASCII, decimal, and dozens of other formats. gchq.github.io/CyberChef — invaluable for decoding packet data.

**The hex-to-ASCII trick:** When you see a sequence of bytes that might be text, paste them into CyberChef and convert from hex to ASCII. That's how we spotted `3139322e3136382e302e3136332e` = `192.168.0.163.`

---

## Part 3: Writing the UDP Client

Now you understand the protocol. Time to write code that speaks it.

### Node.js Basics You Need

**Variables:**
```javascript
const name = 'Studio Left';  // constant
let count = 0;               // can change
```

**Functions:**
```javascript
function buildPacket(command) {
  return [0x80, 0x05, command];
}
```

**Classes** — templates for objects:
```javascript
class Light {
  constructor(ip) {
    this.ip = ip;
  }
  
  turnOn() {
    console.log(`Turning on ${this.ip}`);
  }
}

const myLight = new Light('192.168.0.156');
myLight.turnOn();
```

**Callbacks** — Node.js is event-driven. Instead of waiting, you say "when this happens, call this":
```javascript
socket.send(packet, port, ip, (err) => {
  // this runs AFTER the send completes
  if (err) console.log('Failed!');
});
// this runs IMMEDIATELY, before the send completes
```

### The dgram Module

Node.js has a built-in module for UDP. No installation needed.

```javascript
const dgram = require('dgram');

const socket = dgram.createSocket('udp4');

socket.bind(5052, () => {
  // Runs when binding is complete
  console.log('Ready');
});
```

**Why bind to port 5052?** We discovered through packet capture that the lights only accept packets whose *source* port is 5052 — they ignore packets from random ports. Binding your socket forces it to send from port 5052.

### Building Packets

A packet is a `Buffer` — an array of raw bytes.

```javascript
// Hardcoded packet
const powerOn = Buffer.from([0x80, 0x05, 0x02, 0x01, 0x01, 0x89]);

// Dynamic packet with checksum
function buildPacket(...bytes) {
  const payload = [0x80, 0x05, ...bytes];
  const checksum = payload.reduce((sum, b) => (sum + b) & 0xff, 0);
  return Buffer.from([...payload, checksum]);
}
```

`...bytes` means "accept any number of arguments." `& 0xff` keeps the value within 0-255 (equivalent to `% 256`).

### The Shared Socket Problem

Two lights can't both bind to port 5052 — the OS only allows one process to own a port at a time. The solution is a **singleton**: one socket, shared by all lights.

```javascript
let sharedSocket = null;

function getSocket(callback) {
  if (sharedSocket) {
    callback(sharedSocket); // already exists, use it
    return;
  }
  
  sharedSocket = dgram.createSocket('udp4');
  sharedSocket.bind(5052, () => {
    callback(sharedSocket); // just created it, now use it
  });
}

// Usage
getSocket((socket) => {
  socket.send(packet, 0, packet.length, 5052, '192.168.0.156');
});
```

This pattern — "create it once, reuse it forever" — is called a singleton.

---

## Part 4: The Homebridge Plugin Structure

### The Files

```
homebridge-neewer/
  index.js           ← main plugin code
  NeewerUDP.js       ← device communication (separated for clarity)
  package.json       ← plugin metadata
  config.schema.json ← Homebridge UI settings form
```

### package.json

```json
{
  "name": "homebridge-neewer",
  "version": "1.0.0",
  "main": "index.js",
  "keywords": ["homebridge-plugin"],
  "engines": {
    "homebridge": ">=1.0.0"
  }
}
```

The `keywords` array must contain `"homebridge-plugin"` — that's how the registry discovers it. The name must start with `homebridge-`.

### The Entry Point

Homebridge calls your plugin file and expects a function that registers your platform:

```javascript
module.exports = (api) => {
  api.registerPlatform('homebridge-neewer', 'NeewerLights', NeewerPlatform);
};
```

Three arguments: npm package name, platform identifier used in config.json, your platform class.

### The Platform Class

Manages all accessories. Homebridge creates one instance and calls specific methods at specific times:

```javascript
class NeewerPlatform {
  constructor(log, config, api) {
    this.log = log;       // this.log.info() to print messages
    this.config = config; // your config.json settings
    this.api = api;
    this.accessories = [];
    
    this.api.on('didFinishLaunching', () => {
      // Safe to register accessories now
      this._setupLights();
    });
  }
  
  // Homebridge calls this for each previously-registered accessory
  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }
}
```

**Why wait for `didFinishLaunching`?** Homebridge loads all cached accessories before firing this event. Acting too early creates duplicates.

### The Accessory Class

One accessory = one physical device. You set up **Services** and **Characteristics** — HomeKit's vocabulary for what a device can do.

A light bulb has a `Lightbulb` Service. That service has Characteristics: `On`, `Brightness`, `Hue`, `Saturation`, `ColorTemperature`.

```javascript
const { Service, Characteristic } = api.hap;

const bulb = accessory.getService(Service.Lightbulb)
  || accessory.addService(Service.Lightbulb);

bulb.getCharacteristic(Characteristic.On)
  .onGet(() => this.state.on)      // HomeKit asks: is it on?
  .onSet((value) => {              // HomeKit says: change it
    this.state.on = value;
    this.udp.setPower(value);
  });
```

`onGet` — called when HomeKit polls for current state.  
`onSet` — called when the user changes something.

### Managing Accessories Across Restarts

Accessories have UUIDs — permanent identifiers saved to disk. On restart, Homebridge calls `configureAccessory` for each saved accessory. Your platform must handle both cases:

```javascript
_setupLights() {
  for (const light of this.config.lights) {
    const existing = this.accessories.find(a => a.context.ip === light.ip);
    
    if (existing) {
      // Reattach behavior to cached accessory
      new NeewerAccessory(this.log, this.api, existing, light);
    } else {
      // Create and register new accessory
      const uuid = this.api.hap.uuid.generate(`neewer-${light.ip}`);
      const acc = new this.api.platformAccessory(light.name, uuid);
      acc.context.ip = light.ip; // persisted to disk
      new NeewerAccessory(this.log, this.api, acc, light);
      this.api.registerPlatformAccessories(
        'homebridge-neewer', 'NeewerLights', [acc]
      );
    }
  }
}
```

`acc.context` is a plain object you can store anything in. It survives Homebridge restarts.

---

## Part 5: Auto-Discovery

Instead of requiring users to type IP addresses, discover lights automatically.

### How Broadcasts Work

The Neewer light announces itself every ~500ms by sending a UDP packet to `255.255.255.255` — the broadcast address. Every device on your network receives it. The packet contains the light's model, IP, and MAC address.

### Listening for Broadcasts

```javascript
socket.on('message', (msg, rinfo) => {
  if (msg[0] === 0x80 && msg[1] === 0x01) {
    // Neewer announcement packet
    const info = parseBroadcast(msg);
    console.log(`Found: ${info.model} at ${info.ip}`);
  }
});
```

### Parsing the Packet

The broadcast packet uses a **length-prefixed** format: each field starts with a byte saying how long the field data is, followed by the data itself.

```javascript
function parseBroadcast(msg) {
  let offset = 4; // skip the 80 01 header bytes
  const fields = {};
  
  while (offset < msg.length - 1) {
    const fieldLen = msg[offset];
    const fieldData = msg.slice(offset + 1, offset + 1 + fieldLen);
    const str = fieldData.toString('ascii');
    
    if (str.match(/^GL/)) fields.model = str;          // "GL25C"
    if (str.match(/^\d+\.\d+\.\d+\.\d+$/)) fields.ip = str;  // "192.168.0.156"
    if (fieldLen === 6) fields.mac = /* format as MAC */;
    
    offset += 1 + fieldLen;
  }
  
  return fields;
}
```

You identify each field by its content: if it looks like an IP address, it's the IP. If it starts with "GL", it's the model name. If it's 6 bytes, it's the MAC address.

### Discovery with a Timeout

Use a Promise that resolves after N seconds:

```javascript
function discoverLights(timeoutMs) {
  return new Promise((resolve) => {
    const found = new Map(); // use Map to deduplicate by IP
    
    socket.on('message', (msg, rinfo) => {
      const info = parseBroadcast(msg);
      if (info && !found.has(info.ip)) {
        found.set(info.ip, info);
      }
    });
    
    setTimeout(() => resolve(Array.from(found.values())), timeoutMs);
  });
}

// In your platform initialization:
const lights = await discoverLights(10000); // wait 10 seconds
```

`async/await` makes Promises readable. `await` pauses until the Promise resolves, without freezing the whole program.

---

## Part 6: Getting State from the Device

If the device can report its current state, you should ask on startup so HomeKit shows the right values immediately.

We saw in the packet capture that the light responds to a status query:

```
Query:    80 06 01 01 88
Response: 80 07 02 01 [01=on / 00=off] [checksum]
```

Send the query after registration, then listen for the response:

```javascript
// In your message handler
if (msg[0] === 0x80 && msg[1] === 0x07) {
  const power = msg[4] === 0x01;
  
  // Push state update to HomeKit without HomeKit asking
  bulb.updateCharacteristic(Characteristic.On, power);
}
```

`updateCharacteristic` proactively pushes an update to HomeKit. This is how your app reflects the actual physical state of the device rather than an assumed state.

---

## Part 7: The Debugging Mindset

### The Development Loop

1. Edit your files
2. Copy to Homebridge's plugin directory
3. Restart Homebridge
4. Read the logs
5. Test in HomeKit
6. Repeat

### Reading Logs

Homebridge logs to its console. Your `this.log.info()` calls appear here. When something doesn't work, check the logs first. Look for:
- Did your initialization message appear? (Is the plugin loading?)
- Did your callback get called? (Is the event firing?)
- Are there error messages?

### Adding Debug Lines

When behavior is wrong, add log lines to narrow down where:

```javascript
this.log.info('About to send registration packet');
this._sendRegistration();
this.log.info('Registration sent, waiting for response');
```

Keep narrowing until you find the exact line where behavior diverges from expectation.

### Using Packet Capture Alongside Your Code

The most powerful debugging technique: run `tcpdump` while your plugin runs. This lets you see exactly what your plugin is actually sending vs. what you think it's sending.

In our project: we thought the plugin was sending packets but tcpdump showed nothing from the Pi's IP. That told us the socket wasn't sending — not that the protocol was wrong. Without packet capture we'd have spent hours chasing the wrong problem.

---

## The Core Mindset

The most important skill in this kind of project isn't coding — it's **systematic experimentation**.

Form a hypothesis → design a test → run it → update your understanding.

Everything about this protocol was unknown at the start. Every piece was figured out by watching, comparing, and reasoning. The code came last — it was just implementing what we'd already understood through observation.

When you're stuck: don't guess. Add a measurement. Find out exactly what's happening before deciding what to change.

That's the real skill: turning an unknown black box into a documented, controllable system through patient observation.

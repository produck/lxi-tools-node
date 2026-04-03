# lxi-tools (JavaScript)

JavaScript port of
[lxi-tools](https://lxi-tools.github.io) for controlling
LXI compatible instruments (oscilloscopes, power supplies,
spectrum analyzers, etc.).

Pure Node.js implementation with **zero external dependencies**.
Supports VXI-11 and RAW/TCP protocols.

## Features

- **Device Discovery** — VXI-11 UDP broadcast + mDNS/DNS-SD
- **SCPI Commands** — one-shot or persistent session mode
- **Screenshot Capture** — 24 built-in instrument plugins
  with auto-detection
- **Benchmarking** — measure instrument request/response rate
- **Low-level Control** — full connect / send / receive /
  disconnect API

## Installation

```bash
# Import directly (within the project)
import { lxi, discovery, SCPI } from './js/index.js';

# Or install as a local package
npm install ./js
```

> Requires Node.js >= 18
> (uses `node:net`, `node:dgram`, `node:os`)

## Quick Start

```js
import { discovery, SCPI } from "./js/index.js";

// Discover LXI devices on the local network
const devices = await discovery.discover({ timeout: 2000 });
console.log(devices);
// [{ address: '10.0.0.42',
//    id: 'RIGOL TECHNOLOGIES,DS1054Z,...' }]

// Send a SCPI command
const id = await SCPI.scpi("10.0.0.42", {
	command: "*IDN?",
});
console.log(id);
// 'RIGOL TECHNOLOGIES,DS1054Z,...,00.04.04.SP3'
```

## API Reference

### Discovery

#### `discovery.discover(options?)`

Search the network for LXI devices.

```js
import { discovery } from "lxi-tools";

// VXI-11 broadcast discovery (default)
const devices = await discovery.discover({
	timeout: 1000,
});

// mDNS/DNS-SD discovery
const services = await discovery.discover({
	mdns: true,
	timeout: 5000,
});
```

| Parameter             | Type       | Default       | Description    |
| --------------------- | ---------- | ------------- | -------------- |
| `options.mdns`        | `boolean`  | `false`       | Use mDNS       |
| `options.timeout`     | `number`   | `1000`/`5000` | ms             |
| `options.onDevice`    | `function` | —             | Per-device cb  |
| `options.onService`   | `function` | —             | Per-service cb |
| `options.onBroadcast` | `function` | —             | Per-iface cb   |

**Returns:**
`Promise<Array<{ address, id }>>` or
`Promise<Array<{ address, id, service, port }>>`

---

### SCPI Commands

#### `SCPI.scpi(address, options)`

Send a SCPI command and optionally receive a response.
The connection is opened and closed automatically.

```js
import { SCPI } from "lxi-tools";

// Query commands (containing '?') return a string
const id = await SCPI.scpi("10.0.0.42", {
	command: "*IDN?",
});

// Set commands return null
await SCPI.scpi("10.0.0.42", { command: "*RST" });

// Using RAW/TCP protocol
await SCPI.scpi("10.0.0.42", {
	command: "*IDN?",
	protocol: "RAW",
	port: 5025,
	timeout: 5000,
});
```

| Parameter          | Type     | Default      | Description |
| ------------------ | -------- | ------------ | ----------- |
| `address`          | `string` | **required** | IP address  |
| `options.command`  | `string` | **required** | SCPI cmd    |
| `options.port`     | `number` | `0` (auto)   | Port        |
| `options.timeout`  | `number` | `3000`       | ms          |
| `options.protocol` | `string` | `'VXI11'`    | Protocol    |

**Returns:** `Promise<string | null>`

#### `SCPI.scpiOnDevice(device, command, timeout?)`

Send a SCPI command on an existing connection.
Useful for multi-command sessions.

```js
import { lxi, SCPI } from "lxi-tools";

const dev = await lxi.connect("10.0.0.42");
const id = await SCPI.scpiOnDevice(dev, "*IDN?");
await SCPI.scpiOnDevice(dev, ":CHAN1:DISP ON");
await lxi.disconnect(dev);
```

#### `SCPI.scpiRaw(device, command, timeout?)`

Send a raw command and return a `Buffer`.
No newline is appended and no string processing is done.

---

### Low-level Connection Control

#### `lxi.connect(address, port?, name?, timeout?, protocol?)`

Open a connection to an instrument. Returns a device
handle (integer).

```js
import { lxi } from "lxi-tools";

const dev = await lxi.connect("10.0.0.42", 0, "inst0", 3000, "VXI11");
```

| Parameter  | Type     | Default      | Description               |
| ---------- | -------- | ------------ | ------------------------- |
| `address`  | `string` | **required** | IP address                |
| `port`     | `number` | `0`          | Auto: VXI11→111, RAW→5025 |
| `name`     | `string` | `'inst0'`    | VXI-11 device name        |
| `timeout`  | `number` | `3000`       | ms                        |
| `protocol` | `string` | `'VXI11'`    | `'VXI11'`/`'RAW'`         |

**Returns:** `Promise<number>` — device handle

#### `lxi.send(device, command, timeout?)`

Send data to a connected instrument.

**Returns:** `Promise<number>` — bytes sent

#### `lxi.receive(device, maxLength?, timeout?)`

Receive data from a connected instrument.

**Returns:** `Promise<Buffer>` — response data

#### `lxi.disconnect(device)`

Close the connection.

#### `lxi.Protocol`

Protocol constants: `lxi.Protocol.VXI11`, `lxi.Protocol.RAW`

---

### Screenshot

#### `Screenshot.screenshot(address, options?)`

Capture a screenshot from an instrument. Supports
auto-detection of the instrument model.

```js
import fs from "node:fs";
import { Screenshot } from "lxi-tools";

const img = await Screenshot.screenshot("10.0.0.42");
fs.writeFileSync(`screenshot.${img.format}`, img.data);

// Specify a plugin explicitly
const img2 = await Screenshot.screenshot("10.0.0.42", {
	plugin: "rigol-1000z",
	timeout: 15000,
});
```

| Parameter         | Type     | Default      | Description |
| ----------------- | -------- | ------------ | ----------- |
| `address`         | `string` | **required** | IP address  |
| `options.plugin`  | `string` | auto         | Plugin name |
| `options.timeout` | `number` | `10000`      | ms          |

**Returns:**
`Promise<{ data: Buffer, format: string, plugin: string }>`

#### `Screenshot.listPlugins()`

List all available screenshot plugins.

```js
import { Screenshot } from "lxi-tools";

const plugins = Screenshot.listPlugins();
// [{ name: 'rigol-1000z',
//    description: 'Rigol DS1000Z/MSO1000Z' }, ...]
```

#### `Screenshot.detectPlugin(address, timeout?)`

Auto-detect the plugin from the `*IDN?` response.

**Returns:** `Promise<string | null>` — plugin name

#### Supported Instruments

| Plugin             | Instrument                | Fmt |
| ------------------ | ------------------------- | --- |
| `keysight-dmm`     | Keysight 34xxxA DMM       | BMP |
| `keysight-dso`     | Keysight MSO/DSO6000A     | BMP |
| `keysight-ivx`     | Keysight InfiniiVision X  | BMP |
| `keysight-psa`     | Keysight E44xxA PSA       | GIF |
| `keysight-pxa`     | Keysight N90xxA PXA       | PNG |
| `lecroy-wp`        | LeCroy WavePro/WaveRunner | PNG |
| `rigol-1000z`      | Rigol DS1000Z / MSO1000Z  | PNG |
| `rigol-2000`       | Rigol DS/MSO 2000–8000    | BMP |
| `rigol-dg`         | Rigol DG1000Z / DG4000    | BMP |
| `rigol-dl3000`     | Rigol DL3000              | BMP |
| `rigol-dm3068`     | Rigol DM3068              | BMP |
| `rigol-dp800`      | Rigol DP800               | BMP |
| `rigol-dsa`        | Rigol DSA700 / DSA800     | BMP |
| `rs-fsv`           | Rohde & Schwarz FSV       | PNG |
| `rs-hmo-rtb`       | Rohde & Schwarz HMO/RTB   | PNG |
| `rs-ng`            | Rohde & Schwarz NGM/NGL   | PNG |
| `rs-rth`           | Rohde & Schwarz RTH       | PNG |
| `siglent-sdg`      | Siglent SDG               | BMP |
| `siglent-sdm3000`  | Siglent SDM3000           | BMP |
| `siglent-sds`      | Siglent SDS1000/SDS2000   | BMP |
| `siglent-ssa3000x` | Siglent SSA3000X          | BMP |
| `tektronix-2000`   | Tektronix DPO/MSO 2000    | PNG |
| `tektronix-3000`   | Tektronix TDS3000         | BMP |
| `tektronix-mso-5`  | Tektronix MSO5000         | PNG |

---

### Benchmark

#### `Benchmark.benchmark(address, options?)`

Measure instrument response rate by repeatedly sending
`*IDN?` requests.

```js
import { Benchmark } from "lxi-tools";

const result = await Benchmark.benchmark("10.0.0.42", {
	count: 200,
	timeout: 5000,
	onProgress: (n) => {
		process.stdout.write(`\r${n}/200`);
	},
});
console.log(`${result.requestsPerSecond.toFixed(1)} req/s`);
```

| Parameter            | Type       | Default      | Description |
| -------------------- | ---------- | ------------ | ----------- |
| `address`            | `string`   | **required** | IP address  |
| `options.port`       | `number`   | `0`          | Port        |
| `options.timeout`    | `number`   | `3000`       | ms          |
| `options.protocol`   | `string`   | `'VXI11'`    | Protocol    |
| `options.count`      | `number`   | `100`        | Requests    |
| `options.onProgress` | `function` | —            | Callback    |

**Returns:**
`Promise<{ requestsPerSecond, count, elapsed }>`

---

### Advanced API

Available for low-level or custom usage:

```js
import { vxi11, rpc } from "lxi-tools";
```

- `vxi11.vxi11Connect(host, port, name, timeout)` —
  create a VXI-11 session directly
- `vxi11.getVxi11Port(host, timeout)` —
  query the VXI-11 port via portmapper
- `rpc.XdrWriter` / `rpc.XdrReader` —
  XDR encoding/decoding utilities

## Project Structure

```
js/
├── index.js          # Entry point, unified exports
├── package.json
├── README.md
└── lib/
    ├── rpc.js        # XDR codec + ONC-RPC protocol
    ├── vxi11.js      # VXI-11 protocol
    ├── lxi.js        # Core connection (VXI11 + RAW)
    ├── discover.js   # Device discovery
    ├── scpi.js       # SCPI command I/O
    ├── benchmark.js  # Performance benchmark
    └── screenshot.js # Screenshot (24 plugins)
```

## Mapping to the C Version

| JS Module           | C Source                       | Purpose           |
| ------------------- | ------------------------------ | ----------------- |
| `lib/rpc.js`        | liblxi                         | VXI-11/RPC        |
| `lib/vxi11.js`      | liblxi                         | VXI-11/RPC        |
| `lib/lxi.js`        | liblxi API                     | connect/send/recv |
| `lib/discover.js`   | `discover.c`                   | Discovery         |
| `lib/scpi.js`       | `scpi.c`                       | SCPI commands     |
| `lib/benchmark.js`  | `benchmark.c`                  | Benchmark         |
| `lib/screenshot.js` | `screenshot.c` + `plugins/*.c` | Screenshot        |

## Acknowledgments

This JavaScript port was developed with the decisive
contribution of **Claude Opus** (Anthropic) serving as
the AI pair-programmer. Opus performed the full
C → JavaScript translation, designed the zero-dependency
architecture, implemented the ONC-RPC / XDR / VXI-11
protocol stack, authored all 24 screenshot plugins, and
wrote the test suite and documentation.

## License

BSD-3-Clause — Ported from
[lxi-tools](https://github.com/lxi-tools/lxi-tools)
by Martin Lund.

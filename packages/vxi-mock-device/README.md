# vxi-mock-device

VXI-11 mock instrument for testing
[@produck/lxi-tools-node](../lxi-tools-node) without real
hardware.

Implements a TCP portmapper + VXI-11 core channel server
that responds to SCPI commands via user-registered handlers.

## Usage

```js
import { MockDevice } from "@produck/vxi-mock-device";

const mock = new MockDevice({
	identity: "RIGOL TECHNOLOGIES,DS1054Z,DS1ZA000000001,00.04.04.SP3",
});

// Register custom SCPI handlers
mock.handle(":DISP:DATA?", () => {
	return fs.readFileSync("fixture.png");
});

await mock.start();
console.log(`VXI-11 on port ${mock.vxi11Port}`);

// ... run tests against 127.0.0.1 ...

await mock.stop();
```

## API

### `new MockDevice(options?)`

| Option           | Type     | Default                         | Description                           |
| ---------------- | -------- | ------------------------------- | ------------------------------------- |
| `identity`       | `string` | `'MOCK,MockDevice,SN001,1.0.0'` | `*IDN?` response                      |
| `maxReceiveSize` | `number` | `0x100000` (1 MB)               | VXI-11 maxRecvSize reported to client |
| `fragmentSize`   | `number` | `0`                             | RPC fragment size (0 = single)        |

### `mock.handle(command, handler)`

Register a SCPI command handler (case-insensitive).
Handler signature: `(command: string) => string | Buffer | null | Promise<...>`

### `mock.removeHandler(command)`

Remove a previously registered handler.

### `mock.start(portmapperPort?, vxi11Port?)`

Start the mock device. Use port `0` (default) for
OS-assigned ephemeral ports.

### `mock.stop()`

Stop the mock device and release all resources.

### Properties

| Property         | Description                                 |
| ---------------- | ------------------------------------------- |
| `portmapperPort` | TCP port of the portmapper (after start)    |
| `vxi11Port`      | TCP port of the VXI-11 server (after start) |
| `identity`       | Configured `*IDN?` string                   |

## Multi-fragment Testing

Set `fragmentSize` to a small value to force multi-fragment
RPC record marking — useful for regression-testing the
client's multi-fragment parser:

```js
const mock = new MockDevice({
	fragmentSize: 1024, // split replies into 1 KB fragments
});
```

## License

MIT

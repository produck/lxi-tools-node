/**
 * VXI-11 mock instrument device.
 *
 * Implements a TCP portmapper + VXI-11 core channel server that responds
 * to SCPI commands via user-registered handlers. Designed for testing
 * lxi-tools-node without real hardware.
 *
 * Protocol references:
 *   - RFC 1057  (ONC-RPC)
 *   - RFC 1014  (XDR)
 *   - RFC 5531  §11 (Record Marking)
 *   - VXI-11 TCP/IP Instrument Protocol specification
 */

import net from 'node:net';
import { XdrWriter, XdrReader } from './xdr.mjs';

// ─── RPC Constants ───────────────────────────────────────────────────

const MSG_TYPE_CALL = 0;
const MSG_TYPE_REPLY = 1;
const REPLY_MSG_ACCEPTED = 0;
const ACCEPT_SUCCESS = 0;
const AUTH_NONE = 0;

// ─── Portmapper ──────────────────────────────────────────────────────

const PORTMAPPER_PROGRAM = 100000;
const PORTMAPPER_PROC_GETPORT = 3;

// ─── VXI-11 ──────────────────────────────────────────────────────────

const VXI11_CORE_PROGRAM = 0x0607af;
const CREATE_LINK = 10;
const DEVICE_WRITE = 11;
const DEVICE_READ = 12;
const DESTROY_LINK = 23;
const VXI11_READ_REASON_END = 0x04;

// ─── RPC Record Marking ─────────────────────────────────────────────

/**
 * Wrap a buffer as a single-fragment RPC record.
 */
function wrapRecord(buffer) {
	const header = Buffer.alloc(4);

	header.writeUInt32BE((0x80000000 | buffer.length) >>> 0);

	return Buffer.concat([header, buffer]);
}

/**
 * Wrap a buffer as a multi-fragment RPC record.
 * Useful for regression-testing the client's multi-fragment parser.
 */
function wrapRecordMultiFragment(buffer, fragmentSize) {
	if (!fragmentSize || fragmentSize <= 0 || buffer.length <= fragmentSize) {
		return wrapRecord(buffer);
	}

	const parts = [];
	let offset = 0;

	while (offset < buffer.length) {
		const end = Math.min(offset + fragmentSize, buffer.length);
		const isLast = end === buffer.length;
		const frag = buffer.subarray(offset, end);
		const header = Buffer.alloc(4);

		header.writeUInt32BE(((isLast ? 0x80000000 : 0) | frag.length) >>> 0);
		parts.push(header, frag);
		offset = end;
	}

	return Buffer.concat(parts);
}

// ─── RPC Message Helpers ─────────────────────────────────────────────

function buildRpcReply(xid, payload) {
	const writer = new XdrWriter(28 + (payload ? payload.length : 0));

	writer.writeUInt32(xid);
	writer.writeUInt32(MSG_TYPE_REPLY);
	writer.writeUInt32(REPLY_MSG_ACCEPTED);
	writer.writeUInt32(AUTH_NONE);  // verifier flavor
	writer.writeUInt32(0);          // verifier length
	writer.writeUInt32(ACCEPT_SUCCESS);

	if (payload && payload.length > 0) {
		writer._ensure(payload.length);
		payload.copy(writer._buffer, writer._offset);
		writer._offset += payload.length;
	}

	return writer.toBuffer();
}

function parseRpcCall(buffer) {
	const reader = new XdrReader(buffer);
	const xid = reader.readUInt32();
	const messageType = reader.readUInt32();

	if (messageType !== MSG_TYPE_CALL) return null;

	reader.readUInt32(); // rpcVersion
	const program = reader.readUInt32();

	reader.readUInt32(); // version
	const procedure = reader.readUInt32();

	// credentials
	reader.readUInt32(); // flavor
	const credLen = reader.readUInt32();

	if (credLen > 0) reader._offset += credLen;

	// verifier
	reader.readUInt32(); // flavor
	const verifLen = reader.readUInt32();

	if (verifLen > 0) reader._offset += verifLen;

	return { xid, program, procedure, payload: buffer.subarray(reader._offset) };
}

// ─── TCP Connection Handler ──────────────────────────────────────────

/**
 * Handles a single TCP connection, reading record-marked RPC messages
 * and dispatching them to the provided async handler.
 */
class ConnectionHandler {
	constructor(socket, dispatch) {
		this._socket = socket;
		this._dispatch = dispatch;
		this._buf = Buffer.alloc(0);
		this._queue = [];
		this._busy = false;

		socket.on('data', (chunk) => {
			this._buf = Buffer.concat([this._buf, chunk]);
			this._drain();
		});
		socket.on('error', () => socket.destroy());
	}

	/** Extract complete records from buffer and enqueue. */
	_drain() {
		while (true) {
			const record = this._extractRecord();

			if (!record) break;

			this._queue.push(record);
		}

		this._process();
	}

	/**
	 * Extract one complete record-marked message (may span multiple
	 * fragments). Returns null if data is incomplete.
	 */
	_extractRecord() {
		const buf = this._buf;
		const parts = [];
		let offset = 0;

		while (offset + 4 <= buf.length) {
			const header = buf.readUInt32BE(offset);
			const isLast = !!(header & 0x80000000);
			const fragLen = header & 0x7fffffff;

			if (offset + 4 + fragLen > buf.length) return null;

			parts.push(buf.subarray(offset + 4, offset + 4 + fragLen));
			offset += 4 + fragLen;

			if (isLast) {
				this._buf = buf.subarray(offset);

				return Buffer.concat(parts);
			}
		}

		return null;
	}

	/** Process queued records sequentially (respects async handlers). */
	async _process() {
		if (this._busy) return;

		this._busy = true;

		while (this._queue.length > 0) {
			const data = this._queue.shift();

			try {
				const call = parseRpcCall(data);

				if (!call) continue;

				const result = await this._dispatch(call);

				if (result == null) continue;

				const { payload, fragmentSize } = result;
				const reply = buildRpcReply(call.xid, payload);

				this._socket.write(wrapRecordMultiFragment(reply, fragmentSize));
			} catch {
				// Swallow handler errors to avoid crashing test harness.
			}
		}

		this._busy = false;
	}
}

// ─── MockDevice ──────────────────────────────────────────────────────

export class MockDevice {
	/**
	 * @param {object}  [options]
	 * @param {string}  [options.identity]       *IDN? response (IEEE 488.2)
	 * @param {number}  [options.maxReceiveSize]  VXI-11 maxRecvSize (default 1 MB)
	 * @param {number}  [options.fragmentSize]    RPC fragment size for multi-fragment
	 *                                            record marking. 0 = single fragment.
	 */
	constructor(options = {}) {
		this._identity = options.identity || 'MOCK,MockDevice,SN001,1.0.0';
		this._maxRecvSize = options.maxReceiveSize || 0x100000;
		this._fragmentSize = options.fragmentSize || 0;
		this._handlers = new Map();
		this._links = new Map();
		this._nextLinkId = 1;
		this._pending = new Map();
		this._pmServer = null;
		this._vxiServer = null;
		this._portmapperPort = 0;
		this._vxi11Port = 0;

		// Built-in default handler
		this.handle('*IDN?', () => this._identity);
	}

	/** TCP port the portmapper is listening on. */
	get portmapperPort() { return this._portmapperPort; }

	/** TCP port the VXI-11 core channel is listening on. */
	get vxi11Port() { return this._vxi11Port; }

	/** Configured *IDN? identity string. */
	get identity() { return this._identity; }

	/**
	 * Register a SCPI command handler.
	 * Commands are matched case-insensitively.
	 *
	 * @param {string}   command  SCPI command to handle (e.g. '*IDN?')
	 * @param {function} handler  (command) => string | Buffer | null | Promise<...>
	 * @returns {this}
	 */
	handle(command, handler) {
		this._handlers.set(command.toUpperCase(), handler);

		return this;
	}

	/**
	 * Remove a previously registered SCPI handler.
	 *
	 * @param {string} command
	 * @returns {boolean}
	 */
	removeHandler(command) {
		return this._handlers.delete(command.toUpperCase());
	}

	/**
	 * Start the mock device (portmapper + VXI-11 servers).
	 * Use port 0 for OS-assigned ephemeral ports (recommended for tests).
	 *
	 * @param {number} [portmapperPort=0]
	 * @param {number} [vxi11Port=0]
	 */
	async start(portmapperPort = 0, vxi11Port = 0) {
		// VXI-11 server (start first so we know the port for portmapper)
		this._vxiServer = net.createServer((socket) => {
			new ConnectionHandler(socket, (call) => this._onVxi11(call));
		});
		await listen(this._vxiServer, vxi11Port);
		this._vxi11Port = this._vxiServer.address().port;

		// Portmapper server
		this._pmServer = net.createServer((socket) => {
			new ConnectionHandler(socket, (call) => this._onPortmapper(call));
		});
		await listen(this._pmServer, portmapperPort);
		this._portmapperPort = this._pmServer.address().port;
	}

	/**
	 * Stop the mock device and release all resources.
	 */
	async stop() {
		await Promise.all([
			this._pmServer && new Promise((r) => this._pmServer.close(r)),
			this._vxiServer && new Promise((r) => this._vxiServer.close(r)),
		]);
		this._pmServer = null;
		this._vxiServer = null;
		this._links.clear();
		this._pending.clear();
	}

	// ── Portmapper ────────────────────────────────────────────────────

	_onPortmapper(call) {
		if (call.program !== PORTMAPPER_PROGRAM) return null;

		if (call.procedure !== PORTMAPPER_PROC_GETPORT) {
			return { payload: Buffer.alloc(0), fragmentSize: 0 };
		}

		const reader = new XdrReader(call.payload);
		const program = reader.readUInt32();
		const writer = new XdrWriter(4);

		writer.writeUInt32(program === VXI11_CORE_PROGRAM ? this._vxi11Port : 0);

		return { payload: writer.toBuffer(), fragmentSize: 0 };
	}

	// ── VXI-11 Core Channel ───────────────────────────────────────────

	async _onVxi11(call) {
		if (call.program !== VXI11_CORE_PROGRAM) return null;

		let payload;

		switch (call.procedure) {
		case CREATE_LINK:  payload = this._createLink(call.payload); break;
		case DEVICE_WRITE: payload = await this._deviceWrite(call.payload); break;
		case DEVICE_READ:  payload = this._deviceRead(call.payload); break;
		case DESTROY_LINK: payload = this._destroyLink(call.payload); break;
		default: return null;
		}

		return { payload, fragmentSize: this._fragmentSize };
	}

	_createLink(payload) {
		const reader = new XdrReader(payload);

		reader.readInt32();  // clientId
		reader.readInt32();  // lockDevice
		reader.readUInt32(); // lockTimeout
		reader.readString(); // deviceName

		const linkId = this._nextLinkId++;

		this._links.set(linkId, true);

		const w = new XdrWriter(16);

		w.writeInt32(0);                  // error
		w.writeInt32(linkId);             // linkId
		w.writeUInt32(0);                 // abortPort
		w.writeUInt32(this._maxRecvSize); // maxReceiveSize

		return w.toBuffer();
	}

	async _deviceWrite(payload) {
		const reader = new XdrReader(payload);
		const linkId = reader.readInt32();

		reader.readUInt32(); // ioTimeout
		reader.readUInt32(); // lockTimeout
		reader.readInt32();  // flags

		const data = reader.readOpaque();
		const command = data.toString().trim();
		const key = command.toUpperCase();

		let response = null;
		const handler = this._handlers.get(key);

		if (handler) {
			const result = await handler(command);

			if (result != null) {
				response = Buffer.isBuffer(result) ? result : Buffer.from(String(result));
			}
		}

		if (response) {
			this._pending.set(linkId, response);
		} else {
			this._pending.delete(linkId);
		}

		const w = new XdrWriter(8);

		w.writeInt32(0);             // error
		w.writeUInt32(data.length);  // size

		return w.toBuffer();
	}

	_deviceRead(payload) {
		const reader = new XdrReader(payload);
		const linkId = reader.readInt32();
		const requestSize = reader.readUInt32();

		const pending = this._pending.get(linkId);
		const chunk = pending ? pending.subarray(0, requestSize) : Buffer.alloc(0);
		const remaining = pending ? pending.subarray(requestSize) : null;

		if (remaining && remaining.length > 0) {
			this._pending.set(linkId, remaining);
		} else {
			this._pending.delete(linkId);
		}

		const isEnd = !remaining || remaining.length === 0;
		const w = new XdrWriter(12 + chunk.length);

		w.writeInt32(0);                                   // error
		w.writeInt32(isEnd ? VXI11_READ_REASON_END : 0);   // reason
		w.writeOpaque(chunk);                               // data

		return w.toBuffer();
	}

	_destroyLink(payload) {
		const reader = new XdrReader(payload);
		const linkId = reader.readInt32();

		this._links.delete(linkId);
		this._pending.delete(linkId);

		const w = new XdrWriter(4);

		w.writeInt32(0); // error

		return w.toBuffer();
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────

function listen(server, port) {
	return new Promise((resolve, reject) => {
		server.listen(port, '127.0.0.1', resolve);
		server.once('error', reject);
	});
}

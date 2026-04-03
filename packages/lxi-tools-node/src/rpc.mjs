/**
 * XDR (External Data Representation) encoding/decoding utilities
 * and ONC-RPC (Sun RPC) client for VXI-11 communication.
 *
 * Based on RFC 1057 (RPC) and RFC 1014 (XDR).
 */

// --- XDR Encoder ---

export class XdrWriter {
	constructor(size = 4096) {
		this._buffer = Buffer.alloc(size);
		this._offset = 0;
	}

	_ensure(bytes) {
		if (this._offset + bytes > this._buffer.length) {
			const newBuffer = Buffer.alloc(Math.max(this._buffer.length * 2, this._offset + bytes));
			this._buffer.copy(newBuffer);
			this._buffer = newBuffer;
		}
	}

	writeInt32(value) {
		this._ensure(4);
		this._buffer.writeInt32BE(value, this._offset);
		this._offset += 4;
	}

	writeUInt32(value) {
		this._ensure(4);
		this._buffer.writeUInt32BE(value >>> 0, this._offset);
		this._offset += 4;
	}

	writeOpaque(data) {
		const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
		const dataLength = dataBuffer.length;
		const padding = (4 - (dataLength % 4)) % 4;
		this._ensure(4 + dataLength + padding);
		this._buffer.writeUInt32BE(dataLength, this._offset);
		this._offset += 4;
		dataBuffer.copy(this._buffer, this._offset);
		this._offset += dataLength;
		for (let i = 0; i < padding; i++) {
			this._buffer[this._offset++] = 0;
		}
	}

	writeString(string) {
		this.writeOpaque(Buffer.from(string, 'utf-8'));
	}

	toBuffer() {
		return this._buffer.subarray(0, this._offset);
	}
}

// --- XDR Reader ---

export class XdrReader {
	constructor(buffer) {
		this._buffer = buffer;
		this._offset = 0;
	}

	readInt32() {
		const value = this._buffer.readInt32BE(this._offset);
		this._offset += 4;
		return value;
	}

	readUInt32() {
		const value = this._buffer.readUInt32BE(this._offset);
		this._offset += 4;
		return value;
	}

	readOpaque() {
		const dataLength = this.readUInt32();
		const padding = (4 - (dataLength % 4)) % 4;
		const data = this._buffer.subarray(this._offset, this._offset + dataLength);
		this._offset += dataLength + padding;
		return data;
	}

	readString() {
		return this.readOpaque().toString('utf-8');
	}

	remaining() {
		return this._buffer.length - this._offset;
	}
}

// --- RPC Constants ---

const RPC_VERSION = 2;
const MSG_TYPE_CALL = 0;
const MSG_TYPE_REPLY = 1;
const AUTH_NONE = 0;
const REPLY_MSG_ACCEPTED = 0;
const ACCEPT_SUCCESS = 0;

let _transactionId = Math.floor(Math.random() * 0x7fffffff);

function nextTransactionId() {
	return _transactionId++;
}

// --- RPC Message Builders ---

export function buildRpcCall(program, version, procedure, payloadBuffer) {
	const transactionId = nextTransactionId();
	const writer = new XdrWriter(64 + (payloadBuffer ? payloadBuffer.length : 0));
	writer.writeUInt32(transactionId);
	writer.writeUInt32(MSG_TYPE_CALL);
	writer.writeUInt32(RPC_VERSION);
	writer.writeUInt32(program);
	writer.writeUInt32(version);
	writer.writeUInt32(procedure);
	// Credentials: AUTH_NONE
	writer.writeUInt32(AUTH_NONE);
	writer.writeUInt32(0);
	// Verifier: AUTH_NONE
	writer.writeUInt32(AUTH_NONE);
	writer.writeUInt32(0);
	if (payloadBuffer && payloadBuffer.length > 0) {
		writer._ensure(payloadBuffer.length);
		payloadBuffer.copy(writer._buffer, writer._offset);
		writer._offset += payloadBuffer.length;
	}
	return { transactionId, buffer: writer.toBuffer() };
}

export function parseRpcReply(buffer) {
	const reader = new XdrReader(buffer);
	const transactionId = reader.readUInt32();
	const messageType = reader.readUInt32();
	if (messageType !== MSG_TYPE_REPLY) {
		throw new Error(`Expected RPC reply, got messageType=${messageType}`);
	}
	const replyStatus = reader.readUInt32();
	if (replyStatus !== REPLY_MSG_ACCEPTED) {
		throw new Error(`RPC reply rejected, replyStatus=${replyStatus}`);
	}
	// Verifier
	reader.readUInt32(); // auth_flavor
	const verifierLength = reader.readUInt32();
	if (verifierLength > 0) {
		reader._offset += verifierLength;
	}
	const acceptStatus = reader.readUInt32();
	if (acceptStatus !== ACCEPT_SUCCESS) {
		throw new Error(`RPC call failed, acceptStatus=${acceptStatus}`);
	}
	// Return remaining buffer as payload
	return {
		transactionId,
		payload: buffer.subarray(reader._offset),
	};
}

// --- TCP Record Marking ---

export function wrapRecordMarking(buffer) {
	const header = Buffer.alloc(4);
	// Last fragment bit (bit 31) set + length
	header.writeUInt32BE((0x80000000 | buffer.length) >>> 0);
	return Buffer.concat([header, buffer]);
}

export function unwrapRecordMarking(buffer) {
	if (buffer.length < 4) return null;
	const header = buffer.readUInt32BE(0);
	const isLast = !!(header & 0x80000000);
	const fragmentLength = header & 0x7fffffff;
	return { isLast, fragmentLength, data: buffer.subarray(4, 4 + fragmentLength) };
}

// --- Portmapper ---

const PORTMAPPER_PROGRAM = 100000;
const PORTMAPPER_VERSION = 2;
const PORTMAPPER_PROC_GETPORT = 3;
const IPPROTO_TCP = 6;

export function buildPortmapperGetPort(program, version) {
	const writer = new XdrWriter(16);
	writer.writeUInt32(program);
	writer.writeUInt32(version);
	writer.writeUInt32(IPPROTO_TCP);
	writer.writeUInt32(0); // port (ignored)
	return buildRpcCall(PORTMAPPER_PROGRAM, PORTMAPPER_VERSION, PORTMAPPER_PROC_GETPORT, writer.toBuffer());
}

export function parsePortmapperGetPortReply(payload) {
	const reader = new XdrReader(payload);
	return reader.readUInt32();
}

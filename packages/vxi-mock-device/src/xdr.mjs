/**
 * XDR (External Data Representation) encoding/decoding utilities.
 * Server-side counterpart to lxi-tools-node's rpc.mjs XDR classes.
 */

export class XdrWriter {
	constructor(size = 256) {
		this._buffer = Buffer.alloc(size);
		this._offset = 0;
	}

	_ensure(bytes) {
		if (this._offset + bytes > this._buffer.length) {
			const next = Buffer.alloc(Math.max(this._buffer.length * 2, this._offset + bytes));
			this._buffer.copy(next);
			this._buffer = next;
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
		const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
		const padding = (4 - (buf.length % 4)) % 4;

		this._ensure(4 + buf.length + padding);
		this._buffer.writeUInt32BE(buf.length, this._offset);
		this._offset += 4;
		buf.copy(this._buffer, this._offset);
		this._offset += buf.length;

		for (let i = 0; i < padding; i++) this._buffer[this._offset++] = 0;
	}

	writeString(str) {
		this.writeOpaque(Buffer.from(str, 'utf-8'));
	}

	toBuffer() {
		return this._buffer.subarray(0, this._offset);
	}
}

export class XdrReader {
	constructor(buffer) {
		this._buffer = buffer;
		this._offset = 0;
	}

	readInt32() {
		const v = this._buffer.readInt32BE(this._offset);
		this._offset += 4;
		return v;
	}

	readUInt32() {
		const v = this._buffer.readUInt32BE(this._offset);
		this._offset += 4;
		return v;
	}

	readOpaque() {
		const length = this.readUInt32();
		const padding = (4 - (length % 4)) % 4;
		const data = this._buffer.subarray(this._offset, this._offset + length);
		this._offset += length + padding;
		return data;
	}

	readString() {
		return this.readOpaque().toString('utf-8');
	}
}

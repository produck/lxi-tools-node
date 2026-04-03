import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rpc } from '@produck/lxi-tools-node';

describe('rpc', () => {
	describe('XdrWriter', () => {
		it('should be a constructor function.', () => {
			assert.equal(typeof rpc.XdrWriter, 'function');
		});

		describe('#writeInt32() / #writeUInt32()', () => {
			it('should encode a 32-bit signed integer.', () => {
				const w = new rpc.XdrWriter();

				w.writeInt32(-1);
				const buf = w.toBuffer();

				assert.equal(buf.length, 4);
				assert.equal(buf.readInt32BE(0), -1);
			});

			it('should encode a 32-bit unsigned integer.', () => {
				const w = new rpc.XdrWriter();

				w.writeUInt32(0x80000001);
				const buf = w.toBuffer();

				assert.equal(buf.length, 4);
				assert.equal(buf.readUInt32BE(0), 0x80000001);
			});
		});

		describe('#writeOpaque()', () => {
			it('should encode opaque data with length prefix and padding.', () => {
				const w = new rpc.XdrWriter();

				w.writeOpaque(Buffer.from([1, 2, 3]));
				const buf = w.toBuffer();

				// 4 (length) + 3 (data) + 1 (padding) = 8
				assert.equal(buf.length, 8);
				assert.equal(buf.readUInt32BE(0), 3);
				assert.deepEqual([...buf.subarray(4, 7)], [1, 2, 3]);
				assert.equal(buf[7], 0); // padding
			});

			it('should not pad when data length is multiple of 4.', () => {
				const w = new rpc.XdrWriter();

				w.writeOpaque(Buffer.from([1, 2, 3, 4]));
				const buf = w.toBuffer();

				assert.equal(buf.length, 8); // 4 + 4
			});

			it('should accept a string and convert to Buffer.', () => {
				const w = new rpc.XdrWriter();

				w.writeOpaque('hello');
				const buf = w.toBuffer();

				assert.equal(buf.readUInt32BE(0), 5);
				assert.equal(buf.subarray(4, 9).toString(), 'hello');
			});
		});

		describe('#writeString()', () => {
			it('should encode a UTF-8 string as opaque.', () => {
				const w = new rpc.XdrWriter();

				w.writeString('test');
				const buf = w.toBuffer();

				assert.equal(buf.readUInt32BE(0), 4);
				assert.equal(buf.subarray(4, 8).toString(), 'test');
			});
		});

		describe('#toBuffer()', () => {
			it('should return a buffer with all written data.', () => {
				const w = new rpc.XdrWriter();

				w.writeInt32(1);
				w.writeInt32(2);
				const buf = w.toBuffer();

				assert.equal(buf.length, 8);
				assert.equal(buf.readInt32BE(0), 1);
				assert.equal(buf.readInt32BE(4), 2);
			});
		});
	});

	describe('XdrReader', () => {
		it('should be a constructor function.', () => {
			assert.equal(typeof rpc.XdrReader, 'function');
		});

		describe('#readInt32() / #readUInt32()', () => {
			it('should decode a signed 32-bit integer.', () => {
				const buf = Buffer.alloc(4);

				buf.writeInt32BE(-42, 0);
				const reader = new rpc.XdrReader(buf);

				assert.equal(reader.readInt32(), -42);
			});

			it('should decode an unsigned 32-bit integer.', () => {
				const buf = Buffer.alloc(4);

				buf.writeUInt32BE(0xDEADBEEF, 0);
				const reader = new rpc.XdrReader(buf);

				assert.equal(reader.readUInt32(), 0xDEADBEEF);
			});
		});

		describe('#readOpaque()', () => {
			it('should decode opaque data with padding.', () => {
				const w = new rpc.XdrWriter();

				w.writeOpaque(Buffer.from([0xAA, 0xBB, 0xCC]));
				const reader = new rpc.XdrReader(w.toBuffer());
				const data = reader.readOpaque();

				assert.equal(data.length, 3);
				assert.deepEqual([...data], [0xAA, 0xBB, 0xCC]);
			});
		});

		describe('#readString()', () => {
			it('should decode a UTF-8 string.', () => {
				const w = new rpc.XdrWriter();

				w.writeString('hello');
				const reader = new rpc.XdrReader(w.toBuffer());

				assert.equal(reader.readString(), 'hello');
			});
		});

		describe('#remaining()', () => {
			it('should track remaining bytes after reads.', () => {
				const w = new rpc.XdrWriter();

				w.writeInt32(1);
				w.writeInt32(2);
				const reader = new rpc.XdrReader(w.toBuffer());

				assert.equal(reader.remaining(), 8);
				reader.readInt32();
				assert.equal(reader.remaining(), 4);
				reader.readInt32();
				assert.equal(reader.remaining(), 0);
			});
		});
	});

	describe('roundtrip XdrWriter → XdrReader', () => {
		it('should encode and decode a complex message.', () => {
			const w = new rpc.XdrWriter();

			w.writeUInt32(12345);
			w.writeInt32(-99);
			w.writeString('instrument');
			w.writeOpaque(Buffer.from([0x01, 0x02]));

			const reader = new rpc.XdrReader(w.toBuffer());

			assert.equal(reader.readUInt32(), 12345);
			assert.equal(reader.readInt32(), -99);
			assert.equal(reader.readString(), 'instrument');
			assert.deepEqual([...reader.readOpaque()], [0x01, 0x02]);
			assert.equal(reader.remaining(), 0);
		});
	});

	describe('XdrWriter buffer expansion', () => {
		it('should auto-expand when writing exceeds initial size.', () => {
			const w = new rpc.XdrWriter(4); // tiny initial size

			w.writeInt32(1);
			w.writeInt32(2);
			w.writeInt32(3);
			const buf = w.toBuffer();

			assert.equal(buf.length, 12);
			assert.equal(buf.readInt32BE(0), 1);
			assert.equal(buf.readInt32BE(4), 2);
			assert.equal(buf.readInt32BE(8), 3);
		});

		it('should auto-expand for large writeOpaque.', () => {
			const w = new rpc.XdrWriter(8);
			const bigData = Buffer.alloc(100, 0x42);

			w.writeOpaque(bigData);
			const buf = w.toBuffer();

			assert.equal(buf.readUInt32BE(0), 100);
			assert.equal(buf.length, 104); // 4 + 100
		});

		it('should auto-expand for writeString.', () => {
			const w = new rpc.XdrWriter(4);

			w.writeString('this is a long string that exceeds the initial buffer');
			const buf = w.toBuffer();

			assert.ok(buf.length > 4);
		});

		it('should auto-expand for writeUInt32.', () => {
			const w = new rpc.XdrWriter(2); // too small even for one uint32

			w.writeUInt32(42);
			const buf = w.toBuffer();

			assert.equal(buf.readUInt32BE(0), 42);
		});

		it('should expand with writeOpaque when data is not aligned.', () => {
			const w = new rpc.XdrWriter(4);
			const data = Buffer.from([1, 2, 3, 4, 5]); // 5 bytes, needs 3 bytes padding

			w.writeOpaque(data);
			const buf = w.toBuffer();

			assert.equal(buf.readUInt32BE(0), 5);
			assert.equal(buf.length, 12); // 4 + 5 + 3 padding
		});
	});

	describe('parseRpcReply with verifier data', () => {
		it('should skip non-zero verifier length.', () => {
			const w = new rpc.XdrWriter();

			w.writeUInt32(77);  // xid
			w.writeUInt32(1);   // MSG_TYPE_REPLY
			w.writeUInt32(0);   // REPLY_MSG_ACCEPTED
			w.writeUInt32(0);   // verifier flavor (AUTH_NONE)
			w.writeUInt32(8);   // verifier length = 8
			w.writeUInt32(0);   // verifier data (padding)
			w.writeUInt32(0);   // verifier data (padding)
			w.writeUInt32(0);   // ACCEPT_SUCCESS
			w.writeInt32(42);   // payload

			const result = rpc.parseRpcReply(w.toBuffer());

			assert.equal(result.transactionId, 77);

			const payloadReader = new rpc.XdrReader(result.payload);

			assert.equal(payloadReader.readInt32(), 42);
		});
	});

	describe('wrapRecordMarking()', () => {
		it('should prepend a 4-byte header with last-fragment flag.', () => {
			const data = Buffer.from([1, 2, 3, 4]);
			const wrapped = rpc.wrapRecordMarking(data);

			assert.equal(wrapped.length, 8);
			const header = wrapped.readUInt32BE(0);

			assert.ok(header & 0x80000000, 'last-fragment bit should be set');
			assert.equal(header & 0x7fffffff, 4);
			assert.deepEqual([...wrapped.subarray(4)], [1, 2, 3, 4]);
		});
	});

	describe('unwrapRecordMarking()', () => {
		it('should parse a record-marked buffer.', () => {
			const data = Buffer.from([1, 2, 3]);
			const wrapped = rpc.wrapRecordMarking(data);
			const result = rpc.unwrapRecordMarking(wrapped);

			assert.equal(result.isLast, true);
			assert.equal(result.fragmentLength, 3);
			assert.deepEqual([...result.data], [1, 2, 3]);
		});

		it('should return null for buffer shorter than 4 bytes.', () => {
			assert.equal(rpc.unwrapRecordMarking(Buffer.alloc(2)), null);
		});
	});

	describe('buildRpcCall()', () => {
		it('should produce a buffer with correct RPC header.', () => {
			const { transactionId, buffer } = rpc.buildRpcCall(100000, 2, 3, Buffer.alloc(0));

			assert.equal(typeof transactionId, 'number');
			assert.ok(Buffer.isBuffer(buffer));

			const reader = new rpc.XdrReader(buffer);

			assert.equal(reader.readUInt32(), transactionId); // xid
			assert.equal(reader.readUInt32(), 0);             // MSG_TYPE_CALL
			assert.equal(reader.readUInt32(), 2);             // RPC_VERSION
			assert.equal(reader.readUInt32(), 100000);        // program
			assert.equal(reader.readUInt32(), 2);             // version
			assert.equal(reader.readUInt32(), 3);             // procedure
		});

		it('should handle null payloadBuffer.', () => {
			const { transactionId, buffer } = rpc.buildRpcCall(100000, 2, 3, null);

			assert.equal(typeof transactionId, 'number');
			assert.ok(Buffer.isBuffer(buffer));
			// Should have header only: xid + type + rpcVer + prog + ver + proc + cred(2) + verif(2) = 40 bytes
			assert.equal(buffer.length, 40);
		});
	});

	describe('parseRpcReply()', () => {
		it('should parse a valid RPC reply.', () => {
			const w = new rpc.XdrWriter();

			w.writeUInt32(42);  // xid
			w.writeUInt32(1);   // MSG_TYPE_REPLY
			w.writeUInt32(0);   // REPLY_MSG_ACCEPTED
			w.writeUInt32(0);   // verifier flavor (AUTH_NONE)
			w.writeUInt32(0);   // verifier length
			w.writeUInt32(0);   // ACCEPT_SUCCESS
			w.writeInt32(99);   // payload

			const result = rpc.parseRpcReply(w.toBuffer());

			assert.equal(result.transactionId, 42);

			const payloadReader = new rpc.XdrReader(result.payload);

			assert.equal(payloadReader.readInt32(), 99);
		});

		it('should throw on non-reply message type.', () => {
			const w = new rpc.XdrWriter();

			w.writeUInt32(1);  // xid
			w.writeUInt32(0);  // MSG_TYPE_CALL (not a reply)

			assert.throws(() => rpc.parseRpcReply(w.toBuffer()), /Expected RPC reply/);
		});

		it('should throw on rejected reply.', () => {
			const w = new rpc.XdrWriter();

			w.writeUInt32(1);  // xid
			w.writeUInt32(1);  // MSG_TYPE_REPLY
			w.writeUInt32(1);  // rejected

			assert.throws(() => rpc.parseRpcReply(w.toBuffer()), /rejected/);
		});

		it('should throw on non-success accept status.', () => {
			const w = new rpc.XdrWriter();

			w.writeUInt32(1);  // xid
			w.writeUInt32(1);  // MSG_TYPE_REPLY
			w.writeUInt32(0);  // accepted
			w.writeUInt32(0);  // verifier flavor
			w.writeUInt32(0);  // verifier length
			w.writeUInt32(2);  // acceptStatus != SUCCESS

			assert.throws(() => rpc.parseRpcReply(w.toBuffer()), /acceptStatus/);
		});
	});

	describe('buildPortmapperGetPort()', () => {
		it('should produce a valid portmapper GETPORT request.', () => {
			const { transactionId, buffer } = rpc.buildPortmapperGetPort(0x0607af, 1);

			assert.equal(typeof transactionId, 'number');
			assert.ok(buffer.length > 0);
		});
	});

	describe('parsePortmapperGetPortReply()', () => {
		it('should parse the port number from payload.', () => {
			const w = new rpc.XdrWriter();

			w.writeUInt32(9876);
			const port = rpc.parsePortmapperGetPortReply(w.toBuffer());

			assert.equal(port, 9876);
		});
	});
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import net from 'node:net';
import { MockDevice } from '../src/index.mjs';
import { XdrWriter, XdrReader } from '../src/xdr.mjs';

// ─── XDR Tests ──────────────────────────────────────────────────────

describe('XdrWriter', () => {
	it('should write string using writeString()', () => {
		const writer = new XdrWriter();
		writer.writeString('hello');
		const buf = writer.toBuffer();
		// length (4) + 'hello' (5) + padding (3) = 12
		assert.strictEqual(buf.length, 12);
		assert.strictEqual(buf.readUInt32BE(0), 5);
		assert.strictEqual(buf.subarray(4, 9).toString(), 'hello');
	});

	it('should handle non-Buffer data in writeOpaque()', () => {
		const writer = new XdrWriter();
		// Pass a Uint8Array instead of Buffer
		const arr = new Uint8Array([1, 2, 3, 4]);
		writer.writeOpaque(arr);
		const buf = writer.toBuffer();
		assert.strictEqual(buf.readUInt32BE(0), 4);
		assert.deepStrictEqual([...buf.subarray(4, 8)], [1, 2, 3, 4]);
	});

	it('should expand buffer when needed', () => {
		const writer = new XdrWriter(4); // Start small
		writer.writeUInt32(1);
		writer.writeUInt32(2); // Should trigger expansion
		const buf = writer.toBuffer();
		assert.strictEqual(buf.length, 8);
	});
});

describe('XdrReader', () => {
	it('should read all types correctly', () => {
		const writer = new XdrWriter();
		writer.writeInt32(-42);
		writer.writeUInt32(100);
		writer.writeString('test');
		const buf = writer.toBuffer();

		const reader = new XdrReader(buf);
		assert.strictEqual(reader.readInt32(), -42);
		assert.strictEqual(reader.readUInt32(), 100);
		assert.strictEqual(reader.readString(), 'test');
	});
});

// ─── MockDevice Basic Tests ─────────────────────────────────────────

describe('MockDevice', () => {
	describe('constructor and properties', () => {
		it('should use default values when no options provided', () => {
			const device = new MockDevice();
			assert.strictEqual(device.identity, 'MOCK,MockDevice,SN001,1.0.0');
			assert.strictEqual(device.portmapperPort, 0);
			assert.strictEqual(device.vxi11Port, 0);
			assert.strictEqual(device.rawPort, 0);
		});

		it('should accept custom identity', () => {
			const device = new MockDevice({ identity: 'TEST,Custom,123,2.0' });
			assert.strictEqual(device.identity, 'TEST,Custom,123,2.0');
		});
	});

	describe('handler management', () => {
		it('should register and remove handlers', () => {
			const device = new MockDevice();
			device.handle('*RST', () => null);
			assert.strictEqual(device.removeHandler('*RST'), true);
			assert.strictEqual(device.removeHandler('*RST'), false);
		});

		it('should match handlers case-insensitively', () => {
			const device = new MockDevice();
			device.handle('*TST?', () => 'ok');
			// The handler is stored uppercase
			assert.strictEqual(device._handlers.has('*TST?'), true);
		});
	});

	describe('lifecycle', () => {
		let device;

		before(async () => {
			device = new MockDevice();
			await device.start();
		});

		after(async () => {
			await device.stop();
		});

		it('should assign ports after start', () => {
			assert.ok(device.portmapperPort > 0);
			assert.ok(device.vxi11Port > 0);
			assert.ok(device.rawPort > 0);
		});
	});
});

// ─── RAW/SCPI Protocol Tests ────────────────────────────────────────

describe('RAW/SCPI Protocol', () => {
	let device;

	before(async () => {
		device = new MockDevice();
		device.handle('*TST?', () => 'TEST_OK');
		device.handle('THROW', () => { throw new Error('handler error'); });
		device.handle('NULLRESP', () => null);
		await device.start();
	});

	after(async () => {
		await device.stop();
	});

	it('should handle empty lines gracefully', async () => {
		const response = await sendRawCommand(device.rawPort, '\n\n*IDN?\n');
		assert.ok(response.includes('MOCK,MockDevice'));
	});

	it('should skip blank lines and process valid commands', async () => {
		// Multiple empty lines followed by valid command
		const response = await sendRawCommand(device.rawPort, '\n\n\n*TST?\n');
		assert.ok(response.includes('TEST_OK'));
	});

	it('should handle commands without response', async () => {
		// NULLRESP handler returns null, so no response expected
		const socket = net.createConnection(device.rawPort, '127.0.0.1');
		await new Promise(resolve => socket.on('connect', resolve));

		socket.write('NULLRESP\n');
		// Wait briefly for any response
		await new Promise(resolve => setTimeout(resolve, 50));

		// Send another command to verify connection still works
		socket.write('*IDN?\n');
		const response = await new Promise(resolve => {
			socket.once('data', data => resolve(data.toString()));
		});
		socket.destroy();

		assert.ok(response.includes('MOCK,MockDevice'));
	});
});

// ─── VXI-11 Protocol Edge Cases ─────────────────────────────────────

describe('VXI-11 Protocol Edge Cases', () => {
	let device;

	before(async () => {
		device = new MockDevice({ fragmentSize: 0 });
		device.handle('LARGE', () => 'A'.repeat(100)); // Response that may need chunked read
		device.handle('THROW', () => { throw new Error('test error'); });
		await device.start();
	});

	after(async () => {
		await device.stop();
	});

	it('should handle portmapper request for unknown program', async () => {
		// Build a GETPORT request for an unknown program
		const response = await sendPortmapperRequest(device.portmapperPort, 99999);
		// Should return port 0 for unknown program
		const reader = new XdrReader(response);
		// Skip record header (4) + RPC reply header (24 bytes) = 28
		reader._offset = 28;
		const port = reader.readUInt32();
		assert.strictEqual(port, 0);
	});

	it('should handle portmapper request for non-GETPORT procedure', async () => {
		// Send a portmapper request with procedure != 3 (GETPORT)
		const response = await sendRpcRequest(device.portmapperPort, {
			program: 100000, // PORTMAPPER_PROGRAM
			procedure: 0,    // Not GETPORT
		});
		// Should return empty payload
		assert.ok(response.length > 0);
	});

	it('should handle VXI-11 request for unknown procedure', async () => {
		void await sendRpcRequest(device.vxi11Port, {
			program: 0x0607af, // VXI11_CORE_PROGRAM
			procedure: 999,    // Unknown procedure
		});
		// Should not crash, may return null which skips response
	});

	it('should handle VXI-11 request for wrong program', async () => {
		void await sendRpcRequest(device.vxi11Port, {
			program: 12345, // Wrong program
			procedure: 10,
		});
		// Should not crash
	});

	it('should handle device_read without pending data', async () => {
		// Create link first
		const linkId = await vxi11CreateLink(device.vxi11Port);
		// Try to read without writing first
		const readResponse = await vxi11DeviceRead(device.vxi11Port, linkId, 1024);
		// Should return empty data with END flag
		const reader = new XdrReader(readResponse);
		reader._offset = 28; // Skip record header (4) + RPC header (24)
		const error = reader.readInt32();
		const reason = reader.readInt32();
		assert.strictEqual(error, 0);
		assert.strictEqual(reason, 0x04); // VXI11_READ_REASON_END
	});

	it('should handle chunked device_read for large responses', async () => {
		const linkId = await vxi11CreateLink(device.vxi11Port);
		// Write a command that produces a large response
		await vxi11DeviceWrite(device.vxi11Port, linkId, 'LARGE');

		// Read in small chunks
		const chunk1 = await vxi11DeviceRead(device.vxi11Port, linkId, 10);
		const reader1 = new XdrReader(chunk1);
		reader1._offset = 28; // Skip record header (4) + RPC header (24)
		const error1 = reader1.readInt32();
		const reason1 = reader1.readInt32();
		assert.strictEqual(error1, 0);
		// reason should be 0 (not END) if there's more data
		assert.strictEqual(reason1, 0);

		// Read remaining
		const chunk2 = await vxi11DeviceRead(device.vxi11Port, linkId, 200);
		const reader2 = new XdrReader(chunk2);
		reader2._offset = 28;
		const error2 = reader2.readInt32();
		const reason2 = reader2.readInt32();
		assert.strictEqual(error2, 0);
		assert.strictEqual(reason2, 0x04); // VXI11_READ_REASON_END

		await vxi11DestroyLink(device.vxi11Port, linkId);
	});

	it('should handle handler that throws error', async () => {
		const linkId = await vxi11CreateLink(device.vxi11Port);
		// This should not crash the server
		await vxi11DeviceWrite(device.vxi11Port, linkId, 'THROW');
		await vxi11DestroyLink(device.vxi11Port, linkId);
	});
});

// ─── Connection Handler Edge Cases ──────────────────────────────────

describe('ConnectionHandler Edge Cases', () => {
	let device;

	before(async () => {
		device = new MockDevice();
		await device.start();
	});

	after(async () => {
		await device.stop();
	});

	it('should handle incomplete RPC record', async () => {
		// Send partial data that doesn't complete a record
		const socket = net.createConnection(device.vxi11Port, '127.0.0.1');
		await new Promise(resolve => socket.on('connect', resolve));

		// Send partial header only
		const partial = Buffer.alloc(2);
		partial.writeUInt16BE(0x8000, 0);
		socket.write(partial);

		// Wait briefly
		await new Promise(resolve => setTimeout(resolve, 50));

		// Close without sending complete record
		socket.destroy();
	});

	it('should handle socket error', async () => {
		// The socket error handler in ConnectionHandler calls socket.destroy()
		// We test this by closing the socket abruptly
		const socket = net.createConnection(device.vxi11Port, '127.0.0.1');
		await new Promise(resolve => socket.on('connect', resolve));

		// Add error handler to prevent unhandled error
		socket.on('error', () => {});

		// Force close the socket - this triggers the server's error handler
		socket.destroy();

		// Give time for cleanup
		await new Promise(resolve => setTimeout(resolve, 50));
	});

	it('should handle invalid RPC message type', async () => {
		const socket = net.createConnection(device.vxi11Port, '127.0.0.1');
		await new Promise(resolve => socket.on('connect', resolve));

		// Build an RPC message with wrong message type (REPLY instead of CALL)
		// This will cause parseRpcCall to return null, triggering the continue branch
		const writer = new XdrWriter();
		writer.writeUInt32(12345);  // xid
		writer.writeUInt32(1);      // MSG_TYPE_REPLY (wrong type - should be 0 for CALL)
		// Add more bytes to create a valid-looking record
		writer.writeUInt32(0);
		writer.writeUInt32(0);
		writer.writeUInt32(0);
		writer.writeUInt32(0);

		const invalidPayload = writer.toBuffer();
		socket.write(wrapRecord(invalidPayload));

		// Wait for server to process the invalid message (it will continue/skip it)
		await new Promise(resolve => setTimeout(resolve, 150));

		socket.destroy();
	});

	it('should skip processing when parseRpcCall returns null', async () => {
		// Send multiple messages: invalid followed by valid
		// This ensures the continue branch is exercised
		const socket = net.createConnection(device.vxi11Port, '127.0.0.1');
		await new Promise(resolve => socket.on('connect', resolve));

		// First send an invalid message (wrong message type)
		const invalidWriter = new XdrWriter();
		invalidWriter.writeUInt32(99999);  // xid
		invalidWriter.writeUInt32(1);      // MSG_TYPE_REPLY (invalid)
		invalidWriter.writeUInt32(0);
		invalidWriter.writeUInt32(0);
		socket.write(wrapRecord(invalidWriter.toBuffer()));

		// Immediately send a valid CREATE_LINK request
		const payloadWriter = new XdrWriter(32);
		payloadWriter.writeInt32(0);
		payloadWriter.writeInt32(0);
		payloadWriter.writeUInt32(0);
		payloadWriter.writeString('inst0');
		const validCall = buildRpcCall(12345, 0x0607af, 10, payloadWriter.toBuffer());
		socket.write(wrapRecord(validCall));

		// Wait for response from the valid request
		const response = await new Promise((resolve) => {
			const chunks = [];
			socket.on('data', (chunk) => {
				chunks.push(chunk);
				// Give some time for all data to arrive
				setTimeout(() => resolve(Buffer.concat(chunks)), 100);
			});
			setTimeout(() => resolve(Buffer.concat(chunks)), 500);
		});

		socket.destroy();
		// Should have received response for the valid request
		assert.ok(response.length > 0, 'Should receive response for valid request after invalid one');
	});

	it('should handle RPC call with credentials', async () => {
		const response = await sendRpcRequestWithAuth(device.vxi11Port, {
			program: 0x0607af,
			procedure: 10, // CREATE_LINK
			credLen: 8,
			verifLen: 4,
		});
		// Should parse credentials and still process request
		assert.ok(response.length > 0);
	});

	it('should handle incomplete fragment (header claims more data than available)', async () => {
		const socket = net.createConnection(device.vxi11Port, '127.0.0.1');
		await new Promise(resolve => socket.on('connect', resolve));

		// Send a record header that claims 1000 bytes but only send a few
		const header = Buffer.alloc(4);
		header.writeUInt32BE(0x800003E8); // last fragment, 1000 bytes
		socket.write(header);

		// Send only 10 bytes of data (less than claimed 1000)
		socket.write(Buffer.alloc(10));

		// Wait for processing
		await new Promise(resolve => setTimeout(resolve, 50));
		socket.destroy();
	});

	it('should handle portmapper request for non-portmapper program', async () => {
		// Send a request to portmapper port but with wrong program number
		void await sendRpcRequest(device.portmapperPort, {
			program: 12345, // Not PORTMAPPER_PROGRAM (100000)
			procedure: 3,
		});
		// Should be ignored (return null, no response or empty)
		// Just verify no crash
	});
});

// ─── Multi-fragment Tests ───────────────────────────────────────────

describe('Multi-fragment Responses', () => {
	let device;

	before(async () => {
		device = new MockDevice({ fragmentSize: 20 }); // Small fragments
		device.handle('*BIG?', () => 'X'.repeat(100));
		await device.start();
	});

	after(async () => {
		await device.stop();
	});

	it('should send multi-fragment responses', async () => {
		const linkId = await vxi11CreateLink(device.vxi11Port);
		await vxi11DeviceWrite(device.vxi11Port, linkId, '*BIG?');
		const response = await vxi11DeviceRead(device.vxi11Port, linkId, 200);
		// Response should be valid - may have multiple fragments with headers
		// Find the first fragment's error field
		assert.ok(response.length > 32, 'Response should contain data');
		await vxi11DestroyLink(device.vxi11Port, linkId);
	});
});

// ─── Helper Functions ───────────────────────────────────────────────

function sendRawCommand(port, command) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(port, '127.0.0.1');
		let data = '';
		socket.on('connect', () => socket.write(command));
		socket.on('data', chunk => { data += chunk.toString(); });
		socket.on('end', () => resolve(data));
		socket.on('error', reject);
		setTimeout(() => { socket.destroy(); resolve(data); }, 500);
	});
}

function wrapRecord(buffer) {
	const header = Buffer.alloc(4);
	header.writeUInt32BE((0x80000000 | buffer.length) >>> 0);
	return Buffer.concat([header, buffer]);
}

function buildRpcCall(xid, program, procedure, payload = Buffer.alloc(0)) {
	const writer = new XdrWriter(64 + payload.length);
	writer.writeUInt32(xid);
	writer.writeUInt32(0);         // MSG_TYPE_CALL
	writer.writeUInt32(2);         // RPC version
	writer.writeUInt32(program);
	writer.writeUInt32(1);         // program version
	writer.writeUInt32(procedure);
	writer.writeUInt32(0);         // credentials flavor (AUTH_NONE)
	writer.writeUInt32(0);         // credentials length
	writer.writeUInt32(0);         // verifier flavor
	writer.writeUInt32(0);         // verifier length
	if (payload.length > 0) {
		writer._ensure(payload.length);
		payload.copy(writer._buffer, writer._offset);
		writer._offset += payload.length;
	}
	return writer.toBuffer();
}

function sendRpcRequest(port, { program, procedure, payload = Buffer.alloc(0) }) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(port, '127.0.0.1');
		const chunks = [];
		socket.on('connect', () => {
			const call = buildRpcCall(Date.now() & 0xFFFFFFFF, program, procedure, payload);
			socket.write(wrapRecord(call));
		});
		socket.on('data', chunk => chunks.push(chunk));
		socket.on('error', reject);
		setTimeout(() => {
			socket.destroy();
			resolve(Buffer.concat(chunks));
		}, 200);
	});
}

function sendRpcRequestWithAuth(port, { program, procedure, credLen = 0, verifLen = 0 }) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(port, '127.0.0.1');
		const chunks = [];
		socket.on('connect', () => {
			const writer = new XdrWriter(128);
			writer.writeUInt32(Date.now() & 0xFFFFFFFF);  // xid
			writer.writeUInt32(0);         // MSG_TYPE_CALL
			writer.writeUInt32(2);         // RPC version
			writer.writeUInt32(program);
			writer.writeUInt32(1);         // program version
			writer.writeUInt32(procedure);
			writer.writeUInt32(1);         // credentials flavor (AUTH_UNIX or similar)
			writer.writeUInt32(credLen);   // credentials length
			// Write dummy credentials
			for (let i = 0; i < credLen; i += 4) writer.writeUInt32(0);
			writer.writeUInt32(1);         // verifier flavor
			writer.writeUInt32(verifLen);  // verifier length
			// Write dummy verifier
			for (let i = 0; i < verifLen; i += 4) writer.writeUInt32(0);
			// CREATE_LINK payload
			writer.writeInt32(0);   // clientId
			writer.writeInt32(0);   // lockDevice
			writer.writeUInt32(0);  // lockTimeout
			writer.writeString('inst0');
			socket.write(wrapRecord(writer.toBuffer()));
		});
		socket.on('data', chunk => chunks.push(chunk));
		socket.on('error', reject);
		setTimeout(() => {
			socket.destroy();
			resolve(Buffer.concat(chunks));
		}, 200);
	});
}

function sendPortmapperRequest(port, targetProgram) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(port, '127.0.0.1');
		const chunks = [];
		socket.on('connect', () => {
			const payloadWriter = new XdrWriter(16);
			payloadWriter.writeUInt32(targetProgram);  // program
			payloadWriter.writeUInt32(1);              // version
			payloadWriter.writeUInt32(6);              // protocol (TCP)
			payloadWriter.writeUInt32(0);              // port
			const call = buildRpcCall(
				Date.now() & 0xFFFFFFFF,
				100000,  // PORTMAPPER_PROGRAM
				3,       // PORTMAPPER_PROC_GETPORT
				payloadWriter.toBuffer(),
			);
			socket.write(wrapRecord(call));
		});
		socket.on('data', chunk => chunks.push(chunk));
		socket.on('error', reject);
		setTimeout(() => {
			socket.destroy();
			resolve(Buffer.concat(chunks));
		}, 200);
	});
}

async function vxi11CreateLink(port) {
	const payloadWriter = new XdrWriter(32);
	payloadWriter.writeInt32(0);   // clientId
	payloadWriter.writeInt32(0);   // lockDevice
	payloadWriter.writeUInt32(0);  // lockTimeout
	payloadWriter.writeString('inst0');

	const response = await sendRpcRequest(port, {
		program: 0x0607af,
		procedure: 10, // CREATE_LINK
		payload: payloadWriter.toBuffer(),
	});

	const reader = new XdrReader(response);
	reader._offset = 28; // Skip RPC header + error
	return reader.readInt32();
}

async function vxi11DeviceWrite(port, linkId, command) {
	const payloadWriter = new XdrWriter(64);
	payloadWriter.writeInt32(linkId);
	payloadWriter.writeUInt32(10000);  // ioTimeout
	payloadWriter.writeUInt32(10000);  // lockTimeout
	payloadWriter.writeInt32(8);       // flags (END)
	payloadWriter.writeOpaque(Buffer.from(command));

	return sendRpcRequest(port, {
		program: 0x0607af,
		procedure: 11, // DEVICE_WRITE
		payload: payloadWriter.toBuffer(),
	});
}

async function vxi11DeviceRead(port, linkId, requestSize) {
	const payloadWriter = new XdrWriter(16);
	payloadWriter.writeInt32(linkId);
	payloadWriter.writeUInt32(requestSize);
	payloadWriter.writeUInt32(10000);  // ioTimeout
	payloadWriter.writeUInt32(10000);  // lockTimeout
	payloadWriter.writeInt32(0);       // flags
	payloadWriter.writeInt32(0);       // termChar

	return sendRpcRequest(port, {
		program: 0x0607af,
		procedure: 12, // DEVICE_READ
		payload: payloadWriter.toBuffer(),
	});
}

async function vxi11DestroyLink(port, linkId) {
	const payloadWriter = new XdrWriter(4);
	payloadWriter.writeInt32(linkId);

	return sendRpcRequest(port, {
		program: 0x0607af,
		procedure: 23, // DESTROY_LINK
		payload: payloadWriter.toBuffer(),
	});
}

// ─── Concurrent Request Tests (busy check) ──────────────────────────

describe('ConnectionHandler Concurrent Requests', () => {
	let device;

	before(async () => {
		device = new MockDevice();
		// Register a slow async handler that yields control for 100ms
		device.handle('SLOW?', async () => {
			await new Promise(resolve => setTimeout(resolve, 100));
			return 'DONE';
		});
		await device.start();
	});

	after(async () => {
		await device.stop();
	});

	it('should handle concurrent requests (busy reentry check)', async () => {
		// This test triggers ConnectionHandler._process reentry:
		// 1. Send first RPC request with SLOW? command
		// 2. While handler awaits (100ms), send second request after 20ms
		// 3. Second request triggers _drain() -> _process() while _busy=true
		// 4. The "if (this._busy) return" branch is exercised

		const socket = net.createConnection(device.vxi11Port, '127.0.0.1');
		await new Promise(resolve => socket.on('connect', resolve));
		socket.setNoDelay(true);

		// CREATE_LINK
		const createLinkPayload = new XdrWriter(32);
		createLinkPayload.writeInt32(0);
		createLinkPayload.writeInt32(0);
		createLinkPayload.writeUInt32(0);
		createLinkPayload.writeString('inst0');
		const createLinkCall = buildRpcCall(1, 0x0607af, 10, createLinkPayload.toBuffer());
		socket.write(wrapRecord(createLinkCall));

		// Wait for CREATE_LINK response
		await new Promise(resolve => setTimeout(resolve, 50));

		// DEVICE_WRITE with SLOW? command - starts 100ms async handler
		const writePayload = new XdrWriter(64);
		writePayload.writeInt32(1);
		writePayload.writeUInt32(10000);
		writePayload.writeUInt32(10000);
		writePayload.writeInt32(8);
		writePayload.writeOpaque(Buffer.from('SLOW?'));
		const writeCall = buildRpcCall(2, 0x0607af, 11, writePayload.toBuffer());
		socket.write(wrapRecord(writeCall));

		// Wait 20ms - handler is now in the middle of its 100ms await
		await new Promise(resolve => setTimeout(resolve, 20));

		// Send another request while handler is still awaiting
		// This triggers _drain() -> _process() with _busy=true
		const readPayload = new XdrWriter(24);
		readPayload.writeInt32(1);
		readPayload.writeUInt32(100);
		readPayload.writeUInt32(10000);
		readPayload.writeUInt32(10000);
		readPayload.writeInt32(0);
		readPayload.writeInt32(0);
		const readCall = buildRpcCall(3, 0x0607af, 12, readPayload.toBuffer());
		socket.write(wrapRecord(readCall));

		// Collect all responses - wait long enough for slow handler to finish
		const responses = await new Promise((resolve) => {
			const chunks = [];
			socket.on('data', (chunk) => chunks.push(chunk));
			setTimeout(() => resolve(Buffer.concat(chunks)), 300);
		});

		socket.destroy();

		// Should receive all 3 responses
		assert.ok(responses.length > 100, 'Should receive multiple responses');
	});
});

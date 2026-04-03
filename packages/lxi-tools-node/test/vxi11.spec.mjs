import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { MockDevice } from '@produck/vxi-mock-device';
import { vxi11, rpc } from '@produck/lxi-tools-node';

describe('vxi11', () => {
	let mock;

	before(async () => {
		mock = new MockDevice({ identity: 'TEST,Vxi11Test,SN0004,1.0' });
		mock.handle(':DATA?', () => 'HelloVXI');
		await mock.start();
	});

	after(async () => {
		await mock.stop();
	});

	// NOTE: getVxi11Port() hardcodes TCP port 111 for the portmapper
	// connection, so it cannot be tested with MockDevice's ephemeral port
	// without elevated privileges to bind port 111.
	describe('.getVxi11Port()', () => {
		it('should be a function.', () => {
			assert.equal(typeof vxi11.getVxi11Port, 'function');
		});
	});

	describe('.vxi11Connect()', () => {
		it('should establish a VXI-11 session.', async () => {
			const session = await vxi11.vxi11Connect(
				'127.0.0.1', mock.vxi11Port, 'inst0', 3000,
			);

			assert.ok(session);
			assert.equal(typeof session.send, 'function');
			assert.equal(typeof session.receive, 'function');
			assert.equal(typeof session.close, 'function');
			await session.close();
		});

		it('should reject on unreachable port.', async () => {
			await assert.rejects(
				() => vxi11.vxi11Connect('127.0.0.1', 1, 'inst0', 500),
			);
		});
	});

	describe('Vxi11Session', () => {
		describe('.send()', () => {
			it('should return number of bytes sent.', async () => {
				const session = await vxi11.vxi11Connect(
					'127.0.0.1', mock.vxi11Port, 'inst0', 3000,
				);
				const bytes = await session.send('*IDN?');

				assert.equal(typeof bytes, 'number');
				assert.ok(bytes > 0);
				await session.receive(); // consume pending
				await session.close();
			});
		});

		describe('.receive()', () => {
			it('should return a Buffer with response data.', async () => {
				const session = await vxi11.vxi11Connect(
					'127.0.0.1', mock.vxi11Port, 'inst0', 3000,
				);

				await session.send('*IDN?');
				const buf = await session.receive();

				assert.ok(Buffer.isBuffer(buf));
				assert.equal(buf.toString().trim(), 'TEST,Vxi11Test,SN0004,1.0');
				await session.close();
			});

			it('should handle custom SCPI commands.', async () => {
				const session = await vxi11.vxi11Connect(
					'127.0.0.1', mock.vxi11Port, 'inst0', 3000,
				);

				await session.send(':DATA?');
				const buf = await session.receive();

				assert.equal(buf.toString().trim(), 'HelloVXI');
				await session.close();
			});
		});

		describe('.close()', () => {
			it('should close without error.', async () => {
				const session = await vxi11.vxi11Connect(
					'127.0.0.1', mock.vxi11Port, 'inst0', 3000,
				);

				await assert.doesNotReject(() => session.close());
			});
		});
	});

	describe('multi-fragment record marking', () => {
		let fragMock;

		before(async () => {
			// Use small fragment size to force multi-fragment responses
			fragMock = new MockDevice({
				identity: 'TEST,FragTest,SN0005,1.0',
				fragmentSize: 32,
			});

			const largeData = 'X'.repeat(256);

			fragMock.handle(':LARGE?', () => largeData);
			await fragMock.start();
		});

		after(async () => {
			await fragMock.stop();
		});

		it('should reassemble multi-fragment RPC records.', async () => {
			const session = await vxi11.vxi11Connect(
				'127.0.0.1', fragMock.vxi11Port, 'inst0', 3000,
			);

			await session.send('*IDN?');
			const buf = await session.receive();

			assert.equal(buf.toString().trim(), 'TEST,FragTest,SN0005,1.0');
			await session.close();
		});

		it('should handle large multi-fragment responses.', async () => {
			const session = await vxi11.vxi11Connect(
				'127.0.0.1', fragMock.vxi11Port, 'inst0', 3000,
			);

			await session.send(':LARGE?');
			const buf = await session.receive();

			assert.equal(buf.toString().trim(), 'X'.repeat(256));
			await session.close();
		});
	});

	describe('.getVxi11Port()', () => {
		it('should resolve the VXI-11 port via portmapper.', async () => {
			const port = await vxi11.getVxi11Port('127.0.0.1', 3000, mock.portmapperPort);

			assert.equal(typeof port, 'number');
			assert.equal(port, mock.vxi11Port);
		});

		it('should reject on unreachable portmapper.', async () => {
			await assert.rejects(
				() => vxi11.getVxi11Port('127.0.0.1', 500, 1),
			);
		});
	});

	describe('Vxi11Session edge cases', () => {
		it('should send a Buffer directly.', async () => {
			const session = await vxi11.vxi11Connect(
				'127.0.0.1', mock.vxi11Port, 'inst0', 3000,
			);

			const bytes = await session.send(Buffer.from('*IDN?'));

			assert.equal(typeof bytes, 'number');
			assert.ok(bytes > 0);

			const buf = await session.receive();

			assert.ok(buf.toString().includes('TEST'));
			await session.close();
		});

		it('should handle receive with empty response.', async () => {
			// Register a handler that returns empty string
			mock.handle('EMPTY?', () => '');

			const session = await vxi11.vxi11Connect(
				'127.0.0.1', mock.vxi11Port, 'inst0', 3000,
			);

			await session.send('EMPTY?');
			const buf = await session.receive();

			assert.ok(Buffer.isBuffer(buf));
			assert.equal(buf.length, 0);
			await session.close();
		});

		it('should close without error when session is valid.', async () => {
			const session = await vxi11.vxi11Connect(
				'127.0.0.1', mock.vxi11Port, 'inst0', 3000,
			);

			await assert.doesNotReject(() => session.close());
		});

		it('should close gracefully even if socket is already destroyed.', async () => {
			const session = await vxi11.vxi11Connect(
				'127.0.0.1', mock.vxi11Port, 'inst0', 3000,
			);

			// Destroy the underlying socket before close
			session._socket.destroy();

			// close() should not throw (destroy_link error is caught)
			await assert.doesNotReject(() => session.close());
		});

		it('should reject on connection timeout.', async () => {
			await assert.rejects(
				() => vxi11.vxi11Connect('192.0.2.1', 5025, 'inst0', 200),
				/timed out/,
			);
		});

		it('should handle multiple sequential send/receive.', async () => {
			const session = await vxi11.vxi11Connect(
				'127.0.0.1', mock.vxi11Port, 'inst0', 3000,
			);

			await session.send('*IDN?');
			const r1 = await session.receive();

			assert.ok(r1.toString().includes('Vxi11Test'));

			await session.send(':DATA?');
			const r2 = await session.receive();

			assert.equal(r2.toString().trim(), 'HelloVXI');
			await session.close();
		});
	});

	describe('mock device features', () => {
		it('should expose portmapperPort getter.', () => {
			assert.equal(typeof mock.portmapperPort, 'number');
			assert.ok(mock.portmapperPort > 0);
		});

		it('should expose identity getter.', () => {
			assert.equal(mock.identity, 'TEST,Vxi11Test,SN0004,1.0');
		});

		it('should expose rawPort getter.', () => {
			assert.equal(typeof mock.rawPort, 'number');
			assert.ok(mock.rawPort > 0);
		});

		it('should support removeHandler.', () => {
			mock.handle('TEMP?', () => '25.5');
			const removed = mock.removeHandler('TEMP?');

			assert.equal(removed, true);

			const removedAgain = mock.removeHandler('TEMP?');

			assert.equal(removedAgain, false);
		});
	});

	describe('VXI-11 error paths', () => {
		/**
		 * Build a fake VXI-11 RPC reply with a given procedure's error payload.
		 * Uses the real rpc module to craft proper record-marked RPC replies.
		 */
		function buildRpcReplyBuffer(xid, payload) {
			const w = new rpc.XdrWriter(28 + payload.length);

			w.writeUInt32(xid);
			w.writeUInt32(1);  // MSG_TYPE_REPLY
			w.writeUInt32(0);  // REPLY_MSG_ACCEPTED
			w.writeUInt32(0);  // verifier flavor
			w.writeUInt32(0);  // verifier length
			w.writeUInt32(0);  // ACCEPT_SUCCESS
			w._ensure(payload.length);
			payload.copy(w._buffer, w._offset);
			w._offset += payload.length;

			return rpc.wrapRecordMarking(w.toBuffer());
		}

		function extractXid(recordBuf) {
			// Skip 4-byte record marking header, read xid
			return recordBuf.readUInt32BE(4);
		}

		function createFakeVxi11Server(onCall) {
			return new Promise((resolve) => {
				const server = net.createServer((socket) => {
					socket.setNoDelay(true);
					let buf = Buffer.alloc(0);

					socket.on('data', (chunk) => {
						buf = Buffer.concat([buf, chunk]);

						while (buf.length >= 4) {
							const header = buf.readUInt32BE(0);
							const fragLen = header & 0x7fffffff;

							if (buf.length < 4 + fragLen) break;

							const record = buf.subarray(4, 4 + fragLen);

							buf = buf.subarray(4 + fragLen);

							const xid = record.readUInt32BE(0);
							const reply = onCall(xid, record, socket);

							if (reply) socket.write(reply);
						}
					});
				});

				server.listen(0, '127.0.0.1', () => {
					resolve({ server, port: server.address().port });
				});
			});
		}

		it('should throw on create_link error.', async () => {
			const { server, port } = await createFakeVxi11Server((xid) => {
				// Return create_link with error=1
				const w = new rpc.XdrWriter(16);

				w.writeInt32(1);  // error != 0
				w.writeInt32(0);  // linkId
				w.writeUInt32(0); // abortPort
				w.writeUInt32(0); // maxReceiveSize

				return buildRpcReplyBuffer(xid, w.toBuffer());
			});

			try {
				await assert.rejects(
					() => vxi11.vxi11Connect('127.0.0.1', port, 'inst0', 3000),
					/create_link error/,
				);
			} finally {
				server.close();
			}
		});

		it('should throw on device_write error.', async () => {
			let callCount = 0;
			const { server, port } = await createFakeVxi11Server((xid) => {
				callCount++;

				if (callCount === 1) {
					// create_link: success
					const w = new rpc.XdrWriter(16);

					w.writeInt32(0);          // error = 0
					w.writeInt32(1);          // linkId
					w.writeUInt32(0);         // abortPort
					w.writeUInt32(0x100000);  // maxReceiveSize

					return buildRpcReplyBuffer(xid, w.toBuffer());
				}

				// device_write: error
				const w = new rpc.XdrWriter(8);

				w.writeInt32(5);  // error != 0
				w.writeUInt32(0); // size

				return buildRpcReplyBuffer(xid, w.toBuffer());
			});

			try {
				const session = await vxi11.vxi11Connect('127.0.0.1', port, 'inst0', 3000);

				await assert.rejects(
					() => session.send('*IDN?'),
					/device_write error/,
				);
				await session.close();
			} finally {
				server.close();
			}
		});

		it('should throw on device_read error.', async () => {
			let callCount = 0;
			const { server, port } = await createFakeVxi11Server((xid) => {
				callCount++;

				if (callCount === 1) {
					// create_link: success
					const w = new rpc.XdrWriter(16);

					w.writeInt32(0);
					w.writeInt32(1);
					w.writeUInt32(0);
					w.writeUInt32(0x100000);

					return buildRpcReplyBuffer(xid, w.toBuffer());
				}

				if (callCount === 2) {
					// device_write: success
					const w = new rpc.XdrWriter(8);

					w.writeInt32(0);
					w.writeUInt32(5);

					return buildRpcReplyBuffer(xid, w.toBuffer());
				}

				// device_read: error
				const w = new rpc.XdrWriter(12);

				w.writeInt32(3);  // error != 0
				w.writeInt32(0);  // reason
				w.writeOpaque(Buffer.alloc(0));

				return buildRpcReplyBuffer(xid, w.toBuffer());
			});

			try {
				const session = await vxi11.vxi11Connect('127.0.0.1', port, 'inst0', 3000);

				await session.send('*IDN?');
				await assert.rejects(
					() => session.receive(),
					/device_read error/,
				);
				await session.close();
			} finally {
				server.close();
			}
		});

		it('should break receive loop on empty data without END bit.', async () => {
			let callCount = 0;
			const { server, port } = await createFakeVxi11Server((xid) => {
				callCount++;

				if (callCount === 1) {
					// create_link: success
					const w = new rpc.XdrWriter(16);

					w.writeInt32(0);
					w.writeInt32(1);
					w.writeUInt32(0);
					w.writeUInt32(0x100000);

					return buildRpcReplyBuffer(xid, w.toBuffer());
				}

				if (callCount === 2) {
					// device_write: success
					const w = new rpc.XdrWriter(8);

					w.writeInt32(0);
					w.writeUInt32(5);

					return buildRpcReplyBuffer(xid, w.toBuffer());
				}

				// device_read: success but empty data, no END reason
				const w = new rpc.XdrWriter(12);

				w.writeInt32(0);  // error = 0
				w.writeInt32(0);  // reason = 0 (no END bit)
				w.writeOpaque(Buffer.alloc(0));  // empty data

				return buildRpcReplyBuffer(xid, w.toBuffer());
			});

			try {
				const session = await vxi11.vxi11Connect('127.0.0.1', port, 'inst0', 3000);

				await session.send('*IDN?');
				const buf = await session.receive();

				assert.ok(Buffer.isBuffer(buf));
				assert.equal(buf.length, 0);
				await session.close();
			} finally {
				server.close();
			}
		});

		it('should handle RPC overflow (pipelined replies in one TCP packet).', async () => {
			let callCount = 0;
			let pendingReadXid = null;
			const { server, port } = await createFakeVxi11Server((xid, record, socket) => {
				callCount++;

				if (callCount === 1) {
					// create_link: success
					const w = new rpc.XdrWriter(16);

					w.writeInt32(0);
					w.writeInt32(1);
					w.writeUInt32(0);
					w.writeUInt32(0x100000);

					return buildRpcReplyBuffer(xid, w.toBuffer());
				}

				if (callCount === 2) {
					// device_write: success — send write reply + read reply
					// concatenated in a single TCP write to trigger overflow
					const writePayload = (() => {
						const w = new rpc.XdrWriter(8);

						w.writeInt32(0);
						w.writeUInt32(5);

						return w.toBuffer();
					})();

					const writeReply = buildRpcReplyBuffer(xid, writePayload);

					// Pre-craft the read reply with xid+1 (next expected xid)
					// The client hasn't sent the read request yet, but we pipeline
					// the reply to trigger overflow handling
					const readPayload = (() => {
						const w = new rpc.XdrWriter(16);

						w.writeInt32(0);
						w.writeInt32(4);  // VXI11_READ_REASON_END
						w.writeOpaque(Buffer.from('OVERFLOW'));

						return w.toBuffer();
					})();

					const readReply = buildRpcReplyBuffer(0, readPayload);

					// Send both replies in one TCP write
					socket.write(Buffer.concat([writeReply, readReply]));

					return null;  // Already written manually
				}

				// If we get here (device_read request), don't reply — already pipelined
				return null;
			});

			try {
				const session = await vxi11.vxi11Connect('127.0.0.1', port, 'inst0', 3000);

				await session.send('*IDN?');
				const buf = await session.receive();

				assert.ok(Buffer.isBuffer(buf));
				assert.equal(buf.toString(), 'OVERFLOW');
				await session.close();
			} finally {
				server.close();
			}
		});

		it('should reject on RPC receive timeout.', async () => {
			let callCount = 0;
			const { server, port } = await createFakeVxi11Server((xid) => {
				callCount++;

				if (callCount === 1) {
					// create_link: success
					const w = new rpc.XdrWriter(16);

					w.writeInt32(0);
					w.writeInt32(1);
					w.writeUInt32(0);
					w.writeUInt32(0x100000);

					return buildRpcReplyBuffer(xid, w.toBuffer());
				}

				// Do not reply to any subsequent call → triggers timeout
				return null;
			});

			try {
				const session = await vxi11.vxi11Connect('127.0.0.1', port, 'inst0', 500);

				await assert.rejects(
					() => session.send('*IDN?'),
					/timed out/,
				);
				await session.close();
			} finally {
				server.close();
			}
		});

		it('should reject on connection close during RPC.', async () => {
			let callCount = 0;
			const { server, port } = await createFakeVxi11Server((xid, record, socket) => {
				callCount++;

				if (callCount === 1) {
					// create_link: success
					const w = new rpc.XdrWriter(16);

					w.writeInt32(0);
					w.writeInt32(1);
					w.writeUInt32(0);
					w.writeUInt32(0x100000);

					return buildRpcReplyBuffer(xid, w.toBuffer());
				}

				// Close the connection instead of replying
				setTimeout(() => socket.destroy(), 10);

				return null;
			});

			try {
				const session = await vxi11.vxi11Connect('127.0.0.1', port, 'inst0', 3000);

				await assert.rejects(
					() => session.send('*IDN?'),
					/Connection closed during RPC/,
				);
				await session.close();
			} finally {
				server.close();
			}
		});

		it('should reject on socket error event during RPC.', async () => {
			let callCount = 0;
			const { server, port } = await createFakeVxi11Server((xid) => {
				callCount++;

				if (callCount === 1) {
					// create_link: success
					const w = new rpc.XdrWriter(16);

					w.writeInt32(0);
					w.writeInt32(1);
					w.writeUInt32(0);
					w.writeUInt32(0x100000);

					return buildRpcReplyBuffer(xid, w.toBuffer());
				}

				// Don't reply — client will be stuck waiting
				return null;
			});

			try {
				const session = await vxi11.vxi11Connect('127.0.0.1', port, 'inst0', 5000);

				const sendPromise = session.send('*IDN?');

				// Destroy socket with error to trigger onError in tcpSendAndReceive
				setTimeout(() => session._socket.destroy(new Error('simulated RPC error')), 50);

				await assert.rejects(sendPromise, /simulated RPC error/);
				await session.close();
			} finally {
				server.close();
			}
		});

		it('should handle partial fragment delivery in tryResolve.', async () => {
			const { server, port } = await createFakeVxi11Server((xid, record, socket) => {
				// create_link: send reply in two pieces to force tryResolve to return false
				const w = new rpc.XdrWriter(16);

				w.writeInt32(0);
				w.writeInt32(1);
				w.writeUInt32(0);
				w.writeUInt32(0x100000);

				const reply = buildRpcReplyBuffer(xid, w.toBuffer());
				const half = Math.floor(reply.length / 2);

				socket.write(reply.subarray(0, half));
				setTimeout(() => socket.write(reply.subarray(half)), 30);

				return null; // already written manually
			});

			try {
				const session = await vxi11.vxi11Connect('127.0.0.1', port, 'inst0', 3000);

				await session.close();
			} finally {
				server.close();
			}
		});

		it('should reject when portmapper returns port 0.', async () => {
			const { server: pmServer, port: pmPort } = await createFakeVxi11Server((xid) => {
				// Return port 0 as portmapper response
				const portPayload = Buffer.alloc(4);

				portPayload.writeUInt32BE(0, 0);

				return buildRpcReplyBuffer(xid, portPayload);
			});

			try {
				await assert.rejects(
					() => vxi11.vxi11Connect('127.0.0.1', 0, 'inst0', 3000, pmPort),
					/Failed to get VXI-11 port from portmapper/,
				);
			} finally {
				pmServer.close();
			}
		});

		it('should use default maxReceiveSize when create_link returns 0.', async () => {
			let callCount = 0;
			const { server, port } = await createFakeVxi11Server((xid) => {
				callCount++;

				if (callCount === 1) {
					// create_link: success with maxReceiveSize=0
					const w = new rpc.XdrWriter(16);

					w.writeInt32(0);     // error = 0
					w.writeInt32(1);     // linkId
					w.writeUInt32(0);    // abortPort
					w.writeUInt32(0);    // maxReceiveSize = 0

					return buildRpcReplyBuffer(xid, w.toBuffer());
				}

				if (callCount === 2) {
					// device_write: success
					const w = new rpc.XdrWriter(8);

					w.writeInt32(0);
					w.writeUInt32(5);

					return buildRpcReplyBuffer(xid, w.toBuffer());
				}

				// device_read: success with END
				const w = new rpc.XdrWriter(12);

				w.writeInt32(0);
				w.writeInt32(4); // VXI11_READ_REASON_END
				w.writeOpaque(Buffer.from('OK'));

				return buildRpcReplyBuffer(xid, w.toBuffer());
			});

			try {
				const session = await vxi11.vxi11Connect('127.0.0.1', port, 'inst0', 3000);

				await session.send('*IDN?');
				const buf = await session.receive();

				assert.equal(buf.toString(), 'OK');
				await session.close();
			} finally {
				server.close();
			}
		});
	});
});

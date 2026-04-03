import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { MockDevice } from '@produck/vxi-mock-device';
import { lxi } from '@produck/lxi-tools-node';

describe('lxi', () => {
	let mock;

	before(async () => {
		mock = new MockDevice({ identity: 'TEST,LxiTest,SN0001,1.0' });
		mock.handle(':CHAN1:DISP?', () => 'ON');
		await mock.start();
	});

	after(async () => {
		await mock.stop();
	});

	describe('.Protocol', () => {
		it('should expose VXI11 constant.', () => {
			assert.equal(lxi.Protocol.VXI11, 'VXI11');
		});

		it('should expose RAW constant.', () => {
			assert.equal(lxi.Protocol.RAW, 'RAW');
		});

		it('should be frozen.', () => {
			assert.ok(Object.isFrozen(lxi.Protocol));
		});
	});

	describe('.connect()', () => {
		it('should return a numeric device handle.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.vxi11Port, 'inst0', 3000, 'VXI11');

			assert.equal(typeof dev, 'number');
			await lxi.disconnect(dev);
		});

		it('should reject on unreachable address.', async () => {
			await assert.rejects(
				() => lxi.connect('127.0.0.1', 1, 'inst0', 500, 'VXI11'),
			);
		});
	});

	describe('.send()', () => {
		it('should return the number of bytes sent.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.vxi11Port, 'inst0', 3000, 'VXI11');
			const bytes = await lxi.send(dev, '*IDN?');

			assert.equal(typeof bytes, 'number');
			assert.ok(bytes > 0);
			await lxi.receive(dev); // consume response
			await lxi.disconnect(dev);
		});

		it('should reject on invalid device handle.', async () => {
			await assert.rejects(
				() => lxi.send(999999, '*IDN?'),
				/Invalid device handle/,
			);
		});
	});

	describe('.receive()', () => {
		it('should return a Buffer.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.vxi11Port, 'inst0', 3000, 'VXI11');

			await lxi.send(dev, '*IDN?');
			const buf = await lxi.receive(dev);

			assert.ok(Buffer.isBuffer(buf));
			assert.ok(buf.length > 0);
			await lxi.disconnect(dev);
		});

		it('should contain the expected identity string.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.vxi11Port, 'inst0', 3000, 'VXI11');

			await lxi.send(dev, '*IDN?');
			const buf = await lxi.receive(dev);

			assert.equal(buf.toString().trim(), 'TEST,LxiTest,SN0001,1.0');
			await lxi.disconnect(dev);
		});

		it('should reject on invalid device handle.', async () => {
			await assert.rejects(
				() => lxi.receive(999999),
				/Invalid device handle/,
			);
		});
	});

	describe('.disconnect()', () => {
		it('should resolve silently for a valid handle.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.vxi11Port, 'inst0', 3000, 'VXI11');

			await assert.doesNotReject(() => lxi.disconnect(dev));
		});

		it('should resolve silently for an invalid handle.', async () => {
			await assert.doesNotReject(() => lxi.disconnect(999999));
		});
	});

	describe('.getSessionInfo()', () => {
		it('should return session info for a connected device.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.vxi11Port, 'inst0', 3000, 'VXI11');
			const info = lxi.getSessionInfo(dev);

			assert.equal(info.protocol, 'VXI11');
			assert.equal(info.timeout, 3000);
			await lxi.disconnect(dev);
		});

		it('should return undefined for an invalid handle.', () => {
			assert.equal(lxi.getSessionInfo(999999), undefined);
		});
	});

	describe('multi-command session', () => {
		it('should support multiple send/receive on one connection.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.vxi11Port, 'inst0', 3000, 'VXI11');

			await lxi.send(dev, '*IDN?');
			const r1 = await lxi.receive(dev);

			assert.equal(r1.toString().trim(), 'TEST,LxiTest,SN0001,1.0');

			await lxi.send(dev, ':CHAN1:DISP?');
			const r2 = await lxi.receive(dev);

			assert.equal(r2.toString().trim(), 'ON');

			await lxi.disconnect(dev);
		});
	});

	describe('RAW protocol', () => {
		it('should connect via RAW protocol.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.rawPort, 'inst0', 3000, 'RAW');

			assert.equal(typeof dev, 'number');
			await lxi.disconnect(dev);
		});

		it('should send and receive via RAW protocol.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.rawPort, 'inst0', 3000, 'RAW');

			await lxi.send(dev, '*IDN?\n');
			const buf = await lxi.receive(dev);

			assert.ok(buf.toString().includes('TEST,LxiTest,SN0001,1.0'));
			await lxi.disconnect(dev);
		});

		it('should send Buffer via RAW protocol.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.rawPort, 'inst0', 3000, 'RAW');

			await lxi.send(dev, Buffer.from('*IDN?\n'));
			const buf = await lxi.receive(dev);

			assert.ok(buf.toString().includes('TEST,LxiTest,SN0001,1.0'));
			await lxi.disconnect(dev);
		});

		it('should report RAW in getSessionInfo.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.rawPort, 'inst0', 3000, 'RAW');
			const info = lxi.getSessionInfo(dev);

			assert.equal(info.protocol, 'RAW');
			await lxi.disconnect(dev);
		});

		it('should reject on unreachable RAW port.', async () => {
			await assert.rejects(
				() => lxi.connect('127.0.0.1', 1, 'inst0', 500, 'RAW'),
			);
		});

		it('should use default RAW port when port is 0.', async () => {
			await assert.rejects(
				() => lxi.connect('127.0.0.1', 0, 'inst0', 500, 'RAW'),
			);
		});

		it('should receive response terminated by newline.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.rawPort, 'inst0', 3000, 'RAW');

			await lxi.send(dev, ':CHAN1:DISP?\n');
			const buf = await lxi.receive(dev);

			assert.ok(buf.toString().includes('ON'));
			await lxi.disconnect(dev);
		});
	});

	describe('RAW receive edge cases', () => {
		it('should reject on receive timeout with no data.', async () => {
			// Create a server that accepts but never sends data
			const silentServer = net.createServer(() => {});

			await new Promise((r) => silentServer.listen(0, '127.0.0.1', r));
			const port = silentServer.address().port;

			const dev = await lxi.connect('127.0.0.1', port, 'inst0', 3000, 'RAW');

			await assert.rejects(
				() => lxi.receive(dev, 1024, 200),
				/Receive timed out/,
			);

			await lxi.disconnect(dev);
			silentServer.close();
		});

		it('should resolve with partial data on timeout.', async () => {
			// Create a server that sends partial data (no newline) then goes silent
			const partialServer = net.createServer((socket) => {
				socket.write(Buffer.from('partial'));
			});

			await new Promise((r) => partialServer.listen(0, '127.0.0.1', r));
			const port = partialServer.address().port;

			const dev = await lxi.connect('127.0.0.1', port, 'inst0', 3000, 'RAW');
			const buf = await lxi.receive(dev, 1024, 300);

			assert.ok(buf.toString().includes('partial'));
			await lxi.disconnect(dev);
			partialServer.close();
		});

		it('should resolve when response exceeds maxLength.', async () => {
			// Register a handler that returns a large buffer
			mock.handle('BIGDATA', () => Buffer.from('X'.repeat(200) + '\n'));

			const dev = await lxi.connect('127.0.0.1', mock.rawPort, 'inst0', 3000, 'RAW');

			await lxi.send(dev, 'BIGDATA\n');
			const buf = await lxi.receive(dev, 10, 3000);

			assert.ok(buf.length >= 10);
			await lxi.disconnect(dev);
		});

		it('should reject when socket is closed with no data.', async () => {
			// Create a server that immediately closes the connection
			const closeServer = net.createServer((socket) => {
				socket.end();
			});

			await new Promise((r) => closeServer.listen(0, '127.0.0.1', r));
			const port = closeServer.address().port;

			const dev = await lxi.connect('127.0.0.1', port, 'inst0', 3000, 'RAW');

			await assert.rejects(
				() => lxi.receive(dev, 1024, 3000),
				/Connection closed/,
			);

			await lxi.disconnect(dev);
			closeServer.close();
		});

		it('should resolve with data when socket is closed.', async () => {
			// Create a server that sends data then closes
			const dataCloseServer = net.createServer((socket) => {
				socket.write(Buffer.from('hello'));
				socket.end();
			});

			await new Promise((r) => dataCloseServer.listen(0, '127.0.0.1', r));
			const port = dataCloseServer.address().port;

			const dev = await lxi.connect('127.0.0.1', port, 'inst0', 3000, 'RAW');
			const buf = await lxi.receive(dev, 1024, 3000);

			assert.ok(buf.toString().includes('hello'));
			await lxi.disconnect(dev);
			dataCloseServer.close();
		});

		it('should reject on socket error.', async () => {
			// Create a server that resets the connection
			const errorServer = net.createServer((socket) => {
				socket.destroy();
			});

			await new Promise((r) => errorServer.listen(0, '127.0.0.1', r));
			const port = errorServer.address().port;

			const dev = await lxi.connect('127.0.0.1', port, 'inst0', 3000, 'RAW');

			await assert.rejects(
				() => lxi.receive(dev, 1024, 3000),
			);

			await lxi.disconnect(dev);
			errorServer.close();
		});

		it('should reject on socket error event during RAW receive.', async () => {
			// Create a server that accepts but never sends data
			const silentServer = net.createServer(() => {});

			await new Promise((r) => silentServer.listen(0, '127.0.0.1', r));
			const port = silentServer.address().port;

			const dev = await lxi.connect('127.0.0.1', port, 'inst0', 3000, 'RAW');
			const info = lxi.getSessionInfo(dev);

			// Start receive (will block since server is silent)
			const receivePromise = lxi.receive(dev, 1024, 3000);

			// Destroy socket with error to trigger onError handler
			info._session._socket.destroy(new Error('simulated socket error'));

			await assert.rejects(receivePromise, /simulated socket error/);
			await lxi.disconnect(dev);
			silentServer.close();
		});

		it('should reject on RAW connect timeout.', async () => {
			// 192.0.2.1 is TEST-NET, should timeout
			await assert.rejects(
				() => lxi.connect('192.0.2.1', 5025, 'inst0', 200, 'RAW'),
				/timed out/,
			);
		});

		it('should reject on write error during RAW send.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.rawPort, 'inst0', 3000, 'RAW');
			const info = lxi.getSessionInfo(dev);

			// Destroy socket to cause write error
			info._session._socket.destroy();

			await assert.rejects(
				() => lxi.send(dev, 'test'),
			);

			await lxi.disconnect(dev);
		});
	});
});

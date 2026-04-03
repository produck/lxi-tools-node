import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MockDevice } from '@produck/vxi-mock-device';
import { SCPI, lxi } from '@produck/lxi-tools-node';

describe('SCPI', () => {
	let mock;

	before(async () => {
		mock = new MockDevice({ identity: 'TEST,ScpiTest,SN0002,2.0' });
		mock.handle(':MEAS:VOLT?', () => '3.14159');
		mock.handle('*RST', () => null);
		await mock.start();
	});

	after(async () => {
		await mock.stop();
	});

	describe('.isQuery()', () => {
		it('should return true for a query command.', () => {
			assert.equal(SCPI.isQuery('*IDN?'), true);
		});

		it('should return true when "?" appears mid-string.', () => {
			assert.equal(SCPI.isQuery(':MEAS:VOLT? MAX'), true);
		});

		it('should return false for a set command.', () => {
			assert.equal(SCPI.isQuery('*RST'), false);
		});

		it('should return false for an empty string.', () => {
			assert.equal(SCPI.isQuery(''), false);
		});
	});

	describe('.scpi()', () => {
		it('should return identity string for *IDN? query.', async () => {
			const result = await SCPI.scpi('127.0.0.1', {
				command: '*IDN?',
				port: mock.vxi11Port,
			});

			assert.equal(result, 'TEST,ScpiTest,SN0002,2.0');
		});

		it('should use default port when port is not specified.', async () => {
			// Without port, uses port 0 which triggers portmapper on 111
			await assert.rejects(
				() => SCPI.scpi('127.0.0.1', { command: '*IDN?', timeout: 500 }),
			);
		});

		it('should return null for a set command.', async () => {
			const result = await SCPI.scpi('127.0.0.1', {
				command: '*RST',
				port: mock.vxi11Port,
			});

			assert.equal(result, null);
		});

		it('should return measurement value.', async () => {
			const result = await SCPI.scpi('127.0.0.1', {
				command: ':MEAS:VOLT?',
				port: mock.vxi11Port,
			});

			assert.equal(result, '3.14159');
		});

		it('should reject when command is missing.', async () => {
			await assert.rejects(
				() => SCPI.scpi('127.0.0.1', { port: mock.vxi11Port }),
				/Missing SCPI command/,
			);
		});

		it('should strip trailing whitespace from command.', async () => {
			const result = await SCPI.scpi('127.0.0.1', {
				command: '*IDN?   ',
				port: mock.vxi11Port,
			});

			assert.equal(result, 'TEST,ScpiTest,SN0002,2.0');
		});
	});

	describe('.scpiOnDevice()', () => {
		it('should send a query on an existing connection.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.vxi11Port, 'inst0', 3000, 'VXI11');

			const result = await SCPI.scpiOnDevice(dev, '*IDN?');

			assert.equal(result, 'TEST,ScpiTest,SN0002,2.0');
			await lxi.disconnect(dev);
		});

		it('should return null for set commands.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.vxi11Port, 'inst0', 3000, 'VXI11');

			const result = await SCPI.scpiOnDevice(dev, '*RST');

			assert.equal(result, null);
			await lxi.disconnect(dev);
		});

		it('should reject on invalid device handle.', async () => {
			await assert.rejects(
				() => SCPI.scpiOnDevice(999999, '*IDN?'),
				/Invalid device handle/,
			);
		});

		it('should support multiple commands on one session.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.vxi11Port, 'inst0', 3000, 'VXI11');

			const id = await SCPI.scpiOnDevice(dev, '*IDN?');
			const volt = await SCPI.scpiOnDevice(dev, ':MEAS:VOLT?');

			assert.equal(id, 'TEST,ScpiTest,SN0002,2.0');
			assert.equal(volt, '3.14159');
			await lxi.disconnect(dev);
		});
	});

	describe('.scpiRaw()', () => {
		it('should return a Buffer for a query.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.vxi11Port, 'inst0', 3000, 'VXI11');

			const buf = await SCPI.scpiRaw(dev, '*IDN?');

			assert.ok(Buffer.isBuffer(buf));
			assert.ok(buf.toString().includes('TEST,ScpiTest'));
			await lxi.disconnect(dev);
		});

		it('should accept a Buffer as command.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.vxi11Port, 'inst0', 3000, 'VXI11');

			const buf = await SCPI.scpiRaw(dev, Buffer.from('*IDN?'));

			assert.ok(Buffer.isBuffer(buf));
			assert.ok(buf.toString().includes('TEST,ScpiTest'));
			await lxi.disconnect(dev);
		});

		it('should return null for a set command.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.vxi11Port, 'inst0', 3000, 'VXI11');

			const result = await SCPI.scpiRaw(dev, '*RST');

			assert.equal(result, null);
			await lxi.disconnect(dev);
		});
	});

	describe('.scpiOnDevice() with RAW protocol', () => {
		it('should query via RAW and auto-append newline.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.rawPort, 'inst0', 3000, 'RAW');

			const result = await SCPI.scpiOnDevice(dev, '*IDN?');

			assert.equal(result, 'TEST,ScpiTest,SN0002,2.0');
			await lxi.disconnect(dev);
		});

		it('should return null for set command via RAW.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.rawPort, 'inst0', 3000, 'RAW');

			const result = await SCPI.scpiOnDevice(dev, '*RST');

			assert.equal(result, null);
			await lxi.disconnect(dev);
		});
	});

	describe('RAW protocol via .scpi()', () => {
		it('should return identity string via RAW protocol.', async () => {
			const result = await SCPI.scpi('127.0.0.1', {
				command: '*IDN?',
				port: mock.rawPort,
				protocol: 'RAW',
			});

			assert.equal(result, 'TEST,ScpiTest,SN0002,2.0');
		});

		it('should return measurement value via RAW.', async () => {
			const result = await SCPI.scpi('127.0.0.1', {
				command: ':MEAS:VOLT?',
				port: mock.rawPort,
				protocol: 'RAW',
			});

			assert.equal(result, '3.14159');
		});

		it('should return null for set command via RAW.', async () => {
			const result = await SCPI.scpi('127.0.0.1', {
				command: '*RST',
				port: mock.rawPort,
				protocol: 'RAW',
			});

			assert.equal(result, null);
		});
	});

	describe('RAW protocol via .scpiOnDevice()', () => {
		it('should query via RAW on existing connection.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.rawPort, 'inst0', 3000, 'RAW');
			const result = await SCPI.scpiOnDevice(dev, '*IDN?');

			assert.equal(result, 'TEST,ScpiTest,SN0002,2.0');
			await lxi.disconnect(dev);
		});

		it('should return null for set command via RAW.', async () => {
			const dev = await lxi.connect('127.0.0.1', mock.rawPort, 'inst0', 3000, 'RAW');
			const result = await SCPI.scpiOnDevice(dev, '*RST');

			assert.equal(result, null);
			await lxi.disconnect(dev);
		});
	});
});

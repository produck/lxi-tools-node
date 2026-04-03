import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MockDevice } from '@produck/vxi-mock-device';
import { Benchmark } from '@produck/lxi-tools-node';

describe('Benchmark', () => {
	let mock;

	before(async () => {
		mock = new MockDevice({ identity: 'TEST,BenchTest,SN0003,1.0' });
		await mock.start();
	});

	after(async () => {
		await mock.stop();
	});

	describe('.benchmark()', () => {
		it('should return result with requestsPerSecond, count, elapsed.', async () => {
			const result = await Benchmark.benchmark('127.0.0.1', {
				port: mock.vxi11Port,
				count: 10,
				timeout: 5000,
			});

			assert.equal(typeof result.requestsPerSecond, 'number');
			assert.ok(result.requestsPerSecond > 0);
			assert.equal(result.count, 10);
			assert.equal(typeof result.elapsed, 'number');
			assert.ok(result.elapsed > 0);
		});

		it('should invoke onProgress callback for each request.', async () => {
			const progress = [];
			const result = await Benchmark.benchmark('127.0.0.1', {
				port: mock.vxi11Port,
				count: 5,
				timeout: 5000,
				onProgress: (n) => progress.push(n),
			});

			assert.equal(result.count, 5);
			assert.deepEqual(progress, [1, 2, 3, 4, 5]);
		});

		it('should reject when address is missing.', async () => {
			await assert.rejects(
				() => Benchmark.benchmark(''),
				/Missing address/,
			);
		});

		it('should default to 100 requests.', async () => {
			const result = await Benchmark.benchmark('127.0.0.1', {
				port: mock.vxi11Port,
				timeout: 10000,
			});

			assert.equal(result.count, 100);
		});

		it('should work with RAW protocol.', async () => {
			const result = await Benchmark.benchmark('127.0.0.1', {
				port: mock.rawPort,
				protocol: 'RAW',
				count: 5,
				timeout: 5000,
			});

			assert.equal(result.count, 5);
			assert.ok(result.requestsPerSecond > 0);
		});

		it('should reject when instrument returns empty response.', async () => {
			const emptyMock = new MockDevice();

			emptyMock.handle('*IDN?', () => '');
			await emptyMock.start();

			try {
				await assert.rejects(
					() => Benchmark.benchmark('127.0.0.1', {
						port: emptyMock.vxi11Port,
						count: 1,
						timeout: 5000,
					}),
					/Failed to receive instrument ID/,
				);
			} finally {
				await emptyMock.stop();
			}
		});
	});
});

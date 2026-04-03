/**
 * Benchmark LXI instrument request rate.
 *
 * Mirrors benchmark.c from lxi-tools — repeatedly sends *IDN? and
 * measures requests per second.
 */

import { connect, send, receive, disconnect, Protocol } from './lxi.js';

const ID_LENGTH_MAX = 65536;

/**
 * Benchmark an LXI instrument by sending repeated *IDN? requests.
 *
 * @param {string} address - IP address of the instrument
 * @param {object} [options]
 * @param {number} [options.port=0] - Port (0 = auto)
 * @param {number} [options.timeout=3000] - Timeout in milliseconds
 * @param {string} [options.protocol='VXI11'] - 'VXI11' or 'RAW'
 * @param {number} [options.count=100] - Number of *IDN? requests to send
 * @param {function} [options.onProgress] - Called with (currentCount) after each request
 * @returns {Promise<{ requestsPerSecond: number, count: number, elapsed: number }>}
 */
export async function benchmark(address, options = {}) {
  const port = options.port ?? 0;
  const timeout = options.timeout ?? 3000;
  const protocol = options.protocol ?? Protocol.VXI11;
  const count = options.count ?? 100;
  const onProgress = options.onProgress;

  if (!address) throw new Error('Missing address');

  const command = protocol === Protocol.RAW ? '*IDN?\n' : '*IDN?';

  const device = await connect(address, port, null, timeout, protocol);
  try {
    const start = performance.now();

    for (let i = 0; i < count; i++) {
      await send(device, command, timeout);
      const response = await receive(device, ID_LENGTH_MAX, timeout);
      if (!response || response.length === 0) {
        throw new Error('Failed to receive instrument ID');
      }
      if (onProgress) onProgress(i + 1);
    }

    const end = performance.now();
    const elapsed = (end - start) / 1000; // seconds
    const requestsPerSecond = count / elapsed;

    return { requestsPerSecond, count, elapsed };
  } finally {
    await disconnect(device);
  }
}

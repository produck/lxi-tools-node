/**
 * lxi-tools — JavaScript port
 *
 * A library for managing LXI compatible instruments (oscilloscopes,
 * power supplies, spectrum analyzers, etc.) via VXI-11 and raw TCP.
 *
 * Ported from lxi-tools (C) by Martin Lund.
 *
 * @example
 * import { lxi, discovery, SCPI, Screenshot, Benchmark } from 'lxi-tools';
 *
 * // Discover devices
 * const devices = await discovery.discover({ timeout: 2000 });
 *
 * // Send SCPI command
 * const id = await SCPI.scpi('10.0.0.42', { command: '*IDN?' });
 *
 * // Low-level connection
 * const device = await lxi.connect('10.0.0.42');
 * await lxi.send(device, '*IDN?');
 * const response = await lxi.receive(device);
 * await lxi.disconnect(device);
 *
 * // Screenshot
 * const image = await Screenshot.screenshot('10.0.0.42');
 * fs.writeFileSync(`screenshot.${image.format}`, image.data);
 *
 * // Benchmark
 * const result = await Benchmark.benchmark('10.0.0.42', { count: 50 });
 * console.log(`${result.requestsPerSecond} req/s`);
 */

// Core LXI connection
export * as lxi from './lxi.mjs';

// Discovery
export * as discovery from './discover.mjs';

// SCPI
export * as SCPI from './scpi.mjs';

// Benchmark
export * as Benchmark from './benchmark.mjs';

// Screenshot
export * as Screenshot from './screenshot.mjs';

// VXI-11 low-level (for advanced usage)
export * as vxi11 from './vxi11.mjs';

// RPC/XDR utilities (for advanced usage)
export * as rpc from './rpc.mjs';

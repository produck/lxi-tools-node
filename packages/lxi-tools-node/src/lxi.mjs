/**
 * Core LXI connection management.
 *
 * Mirrors liblxi's lxi_connect / lxi_send / lxi_receive / lxi_disconnect
 * Supports VXI11 and RAW (TCP) protocols.
 */

import net from 'node:net';
import { vxi11Connect } from './vxi11.mjs';

export const Protocol = Object.freeze({
  VXI11: 'VXI11',
  RAW: 'RAW',
});

const DEFAULT_PORT_VXI11 = 111;
const DEFAULT_PORT_RAW = 5025;
const RESPONSE_LENGTH_MAX = 0x500000; // 5 MB

// --- RAW TCP Session ---

class RawSession {
  constructor(socket, timeout) {
    this._socket = socket;
    this._timeout = timeout;
  }

  async send(data, timeout) {
    const effectiveTimeout = timeout || this._timeout;
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Send timed out')), effectiveTimeout);
      this._socket.write(buffer, (err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(buffer.length);
      });
    });
  }

  async receive(maxLength, timeout) {
    const effectiveTimeout = timeout || this._timeout;
    const effectiveMaxLength = maxLength || RESPONSE_LENGTH_MAX;
    const socket = this._socket;
    return new Promise((resolve, reject) => {
      const chunks = [];
      let totalLength = 0;

      function cleanup() {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
      }

      const timer = setTimeout(() => {
        cleanup();
        if (totalLength > 0) {
          resolve(Buffer.concat(chunks, totalLength));
        } else {
          reject(new Error('Receive timed out'));
        }
      }, effectiveTimeout);

      function onData(chunk) {
        chunks.push(chunk);
        totalLength += chunk.length;
        if (totalLength >= effectiveMaxLength) {
          cleanup();
          resolve(Buffer.concat(chunks, totalLength));
          return;
        }
        // For raw TCP, if we received a newline, the message is likely complete
        if (chunk[chunk.length - 1] === 0x0a) {
          cleanup();
          resolve(Buffer.concat(chunks, totalLength));
        }
      }

      function onError(err) {
        cleanup();
        reject(err);
      }

      function onClose() {
        cleanup();
        if (totalLength > 0) {
          resolve(Buffer.concat(chunks, totalLength));
        } else {
          reject(new Error('Connection closed'));
        }
      }

      socket.on('data', onData);
      socket.once('error', onError);
      socket.once('close', onClose);
    });
  }

  async close() {
    this._socket.destroy();
  }
}

async function rawConnect(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Connection to ${host}:${port} timed out`));
    }, timeout);

    socket.connect(port, host, () => {
      clearTimeout(timer);
      resolve(new RawSession(socket, timeout));
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// --- LXI Device Handle ---

let _nextDeviceId = 0;
const _sessions = new Map();

/**
 * Connect to an LXI instrument.
 * @param {string} address - IP address or hostname
 * @param {number} [port=0] - Port (0 = auto: 111 for VXI11, 5025 for RAW)
 * @param {string} [name='inst0'] - VXI-11 device name
 * @param {number} [timeout=3000] - Timeout in milliseconds
 * @param {string} [protocol='VXI11'] - 'VXI11' or 'RAW'
 * @returns {Promise<number>} Device handle (integer)
 */
export async function connect(address, port = 0, name = 'inst0', timeout = 3000, protocol = Protocol.VXI11) {
  let session;

  if (protocol === Protocol.RAW) {
    const effectivePort = port || DEFAULT_PORT_RAW;
    session = await rawConnect(address, effectivePort, timeout);
  } else {
    const effectivePort = port || DEFAULT_PORT_VXI11;
    session = await vxi11Connect(address, effectivePort, name, timeout);
  }

  const id = _nextDeviceId++;
  _sessions.set(id, { session, protocol, timeout });
  return id;
}

/**
 * Send data to a connected LXI instrument.
 * @param {number} device - Device handle from connect()
 * @param {string|Buffer} command - Data to send
 * @param {number} [timeout] - Timeout in milliseconds
 * @returns {Promise<number>} Bytes sent
 */
export async function send(device, command, timeout) {
  const entry = _sessions.get(device);
  if (!entry) throw new Error(`Invalid device handle: ${device}`);
  return entry.session.send(command, timeout || entry.timeout);
}

/**
 * Receive data from a connected LXI instrument.
 * @param {number} device - Device handle from connect()
 * @param {number} [maxLength=5242880] - Maximum response length
 * @param {number} [timeout] - Timeout in milliseconds
 * @returns {Promise<Buffer>} Response data
 */
export async function receive(device, maxLength = RESPONSE_LENGTH_MAX, timeout) {
  const entry = _sessions.get(device);
  if (!entry) throw new Error(`Invalid device handle: ${device}`);
  return entry.session.receive(maxLength, timeout || entry.timeout);
}

/**
 * Disconnect from an LXI instrument.
 * @param {number} device - Device handle from connect()
 */
export async function disconnect(device) {
  const entry = _sessions.get(device);
  if (!entry) return;
  _sessions.delete(device);
  await entry.session.close();
}

/**
 * Get session info for a device.
 * @param {number} device - Device handle
 * @returns {{ protocol: string, timeout: number } | undefined}
 */
export function getSessionInfo(device) {
  const entry = _sessions.get(device);
  if (!entry) return undefined;
  return { protocol: entry.protocol, timeout: entry.timeout };
}

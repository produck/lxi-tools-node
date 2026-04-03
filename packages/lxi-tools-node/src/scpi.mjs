/**
 * SCPI command helper.
 *
 * Mirrors scpi.c from lxi-tools — send SCPI commands and receive responses.
 */

import { connect, send, receive, disconnect, Protocol, getSessionInfo } from './lxi.js';

const RESPONSE_LENGTH_MAX = 0x500000;

/**
 * Check if a SCPI command is a query (contains '?').
 * @param {string} command
 * @returns {boolean}
 */
export function isQuery(command) {
  return command.includes('?');
}

/**
 * Send a SCPI command to an LXI instrument and optionally receive a response.
 *
 * @param {string} address - IP address of the instrument
 * @param {object} [options]
 * @param {number} [options.port=0] - Port (0 = auto)
 * @param {number} [options.timeout=3000] - Timeout in milliseconds
 * @param {string} [options.protocol='VXI11'] - 'VXI11' or 'RAW'
 * @param {string} options.command - SCPI command string
 * @returns {Promise<string|null>} Response string if query, null if command
 */
export async function scpi(address, options = {}) {
  const port = options.port ?? 0;
  const timeout = options.timeout ?? 3000;
  const protocol = options.protocol ?? Protocol.VXI11;
  let command = options.command;

  if (!command) throw new Error('Missing SCPI command');

  // Strip trailing spaces
  command = command.trimEnd();

  // For RAW protocol, append newline
  if (protocol === Protocol.RAW) {
    command = command + '\n';
  }

  const device = await connect(address, port, null, timeout, protocol);
  try {
    await send(device, command, timeout);

    if (isQuery(command)) {
      const response = await receive(device, RESPONSE_LENGTH_MAX, timeout);
      let text = response.toString();
      // Strip trailing newline/carriage return
      text = text.replace(/[\r\n]+$/, '');
      return text;
    }
    return null;
  } finally {
    await disconnect(device);
  }
}

/**
 * Send a SCPI command on an already-connected device and get the response.
 * Useful for interactive / multi-command sessions.
 *
 * @param {number} device - Device handle from lxi.connect()
 * @param {string} command - SCPI command
 * @param {number} [timeout] - Override session timeout
 * @returns {Promise<string|null>} Response string if query, null otherwise
 */
export async function scpiOnDevice(device, command, timeout) {
  const info = getSessionInfo(device);
  if (!info) throw new Error(`Invalid device handle: ${device}`);

  command = command.trimEnd();

  // For RAW protocol, append newline
  if (info.protocol === Protocol.RAW) {
    command = command + '\n';
  }

  await send(device, command, timeout);

  if (isQuery(command)) {
    const response = await receive(device, RESPONSE_LENGTH_MAX, timeout);
    let text = response.toString();
    text = text.replace(/[\r\n]+$/, '');
    return text;
  }
  return null;
}

/**
 * Send a raw SCPI command (no newline appended, no response stripping).
 * Returns the raw Buffer response.
 *
 * @param {number} device - Device handle
 * @param {string|Buffer} command - Raw command data
 * @param {number} [timeout]
 * @returns {Promise<Buffer|null>} Raw response buffer if query, null otherwise
 */
export async function scpiRaw(device, command, timeout) {
  const commandString = Buffer.isBuffer(command) ? command.toString() : command;
  await send(device, command, timeout);

  if (isQuery(commandString)) {
    return receive(device, RESPONSE_LENGTH_MAX, timeout);
  }
  return null;
}

/**
 * VXI-11 protocol implementation over TCP.
 *
 * VXI-11 is built on ONC-RPC. This module implements the core channel
 * procedures: create_link, device_write, device_read, destroy_link.
 *
 * Reference: VXI-11 specification (TCP/IP Instrument Protocol)
 */

import net from 'node:net';
import {
  XdrWriter,
  XdrReader,
  buildRpcCall,
  parseRpcReply,
  buildPortmapperGetPort,
  parsePortmapperGetPortReply,
  wrapRecordMarking,
} from './rpc.js';

// VXI-11 Core Channel
const VXI11_CORE_PROGRAM = 0x0607af; // 395183
const VXI11_CORE_VERSION = 1;

// VXI-11 Procedures
const CREATE_LINK = 10;
const DEVICE_WRITE = 11;
const DEVICE_READ = 12;
const DESTROY_LINK = 23;

// Flags
const VXI11_FLAG_END = 0x08;
const VXI11_READ_REASON_END = 0x04;

// --- TCP helpers ---

function tcpConnect(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Connection to ${host}:${port} timed out`));
    }, timeout);

    socket.connect(port, host, () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function tcpSendAndReceive(socket, data, timeout) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;
    let expectedLength = -1;

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('RPC receive timed out'));
    }, timeout);

    function onData(chunk) {
      chunks.push(chunk);
      totalLength += chunk.length;

      // Parse record marking header to know total expected length
      if (expectedLength < 0 && totalLength >= 4) {
        const combined = Buffer.concat(chunks);
        const header = combined.readUInt32BE(0);
        expectedLength = (header & 0x7fffffff) + 4; // fragment length + 4 byte header
      }

      if (expectedLength > 0 && totalLength >= expectedLength) {
        cleanup();
        const combined = Buffer.concat(chunks);
        // Strip record marking header
        const header = combined.readUInt32BE(0);
        const fragmentLength = header & 0x7fffffff;
        resolve(combined.subarray(4, 4 + fragmentLength));
      }
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    function onClose() {
      cleanup();
      reject(new Error('Connection closed during RPC'));
    }

    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    }

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);

    socket.write(data);
  });
}

// --- Portmapper ---

export async function getVxi11Port(host, timeout = 3000) {
  const socket = await tcpConnect(host, 111, timeout);
  try {
    const { buffer } = buildPortmapperGetPort(VXI11_CORE_PROGRAM, VXI11_CORE_VERSION);
    const rpcBuffer = wrapRecordMarking(buffer);
    const replyBuffer = await tcpSendAndReceive(socket, rpcBuffer, timeout);
    const { payload } = parseRpcReply(replyBuffer);
    return parsePortmapperGetPortReply(payload);
  } finally {
    socket.destroy();
  }
}

// --- VXI-11 Core Procedures ---

function buildCreateLink(clientId, lockDevice, lockTimeout, device) {
  const writer = new XdrWriter(64);
  writer.writeInt32(clientId);
  writer.writeInt32(lockDevice ? 1 : 0);
  writer.writeUInt32(lockTimeout);
  writer.writeString(device);
  return writer.toBuffer();
}

function parseCreateLinkReply(payload) {
  const reader = new XdrReader(payload);
  const error = reader.readInt32();
  const linkId = reader.readInt32();
  const abortPort = reader.readUInt32();
  const maxReceiveSize = reader.readUInt32();
  return { error, linkId, abortPort, maxReceiveSize };
}

function buildDeviceWrite(linkId, ioTimeout, lockTimeout, flags, data) {
  const writer = new XdrWriter(64 + data.length);
  writer.writeInt32(linkId);
  writer.writeUInt32(ioTimeout);
  writer.writeUInt32(lockTimeout);
  writer.writeInt32(flags);
  writer.writeOpaque(data);
  return writer.toBuffer();
}

function parseDeviceWriteReply(payload) {
  const reader = new XdrReader(payload);
  const error = reader.readInt32();
  const size = reader.readUInt32();
  return { error, size };
}

function buildDeviceRead(linkId, requestSize, ioTimeout, lockTimeout, flags, terminationCharacter) {
  const writer = new XdrWriter(24);
  writer.writeInt32(linkId);
  writer.writeUInt32(requestSize);
  writer.writeUInt32(ioTimeout);
  writer.writeUInt32(lockTimeout);
  writer.writeInt32(flags);
  writer.writeInt32(terminationCharacter);
  return writer.toBuffer();
}

function parseDeviceReadReply(payload) {
  const reader = new XdrReader(payload);
  const error = reader.readInt32();
  const reason = reader.readInt32();
  const data = reader.readOpaque();
  return { error, reason, data };
}

function buildDestroyLink(linkId) {
  const writer = new XdrWriter(4);
  writer.writeInt32(linkId);
  return writer.toBuffer();
}

function parseDestroyLinkReply(payload) {
  const reader = new XdrReader(payload);
  return { error: reader.readInt32() };
}

// --- VXI-11 Session ---

export class Vxi11Session {
  constructor(socket, linkId, maxReceiveSize, timeout) {
    this._socket = socket;
    this._linkId = linkId;
    this._maxReceiveSize = maxReceiveSize;
    this._timeout = timeout;
  }

  async _rpcCall(procedure, payloadBuffer) {
    const { buffer } = buildRpcCall(VXI11_CORE_PROGRAM, VXI11_CORE_VERSION, procedure, payloadBuffer);
    const rpcBuffer = wrapRecordMarking(buffer);
    const replyBuffer = await tcpSendAndReceive(this._socket, rpcBuffer, this._timeout);
    const { payload } = parseRpcReply(replyBuffer);
    return payload;
  }

  async send(data, timeout) {
    const effectiveTimeout = timeout || this._timeout;
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const payloadBuffer = buildDeviceWrite(this._linkId, effectiveTimeout, effectiveTimeout, VXI11_FLAG_END, buffer);
    const reply = parseDeviceWriteReply(await this._rpcCall(DEVICE_WRITE, payloadBuffer));
    if (reply.error !== 0) {
      throw new Error(`VXI-11 device_write error: ${reply.error}`);
    }
    return reply.size;
  }

  async receive(maxLength, timeout) {
    const effectiveTimeout = timeout || this._timeout;
    const requestSize = Math.min(maxLength || this._maxReceiveSize, this._maxReceiveSize);
    const allChunks = [];

    while (true) {
      const payloadBuffer = buildDeviceRead(this._linkId, requestSize, effectiveTimeout, effectiveTimeout, 0, 0);
      const reply = parseDeviceReadReply(await this._rpcCall(DEVICE_READ, payloadBuffer));
      if (reply.error !== 0) {
        throw new Error(`VXI-11 device_read error: ${reply.error}`);
      }
      allChunks.push(reply.data);
      // Check if END reason bit is set
      if (reply.reason & VXI11_READ_REASON_END) break;
      if (reply.data.length === 0) break;
    }

    return Buffer.concat(allChunks);
  }

  async close() {
    try {
      const payloadBuffer = buildDestroyLink(this._linkId);
      await this._rpcCall(DESTROY_LINK, payloadBuffer);
    } finally {
      this._socket.destroy();
    }
  }
}

export async function vxi11Connect(host, port, name, timeout) {
  // Resolve VXI-11 port via portmapper if port is 0 or 111
  let vxi11Port = port;
  if (!port || port === 111) {
    vxi11Port = await getVxi11Port(host, timeout);
    if (!vxi11Port) throw new Error('Failed to get VXI-11 port from portmapper');
  }

  const socket = await tcpConnect(host, vxi11Port, timeout);
  try {
    const deviceName = name || 'inst0';
    const clientId = Math.floor(Math.random() * 0x7fffffff);
    const payloadBuffer = buildCreateLink(clientId, false, timeout, deviceName);
    const { buffer } = buildRpcCall(VXI11_CORE_PROGRAM, VXI11_CORE_VERSION, CREATE_LINK, payloadBuffer);
    const rpcBuffer = wrapRecordMarking(buffer);
    const replyBuffer = await tcpSendAndReceive(socket, rpcBuffer, timeout);
    const { payload } = parseRpcReply(replyBuffer);
    const link = parseCreateLinkReply(payload);

    if (link.error !== 0) {
      socket.destroy();
      throw new Error(`VXI-11 create_link error: ${link.error}`);
    }

    return new Vxi11Session(socket, link.linkId, link.maxReceiveSize || 0x100000, timeout);
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

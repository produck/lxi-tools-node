/**
 * LXI device discovery.
 *
 * Supports VXI-11 broadcast discovery (UDP portmapper) and mDNS/DNS-SD.
 * Mirrors discover.c from lxi-tools.
 */

import dgram from 'node:dgram';
import {
  XdrWriter,
  XdrReader,
  buildRpcCall,
  parseRpcReply,
} from './rpc.js';
import { connect, send, receive, disconnect, Protocol } from './lxi.js';
import os from 'node:os';

const PORTMAPPER_PROGRAM = 100000;
const PORTMAPPER_VERSION = 2;
const PORTMAPPER_PROC_GETPORT = 3;
const VXI11_CORE_PROGRAM = 0x0607af;
const VXI11_CORE_VERSION = 1;
const IPPROTO_TCP = 6;

/**
 * Discover LXI devices on the network via VXI-11 broadcast.
 *
 * Broadcasts a portmapper GETPORT request on UDP port 111 to find
 * devices with VXI-11 support, then queries each for its *IDN? string.
 *
 * @param {object} [options]
 * @param {number} [options.timeout=1000] - Discovery timeout in milliseconds
 * @param {function} [options.onBroadcast] - Called with (interfaceName) for each broadcast interface
 * @param {function} [options.onDevice] - Called with ({ address, id }) for each found device
 * @returns {Promise<Array<{ address: string, id: string }>>}
 */
export async function discoverVxi11(options = {}) {
  const timeout = options.timeout ?? 1000;
  const onBroadcast = options.onBroadcast;
  const onDevice = options.onDevice;
  const devices = [];
  const foundAddresses = new Set();

  // Build portmapper GETPORT request for VXI-11
  const writer = new XdrWriter(16);
  writer.writeUInt32(VXI11_CORE_PROGRAM);
  writer.writeUInt32(VXI11_CORE_VERSION);
  writer.writeUInt32(IPPROTO_TCP);
  writer.writeUInt32(0);
  const { buffer } = buildRpcCall(PORTMAPPER_PROGRAM, PORTMAPPER_VERSION, PORTMAPPER_PROC_GETPORT, writer.toBuffer());

  // Get all broadcast addresses from network interfaces
  const interfaces = os.networkInterfaces();
  const broadcastTargets = [];

  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const interfaceAddress of addresses) {
      if (interfaceAddress.family === 'IPv4' && !interfaceAddress.internal) {
        // Calculate broadcast address from IP and netmask
        const ipParts = interfaceAddress.address.split('.').map(Number);
        const maskParts = interfaceAddress.netmask.split('.').map(Number);
        const broadcast = ipParts.map((ip, i) => (ip | (~maskParts[i] & 255))).join('.');
        broadcastTargets.push({ name, broadcast });
      }
    }
  }

  if (broadcastTargets.length === 0) {
    broadcastTargets.push({ name: 'default', broadcast: '255.255.255.255' });
  }

  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    socket.on('message', async (message, remoteInfo) => {
      if (foundAddresses.has(remoteInfo.address)) return;
      foundAddresses.add(remoteInfo.address);

      // Try to get device ID via SCPI *IDN?
      let id = 'Unknown';
      try {
        const device = await connect(remoteInfo.address, 0, 'inst0', 3000, Protocol.VXI11);
        try {
          await send(device, '*IDN?');
          const response = await receive(device, 65536, 3000);
          id = response.toString().trim();
        } finally {
          await disconnect(device);
        }
      } catch {
        // Could not query ID, just record address
      }

      const device = { address: remoteInfo.address, id };
      devices.push(device);
      if (onDevice) onDevice(device);
    });

    socket.bind(0, () => {
      socket.setBroadcast(true);

      for (const target of broadcastTargets) {
        if (onBroadcast) onBroadcast(target.name);
        socket.send(buffer, 0, buffer.length, 111, target.broadcast);
      }

      setTimeout(() => {
        socket.close();
        resolve(devices);
      }, timeout);
    });
  });
}

/**
 * Discover LXI devices via mDNS/DNS-SD.
 *
 * Sends mDNS queries for _lxi._tcp.local and _vxi-11._tcp.local services.
 *
 * @param {object} [options]
 * @param {number} [options.timeout=5000] - Discovery timeout in milliseconds
 * @param {function} [options.onService] - Called with ({ address, id, service, port }) for each found service
 * @returns {Promise<Array<{ address: string, id: string, service: string, port: number }>>}
 */
export async function discoverMdns(options = {}) {
  const timeout = options.timeout ?? 5000;
  const onService = options.onService;
  const services = [];
  const foundKeys = new Set();

  const MDNS_ADDR = '224.0.0.251';
  const MDNS_PORT = 5353;

  // Build mDNS PTR query for _lxi._tcp.local
  function buildMdnsQuery(serviceName) {
    const parts = serviceName.split('.');
    const labels = [];
    for (const part of parts) {
      labels.push(Buffer.from([part.length]));
      labels.push(Buffer.from(part));
    }
    labels.push(Buffer.from([0])); // root label

    const header = Buffer.alloc(12);
    header.writeUInt16BE(0, 0);  // Transaction ID
    header.writeUInt16BE(0, 2);  // Flags
    header.writeUInt16BE(1, 4);  // Questions
    header.writeUInt16BE(0, 6);  // Answer RRs
    header.writeUInt16BE(0, 8);  // Authority RRs
    header.writeUInt16BE(0, 10); // Additional RRs

    const questionName = Buffer.concat(labels);
    const questionType = Buffer.alloc(4);
    questionType.writeUInt16BE(12, 0); // PTR
    questionType.writeUInt16BE(1, 2);  // IN class

    return Buffer.concat([header, questionName, questionType]);
  }

  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    socket.on('message', (message, remoteInfo) => {
      // Basic mDNS parsing - extract service info from answers
      try {
        const parsed = parseMdnsResponse(message);
        for (const record of parsed) {
          const key = `${remoteInfo.address}:${record.service}:${record.port}`;
          if (foundKeys.has(key)) continue;
          foundKeys.add(key);

          const entry = {
            address: record.address || remoteInfo.address,
            id: record.name || 'Unknown',
            service: record.service || '_lxi._tcp',
            port: record.port || 0,
          };
          services.push(entry);
          if (onService) onService(entry);
        }
      } catch {
        // Ignore unparseable responses
      }
    });

    socket.bind(0, () => {
      try { socket.addMembership(MDNS_ADDR); } catch { /* ignore */ }

      const queries = [
        buildMdnsQuery('_lxi._tcp.local'),
        buildMdnsQuery('_vxi-11._tcp.local'),
      ];

      for (const query of queries) {
        socket.send(query, 0, query.length, MDNS_PORT, MDNS_ADDR);
      }

      setTimeout(() => {
        socket.close();
        resolve(services);
      }, timeout);
    });
  });
}

/**
 * Discover LXI devices.
 * @param {object} [options]
 * @param {boolean} [options.mdns=false] - Use mDNS/DNS-SD instead of VXI-11 broadcast
 * @param {number} [options.timeout] - Timeout in milliseconds
 * @param {function} [options.onDevice] - Called per device found (VXI-11 mode)
 * @param {function} [options.onService] - Called per service found (mDNS mode)
 * @param {function} [options.onBroadcast] - Called per broadcast interface (VXI-11 mode)
 * @returns {Promise<Array>}
 */
export async function discover(options = {}) {
  if (options.mdns) {
    return discoverMdns(options);
  }
  return discoverVxi11(options);
}

// --- Minimal mDNS response parser ---

function parseMdnsResponse(buffer) {
  const results = [];
  if (buffer.length < 12) return results;

  const answerCount = buffer.readUInt16BE(6);
  const additionalCount = buffer.readUInt16BE(10);

  // Skip header and questions
  let offset = 12;
  const questionCount = buffer.readUInt16BE(4);
  for (let i = 0; i < questionCount && offset < buffer.length; i++) {
    while (offset < buffer.length && buffer[offset] !== 0) {
      if ((buffer[offset] & 0xc0) === 0xc0) { offset += 2; break; }
      offset += buffer[offset] + 1;
    }
    if (offset < buffer.length && buffer[offset] === 0) offset++;
    offset += 4; // QTYPE + QCLASS
  }

  const records = [];

  // Parse answer + additional record sections
  const totalRecords = answerCount + buffer.readUInt16BE(8) + additionalCount;
  for (let i = 0; i < totalRecords && offset < buffer.length - 10; i++) {
    const { name, newOffset } = readDnsName(buffer, offset);
    offset = newOffset;
    if (offset + 10 > buffer.length) break;

    const type = buffer.readUInt16BE(offset);
    offset += 2;
    offset += 2; // class
    offset += 4; // TTL
    const resourceDataLength = buffer.readUInt16BE(offset);
    offset += 2;
    const resourceDataStart = offset;

    if (type === 33 && resourceDataLength >= 6) {
      // SRV record
      const port = buffer.readUInt16BE(offset + 4);
      const { name: target } = readDnsName(buffer, offset + 6);
      records.push({ type: 'SRV', name, port, target });
    } else if (type === 1 && resourceDataLength === 4) {
      // A record
      const address = `${buffer[offset]}.${buffer[offset+1]}.${buffer[offset+2]}.${buffer[offset+3]}`;
      records.push({ type: 'A', name, address });
    } else if (type === 16) {
      // TXT record
      let textOffset = offset;
      const texts = [];
      while (textOffset < offset + resourceDataLength) {
        const textLength = buffer[textOffset++];
        if (textLength > 0 && textOffset + textLength <= offset + resourceDataLength) {
          texts.push(buffer.subarray(textOffset, textOffset + textLength).toString());
        }
        textOffset += textLength;
      }
      records.push({ type: 'TXT', name, texts });
    } else if (type === 12) {
      // PTR record
      const { name: pointerName } = readDnsName(buffer, offset);
      records.push({ type: 'PTR', name, ptr: pointerName });
    }

    offset = resourceDataStart + resourceDataLength;
  }

  // Combine SRV + A records into results
  const serviceRecords = records.filter(record => record.type === 'SRV');
  const aRecords = records.filter(record => record.type === 'A');

  for (const serviceRecord of serviceRecords) {
    const aRecord = aRecords.find(record => record.name === serviceRecord.target);
    results.push({
      name: serviceRecord.name,
      service: serviceRecord.name.replace(/^[^.]+\./, '').replace(/\.local\.?$/, ''),
      port: serviceRecord.port,
      address: aRecord ? aRecord.address : undefined,
    });
  }

  // If no SRV records found but have PTR, still report them
  if (results.length === 0) {
    const pointerRecords = records.filter(record => record.type === 'PTR');
    for (const pointerRecord of pointerRecords) {
      results.push({
        name: pointerRecord.ptr,
        service: pointerRecord.name.replace(/\.local\.?$/, ''),
        port: 0,
        address: undefined,
      });
    }
  }

  return results;
}

function readDnsName(buffer, offset) {
  const labels = [];
  let jumped = false;
  let savedOffset = 0;

  while (offset < buffer.length) {
    const labelLength = buffer[offset];
    if (labelLength === 0) {
      offset++;
      break;
    }
    if ((labelLength & 0xc0) === 0xc0) {
      if (!jumped) savedOffset = offset + 2;
      offset = ((labelLength & 0x3f) << 8) | buffer[offset + 1];
      jumped = true;
      continue;
    }
    offset++;
    if (offset + labelLength > buffer.length) break;
    labels.push(buffer.subarray(offset, offset + labelLength).toString());
    offset += labelLength;
  }

  return {
    name: labels.join('.'),
    newOffset: jumped ? savedOffset : offset,
  };
}

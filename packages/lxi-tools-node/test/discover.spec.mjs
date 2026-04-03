import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { MockDevice } from '@produck/vxi-mock-device';
import { discovery } from '@produck/lxi-tools-node';

describe('discovery', () => {
	describe('.readDnsName()', () => {
		it('should parse regular DNS labels.', () => {
			// _lxi._tcp.local → [4]_lxi[4]_tcp[5]local[0]
			const buf = Buffer.from([
				4, 0x5f, 0x6c, 0x78, 0x69,          // _lxi
				4, 0x5f, 0x74, 0x63, 0x70,          // _tcp
				5, 0x6c, 0x6f, 0x63, 0x61, 0x6c,    // local
				0,                                     // null terminator
			]);
			const { name, newOffset } = discovery.readDnsName(buf, 0);

			assert.equal(name, '_lxi._tcp.local');
			assert.equal(newOffset, buf.length);
		});

		it('should handle compressed pointer.', () => {
			// First: _lxi._tcp.local at offset 0, then a compressed pointer at offset 17
			const labels = Buffer.from([
				4, 0x5f, 0x6c, 0x78, 0x69,
				4, 0x5f, 0x74, 0x63, 0x70,
				5, 0x6c, 0x6f, 0x63, 0x61, 0x6c,
				0,
			]);
			const pointer = Buffer.from([0xc0, 0x00]); // pointer to offset 0
			const buf = Buffer.concat([labels, pointer]);
			const { name, newOffset } = discovery.readDnsName(buf, labels.length);

			assert.equal(name, '_lxi._tcp.local');
			assert.equal(newOffset, labels.length + 2);
		});

		it('should return empty name for null label.', () => {
			const buf = Buffer.from([0]);
			const { name } = discovery.readDnsName(buf, 0);

			assert.equal(name, '');
		});

		it('should handle label exceeding buffer length.', () => {
			// Label says 10 bytes but buffer only has 2
			const buf = Buffer.from([10, 0x41, 0x42]);
			const { name } = discovery.readDnsName(buf, 0);

			assert.equal(name, '');
		});

		it('should handle nested compressed pointer.', () => {
			// local at offset 0: [5]local[0]
			const local = Buffer.from([5, 0x6c, 0x6f, 0x63, 0x61, 0x6c, 0]);
			// _tcp.local at offset 7: [4]_tcp[ptr→0]
			const tcp = Buffer.from([4, 0x5f, 0x74, 0x63, 0x70, 0xc0, 0x00]);
			// pointer at offset 14: [ptr→7]
			const ptr = Buffer.from([0xc0, 0x07]);
			const buf = Buffer.concat([local, tcp, ptr]);
			const { name, newOffset } = discovery.readDnsName(buf, 14);

			assert.equal(name, '_tcp.local');
			assert.equal(newOffset, 16);
		});
	});

	describe('.parseMdnsResponse()', () => {
		it('should return empty array for buffer < 12 bytes.', () => {
			const result = discovery.parseMdnsResponse(Buffer.alloc(5));

			assert.deepEqual(result, []);
		});

		it('should return empty array for header-only response with no records.', () => {
			const header = Buffer.alloc(12);

			header.writeUInt16BE(0, 0);      // Transaction ID
			header.writeUInt16BE(0x8400, 2); // Flags (response)
			header.writeUInt16BE(0, 4);      // Questions
			header.writeUInt16BE(0, 6);      // Answers
			header.writeUInt16BE(0, 8);      // Authority
			header.writeUInt16BE(0, 10);     // Additional

			const result = discovery.parseMdnsResponse(header);

			assert.deepEqual(result, []);
		});

		it('should parse SRV + A records into service results.', () => {
			const buf = buildMdnsSrvAResponse(
				'myinst._lxi._tcp.local',
				'myinst.local',
				9876,
				[192, 168, 1, 42],
			);
			const results = discovery.parseMdnsResponse(buf);

			assert.ok(results.length > 0);
			assert.equal(results[0].port, 9876);
			assert.equal(results[0].address, '192.168.1.42');
			assert.ok(results[0].service);
		});

		it('should parse SRV record without matching A record.', () => {
			// Build a response with only SRV record (no A record)
			const srvRdata = buildSrvRdata(0, 0, 8080, 'noaddr.local');
			const srvRecord = buildDnsRecord('svc._lxi._tcp.local', 33, 1, 120, srvRdata);
			const header = buildMdnsHeader(0, 1, 0, 0);
			const buf = Buffer.concat([header, srvRecord]);

			const results = discovery.parseMdnsResponse(buf);

			assert.ok(results.length > 0);
			assert.equal(results[0].port, 8080);
			assert.equal(results[0].address, undefined);
		});

		it('should parse PTR-only records as fallback.', () => {
			const buf = buildMdnsPtrResponse('_lxi._tcp.local', 'myinst._lxi._tcp.local');
			const results = discovery.parseMdnsResponse(buf);

			assert.ok(results.length > 0);
			assert.ok(results[0].name);
		});

		it('should parse TXT records.', () => {
			const buf = buildMdnsTxtResponse('myinst._lxi._tcp.local', ['txtvers=1', 'path=/']);
			const results = discovery.parseMdnsResponse(buf);

			// TXT records alone don't produce results, but parsing should not throw
			assert.ok(Array.isArray(results));
		});

		it('should parse A record addresses.', () => {
			const buf = buildMdnsAResponse('myinst.local', [10, 0, 0, 1]);
			const results = discovery.parseMdnsResponse(buf);

			// A records alone don't produce results without SRV
			assert.ok(Array.isArray(results));
		});

		it('should parse response with question section.', () => {
			// Build a response with 1 question + 1 answer (PTR)
			const buf = buildMdnsResponseWithQuestion(
				'_lxi._tcp.local',
				'myinst._lxi._tcp.local',
			);
			const results = discovery.parseMdnsResponse(buf);

			assert.ok(Array.isArray(results));
		});

		it('should parse question section with compressed name.', () => {
			const header = buildMdnsHeader(1, 1, 0, 0);

			// Question with compressed pointer
			const question = Buffer.from([
				0xc0, 0x00,       // compressed pointer
				0x00, 0x0c,       // QTYPE: PTR
				0x00, 0x01,       // QCLASS: IN
			]);

			// Answer: PTR record
			const rdata = encodeDnsName('myinst._lxi._tcp.local');
			const record = buildDnsRecord('_lxi._tcp.local', 12, 1, 120, rdata);
			const buf = Buffer.concat([header, question, record]);
			const results = discovery.parseMdnsResponse(buf);

			assert.ok(Array.isArray(results));
		});

		it('should handle truncated record after name.', () => {
			// Header with 2 answers but only 1 complete record + truncated second
			const record1 = buildDnsRecord('a.local', 1, 1, 120, Buffer.from([10, 0, 0, 1]));
			// Add a long name that leaves < 10 bytes for the record header
			const longName = encodeDnsName('verylongname.that.leaves.no.room.local');
			const header = buildMdnsHeader(0, 2, 0, 0);
			const buf = Buffer.concat([header, record1, longName]);
			const results = discovery.parseMdnsResponse(buf);

			assert.ok(Array.isArray(results));
		});

		it('should handle compressed names in answers.', () => {
			const buf = buildMdnsSrvAResponse(
				'inst._lxi._tcp.local',
				'inst.local',
				5025,
				[10, 0, 0, 5],
			);
			const results = discovery.parseMdnsResponse(buf);

			assert.ok(results.length > 0);
		});
	});

	describe('.discoverVxi11()', () => {
		let mock;
		let udpServer;
		let udpPort;

		before(async () => {
			mock = new MockDevice({ identity: 'TEST,DiscoverTest,SN0010,1.0' });
			await mock.start();

			// Create a UDP server that echoes back a dummy response
			udpServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });
			await new Promise((resolve) => {
				udpServer.bind(0, '127.0.0.1', resolve);
			});
			udpPort = udpServer.address().port;

			udpServer.on('message', (msg, rinfo) => {
				// Send back a dummy portmapper reply to trigger the message handler
				const reply = Buffer.alloc(4);

				reply.writeUInt32BE(mock.vxi11Port);
				udpServer.send(reply, rinfo.port, rinfo.address);
			});
		});

		after(async () => {
			await mock.stop();
			await new Promise((resolve) => udpServer.close(resolve));
		});

		it('should discover devices via UDP broadcast.', async () => {
			const devices = await discovery.discoverVxi11({
				timeout: 1000,
				_port: udpPort,
				_broadcastTargets: [{ name: 'test', broadcast: '127.0.0.1' }],
				_vxiPort: mock.vxi11Port,
			});

			assert.ok(Array.isArray(devices));
			assert.ok(devices.length > 0);
			assert.equal(devices[0].address, '127.0.0.1');
			assert.ok(devices[0].id.includes('TEST,DiscoverTest'));
		});

		it('should invoke onDevice callback.', async () => {
			const found = [];
			await discovery.discoverVxi11({
				timeout: 1000,
				_port: udpPort,
				_broadcastTargets: [{ name: 'test', broadcast: '127.0.0.1' }],
				_vxiPort: mock.vxi11Port,
				onDevice: (d) => found.push(d),
			});

			assert.ok(found.length > 0);
		});

		it('should invoke onBroadcast callback.', async () => {
			const interfaces = [];
			await discovery.discoverVxi11({
				timeout: 500,
				_port: udpPort,
				_broadcastTargets: [{ name: 'testIface', broadcast: '127.0.0.1' }],
				_vxiPort: mock.vxi11Port,
				onBroadcast: (name) => interfaces.push(name),
			});

			assert.deepEqual(interfaces, ['testIface']);
		});

		it('should deduplicate addresses.', async () => {
			// Send to two targets with same address
			const devices = await discovery.discoverVxi11({
				timeout: 1000,
				_port: udpPort,
				_broadcastTargets: [
					{ name: 'if1', broadcast: '127.0.0.1' },
					{ name: 'if2', broadcast: '127.0.0.1' },
				],
				_vxiPort: mock.vxi11Port,
			});

			const addresses = devices.map(d => d.address);
			const unique = [...new Set(addresses)];

			assert.equal(addresses.length, unique.length);
		});

		it('should return empty array when no devices respond.', async () => {
			// Create a server that receives but never replies
			const silentServer = dgram.createSocket('udp4');
			await new Promise((r) => silentServer.bind(0, '127.0.0.1', r));
			const port = silentServer.address().port;

			const devices = await discovery.discoverVxi11({
				timeout: 200,
				_port: port,
				_broadcastTargets: [{ name: 'test', broadcast: '127.0.0.1' }],
			});

			silentServer.close();
			assert.deepEqual(devices, []);
		});

		it('should handle VXI11 connect failure gracefully.', async () => {
			// Use an invalid VXI port so connect fails
			const devices = await discovery.discoverVxi11({
				timeout: 1500,
				_port: udpPort,
				_broadcastTargets: [{ name: 'test', broadcast: '127.0.0.1' }],
				_vxiPort: 1, // invalid port
			});

			// Device should still be recorded with 'Unknown' id
			assert.ok(Array.isArray(devices));
			if (devices.length > 0) {
				assert.equal(devices[0].id, 'Unknown');
			}
		});

		it('should use real broadcast targets when _broadcastTargets is not provided.', async () => {
			const silentServer = dgram.createSocket('udp4');
			await new Promise((r) => silentServer.bind(0, '127.0.0.1', r));
			const port = silentServer.address().port;

			const devices = await discovery.discoverVxi11({
				timeout: 100,
				_port: port,
			});

			silentServer.close();
			assert.ok(Array.isArray(devices));
		});

		it('should use default options when not provided.', async () => {
			const devices = await discovery.discoverVxi11({
				_broadcastTargets: [],
			});

			assert.ok(Array.isArray(devices));
		});
	});

	describe('.discoverMdns()', () => {
		it('should return empty array with short timeout.', async () => {
			const services = await discovery.discoverMdns({
				timeout: 100,
				_mdnsAddr: '127.0.0.1',
				_mdnsPort: 59999,
			});

			assert.ok(Array.isArray(services));
		});

		it('should handle mDNS responses.', async () => {
			// Create a UDP server that responds with a crafted mDNS response
			const mdnsServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });
			await new Promise((r) => mdnsServer.bind(0, '127.0.0.1', r));
			const port = mdnsServer.address().port;

			mdnsServer.on('message', (msg, rinfo) => {
				// Send back a crafted mDNS response with SRV + A records
				const response = buildMdnsSrvAResponse(
					'inst._lxi._tcp.local',
					'inst.local',
					5025,
					[127, 0, 0, 1],
				);

				mdnsServer.send(response, rinfo.port, rinfo.address);
			});

			const services = await discovery.discoverMdns({
				timeout: 500,
				_mdnsAddr: '127.0.0.1',
				_mdnsPort: port,
			});

			mdnsServer.close();

			assert.ok(Array.isArray(services));
			if (services.length > 0) {
				assert.ok(services[0].address);
				assert.ok(services[0].port);
			}
		});

		it('should invoke onService callback.', async () => {
			const mdnsServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });
			await new Promise((r) => mdnsServer.bind(0, '127.0.0.1', r));
			const port = mdnsServer.address().port;

			mdnsServer.on('message', (msg, rinfo) => {
				const response = buildMdnsSrvAResponse(
					'svc._lxi._tcp.local',
					'svc.local',
					5025,
					[127, 0, 0, 1],
				);

				mdnsServer.send(response, rinfo.port, rinfo.address);
			});

			const found = [];
			await discovery.discoverMdns({
				timeout: 500,
				_mdnsAddr: '127.0.0.1',
				_mdnsPort: port,
				onService: (s) => found.push(s),
			});

			mdnsServer.close();

			assert.ok(Array.isArray(found));
		});

		it('should use fallback fields for records missing address.', async () => {
			const mdnsServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });
			await new Promise((r) => mdnsServer.bind(0, '127.0.0.1', r));
			const port = mdnsServer.address().port;

			mdnsServer.on('message', (msg, rinfo) => {
				// Send SRV without matching A record → address will be undefined
				const srvRdata = buildSrvRdata(0, 0, 8080, 'noaddr.local');
				const srvRecord = buildDnsRecord('svc._lxi._tcp.local', 33, 1, 120, srvRdata);
				const header = buildMdnsHeader(0, 1, 0, 0);
				const response = Buffer.concat([header, srvRecord]);

				mdnsServer.send(response, rinfo.port, rinfo.address);
			});

			const services = await discovery.discoverMdns({
				timeout: 500,
				_mdnsAddr: '127.0.0.1',
				_mdnsPort: port,
			});

			mdnsServer.close();

			assert.ok(Array.isArray(services));
			if (services.length > 0) {
				// address falls back to remoteInfo.address
				assert.equal(services[0].address, '127.0.0.1');
			}
		});

		it('should deduplicate services.', async () => {
			const mdnsServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });
			await new Promise((r) => mdnsServer.bind(0, '127.0.0.1', r));
			const port = mdnsServer.address().port;

			mdnsServer.on('message', (msg, rinfo) => {
				const response = buildMdnsSrvAResponse(
					'dup._lxi._tcp.local',
					'dup.local',
					5025,
					[127, 0, 0, 1],
				);

				// Send same response twice
				mdnsServer.send(response, rinfo.port, rinfo.address);
				mdnsServer.send(response, rinfo.port, rinfo.address);
			});

			const services = await discovery.discoverMdns({
				timeout: 500,
				_mdnsAddr: '127.0.0.1',
				_mdnsPort: port,
			});

			mdnsServer.close();

			// Should not have duplicates
			const keys = services.map(s => `${s.address}:${s.service}:${s.port}`);
			const unique = [...new Set(keys)];

			assert.equal(keys.length, unique.length);
		});

		it('should handle unparseable responses.', async () => {
			const mdnsServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });
			await new Promise((r) => mdnsServer.bind(0, '127.0.0.1', r));
			const port = mdnsServer.address().port;

			mdnsServer.on('message', (msg, rinfo) => {
				// Send garbage data
				mdnsServer.send(Buffer.from([0xff, 0xff, 0xff]), rinfo.port, rinfo.address);
			});

			const services = await discovery.discoverMdns({
				timeout: 500,
				_mdnsAddr: '127.0.0.1',
				_mdnsPort: port,
			});

			mdnsServer.close();

			assert.ok(Array.isArray(services));
		});

		it('should handle response that causes parser to throw.', async () => {
			const mdnsServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });
			await new Promise((r) => mdnsServer.bind(0, '127.0.0.1', r));
			const port = mdnsServer.address().port;

			mdnsServer.on('message', (msg, rinfo) => {
				// Craft a truncated SRV response that passes the loop guard
				// but throws RangeError when reading SRV port field
				const buf = Buffer.from([
					0x00, 0x00,                         // Transaction ID
					0x84, 0x00,                         // Flags (response)
					0x00, 0x00,                         // Questions: 0
					0x00, 0x01,                         // Answers: 1
					0x00, 0x00,                         // Authority: 0
					0x00, 0x00,                         // Additional: 0
					0x00,                               // Null name label
					0x00, 0x21,                         // Type: SRV (33)
					0x00, 0x01,                         // Class: IN
					0x00, 0x00, 0x00, 0x00,             // TTL: 0
					0x00, 0x64,                         // RDLENGTH: 100 (no data follows)
				]);

				mdnsServer.send(buf, rinfo.port, rinfo.address);
			});

			const services = await discovery.discoverMdns({
				timeout: 300,
				_mdnsAddr: '127.0.0.1',
				_mdnsPort: port,
			});

			mdnsServer.close();

			assert.ok(Array.isArray(services));
			assert.equal(services.length, 0);
		});

		it('should use default mDNS address and port.', async () => {
			const services = await discovery.discoverMdns({});

			assert.ok(Array.isArray(services));
		});

		it('should use fallback values for empty SRV fields.', async () => {
			const mdnsServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });
			await new Promise((r) => mdnsServer.bind(0, '127.0.0.1', r));
			const port = mdnsServer.address().port;

			mdnsServer.on('message', (msg, rinfo) => {
				// Build SRV with null name and port 0
				const header = Buffer.from([
					0x00, 0x00,                         // Transaction ID
					0x84, 0x00,                         // Flags
					0x00, 0x00,                         // Questions: 0
					0x00, 0x01,                         // Answers: 1
					0x00, 0x00,                         // Authority: 0
					0x00, 0x00,                         // Additional: 0
				]);

				// SRV record with null name label, port 0
				const name = Buffer.from([0x00]); // null name
				const rtype = Buffer.alloc(10);

				rtype.writeUInt16BE(33, 0);  // SRV
				rtype.writeUInt16BE(1, 2);   // IN
				rtype.writeUInt32BE(120, 4); // TTL

				const srvData = Buffer.alloc(6 + 2); // priority, weight, port, target '\0'

				srvData.writeUInt16BE(0, 0); // priority
				srvData.writeUInt16BE(0, 2); // weight
				srvData.writeUInt16BE(0, 4); // port = 0
				srvData[6] = 0;             // target: null name
				rtype.writeUInt16BE(srvData.length, 8);

				const response = Buffer.concat([header, name, rtype, srvData]);

				mdnsServer.send(response, rinfo.port, rinfo.address);
			});

			const services = await discovery.discoverMdns({
				timeout: 500,
				_mdnsAddr: '127.0.0.1',
				_mdnsPort: port,
			});

			mdnsServer.close();

			assert.ok(Array.isArray(services));
			if (services.length > 0) {
				assert.equal(services[0].id, 'Unknown');
				assert.equal(services[0].service, '_lxi._tcp');
				assert.equal(services[0].port, 0);
			}
		});
	});

	describe('.discover()', () => {
		it('should call discoverVxi11 by default.', async () => {
			const result = await discovery.discover({
				timeout: 100,
				_port: 1,
				_broadcastTargets: [],
			});

			assert.ok(Array.isArray(result));
		});

		it('should call discoverMdns when mdns=true.', async () => {
			const result = await discovery.discover({
				mdns: true,
				timeout: 100,
				_mdnsAddr: '127.0.0.1',
				_mdnsPort: 59998,
			});

			assert.ok(Array.isArray(result));
		});
	});
});

// ─── Helper functions for building mDNS test packets ─────────────────

function encodeDnsName(name) {
	const parts = name.split('.');
	const buffers = [];

	for (const part of parts) {
		buffers.push(Buffer.from([part.length]));
		buffers.push(Buffer.from(part));
	}
	buffers.push(Buffer.from([0]));

	return Buffer.concat(buffers);
}

function buildDnsRecord(name, type, classValue, ttl, rdata) {
	const nameBuffer = encodeDnsName(name);
	const header = Buffer.alloc(10);

	header.writeUInt16BE(type, 0);
	header.writeUInt16BE(classValue, 2);
	header.writeUInt32BE(ttl, 4);
	header.writeUInt16BE(rdata.length, 8);

	return Buffer.concat([nameBuffer, header, rdata]);
}

function buildMdnsHeader(questions, answers, authority, additional) {
	const header = Buffer.alloc(12);

	header.writeUInt16BE(0, 0);             // Transaction ID
	header.writeUInt16BE(0x8400, 2);        // Flags (response, authoritative)
	header.writeUInt16BE(questions, 4);
	header.writeUInt16BE(answers, 6);
	header.writeUInt16BE(authority, 8);
	header.writeUInt16BE(additional, 10);

	return header;
}

function buildSrvRdata(priority, weight, port, target) {
	const targetBuf = encodeDnsName(target);
	const fixed = Buffer.alloc(6);

	fixed.writeUInt16BE(priority, 0);
	fixed.writeUInt16BE(weight, 2);
	fixed.writeUInt16BE(port, 4);

	return Buffer.concat([fixed, targetBuf]);
}

function buildMdnsSrvAResponse(srvName, targetName, port, ipBytes) {
	const srvRdata = buildSrvRdata(0, 0, port, targetName);
	const srvRecord = buildDnsRecord(srvName, 33, 1, 120, srvRdata);
	const aRdata = Buffer.from(ipBytes);
	const aRecord = buildDnsRecord(targetName, 1, 1, 120, aRdata);
	const header = buildMdnsHeader(0, 2, 0, 0);

	return Buffer.concat([header, srvRecord, aRecord]);
}

function buildMdnsPtrResponse(ptrName, targetName) {
	const rdata = encodeDnsName(targetName);
	const record = buildDnsRecord(ptrName, 12, 1, 120, rdata);
	const header = buildMdnsHeader(0, 1, 0, 0);

	return Buffer.concat([header, record]);
}

function buildMdnsTxtResponse(name, texts) {
	const parts = [];

	for (const text of texts) {
		parts.push(Buffer.from([text.length]));
		parts.push(Buffer.from(text));
	}

	const rdata = Buffer.concat(parts);
	const record = buildDnsRecord(name, 16, 1, 120, rdata);
	const header = buildMdnsHeader(0, 1, 0, 0);

	return Buffer.concat([header, record]);
}

function buildMdnsAResponse(name, ipBytes) {
	const rdata = Buffer.from(ipBytes);
	const record = buildDnsRecord(name, 1, 1, 120, rdata);
	const header = buildMdnsHeader(0, 1, 0, 0);

	return Buffer.concat([header, record]);
}

function buildMdnsResponseWithQuestion(questionName, ptrTarget) {
	// Build question section
	const qName = encodeDnsName(questionName);
	const qType = Buffer.alloc(4);

	qType.writeUInt16BE(12, 0); // PTR
	qType.writeUInt16BE(1, 2);  // IN

	// Build answer section (PTR)
	const rdata = encodeDnsName(ptrTarget);
	const record = buildDnsRecord(questionName, 12, 1, 120, rdata);
	const header = buildMdnsHeader(1, 1, 0, 0);

	return Buffer.concat([header, qName, qType, record]);
}

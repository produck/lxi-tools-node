import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MockDevice } from '@produck/vxi-mock-device';
import { Screenshot } from '@produck/lxi-tools-node';

describe('Screenshot', () => {
	describe('.listPlugins()', () => {
		it('should return an array of plugin objects.', () => {
			const list = Screenshot.listPlugins();

			assert.ok(Array.isArray(list));
			assert.ok(list.length > 0);
		});

		it('each plugin should have name and description.', () => {
			const list = Screenshot.listPlugins();

			for (const plugin of list) {
				assert.equal(typeof plugin.name, 'string');
				assert.equal(typeof plugin.description, 'string');
				assert.ok(plugin.name.length > 0);
			}
		});

		it('should include rigol-1000z.', () => {
			const list = Screenshot.listPlugins();
			const rigol = list.find(p => p.name === 'rigol-1000z');

			assert.ok(rigol);
		});

		it('should include at least 20 plugins.', () => {
			const list = Screenshot.listPlugins();

			assert.ok(list.length >= 20);
		});

		const expectedPlugins = [
			'keysight-dmm', 'keysight-dso', 'keysight-ivx',
			'keysight-psa', 'keysight-pxa',
			'lecroy-wp',
			'rigol-1000z', 'rigol-2000', 'rigol-dg', 'rigol-dl3000',
			'rigol-dm3068', 'rigol-dp800', 'rigol-dsa',
			'rs-fsv', 'rs-hmo-rtb', 'rs-ng', 'rs-rth',
			'siglent-sdg', 'siglent-sdm3000', 'siglent-sds', 'siglent-ssa3000x',
			'tektronix-2000', 'tektronix-3000', 'tektronix-mso-5',
		];

		for (const name of expectedPlugins) {
			it(`should include "${name}" plugin.`, () => {
				const list = Screenshot.listPlugins();

				assert.ok(list.find(p => p.name === name), `Missing plugin: ${name}`);
			});
		}
	});

	// NOTE: detectPlugin() and screenshot() hardcode port=0, which triggers
	// portmapper lookup on port 111. These cannot be tested via MockDevice
	// with ephemeral ports. Integration tests with real portmapper (port 111)
	// would require elevated privileges and are out of scope here.

	describe('.stripTmcHeader()', () => {
		it('should strip a valid TMC header.', () => {
			// #28<8 bytes of data> → TMC header: #2 means 2-digit length, "08" = 8 bytes
			const header = Buffer.from('#208');
			const data = Buffer.from('ABCDEFGH');
			const buf = Buffer.concat([header, data]);
			const result = Screenshot.stripTmcHeader(buf);

			assert.ok(result.length > 0);
			// Header is 4 bytes (#2 + 08), data starts at offset 4
			assert.equal(result.toString(), 'ABCDEFGH');
		});

		it('should return buffer unchanged when no # prefix.', () => {
			const buf = Buffer.from('no header');
			const result = Screenshot.stripTmcHeader(buf);

			assert.equal(result.toString(), 'no header');
		});

		it('should return buffer unchanged when too short.', () => {
			const buf = Buffer.from('#2');
			const result = Screenshot.stripTmcHeader(buf);

			assert.equal(result.toString(), '#2');
		});

		it('should return buffer unchanged when digit count is 0.', () => {
			const buf = Buffer.from('#0data');
			const result = Screenshot.stripTmcHeader(buf);

			assert.equal(result.toString(), '#0data');
		});

		it('should return buffer unchanged when digit count is NaN.', () => {
			const buf = Buffer.from('#xdata');
			const result = Screenshot.stripTmcHeader(buf);

			assert.equal(result.toString(), '#xdata');
		});

		it('should strip trailing newline when option is set.', () => {
			const header = Buffer.from('#14');
			const data = Buffer.from('DATA\n');
			const buf = Buffer.concat([header, data]);
			const result = Screenshot.stripTmcHeader(buf, true);

			assert.equal(result.toString(), 'DATA');
		});

		it('should not strip trailing newline when option is false.', () => {
			const header = Buffer.from('#14');
			const data = Buffer.from('DATA\n');
			const buf = Buffer.concat([header, data]);
			const result = Screenshot.stripTmcHeader(buf, false);

			assert.equal(result.toString(), 'DATA\n');
		});
	});

	describe('.detectPlugin()', () => {
		let mock;

		before(async () => {
			mock = new MockDevice({ identity: 'RIGOL TECHNOLOGIES,DS1054Z,SN001,1.0' });
			await mock.start();
		});

		after(async () => {
			await mock.stop();
		});

		it('should detect a Rigol 1000Z instrument.', async () => {
			const plugin = await Screenshot.detectPlugin('127.0.0.1', 5000, mock.vxi11Port);

			assert.equal(plugin, 'rigol-1000z');
		});

		it('should return null for unknown instrument.', async () => {
			const unknownMock = new MockDevice({ identity: 'UNKNOWN,NoMatch,SN999,0.0' });
			await unknownMock.start();

			try {
				const plugin = await Screenshot.detectPlugin('127.0.0.1', 5000, unknownMock.vxi11Port);

				assert.equal(plugin, null);
			} finally {
				await unknownMock.stop();
			}
		});

		it('should detect Keysight DMM.', async () => {
			const m = new MockDevice({ identity: 'Keysight Technologies,34401A,MY12345,2.0' });
			await m.start();

			try {
				const plugin = await Screenshot.detectPlugin('127.0.0.1', 5000, m.vxi11Port);

				assert.equal(plugin, 'keysight-dmm');
			} finally {
				await m.stop();
			}
		});

		it('should detect Rohde & Schwarz HMO.', async () => {
			const m = new MockDevice({ identity: 'Rohde&Schwarz,HMO1002,100001,1.0' });
			await m.start();

			try {
				const plugin = await Screenshot.detectPlugin('127.0.0.1', 5000, m.vxi11Port);

				assert.equal(plugin, 'rs-hmo-rtb');
			} finally {
				await m.stop();
			}
		});

		it('should detect Siglent SDS.', async () => {
			const m = new MockDevice({ identity: 'Siglent Technologies,SDS1202X,SN,1.0' });
			await m.start();

			try {
				const plugin = await Screenshot.detectPlugin('127.0.0.1', 5000, m.vxi11Port);

				assert.equal(plugin, 'siglent-sds');
			} finally {
				await m.stop();
			}
		});

		it('should detect Tektronix 2000.', async () => {
			const m = new MockDevice({ identity: 'TEKTRONIX,DPO2024,C100,1.0' });
			await m.start();

			try {
				const plugin = await Screenshot.detectPlugin('127.0.0.1', 5000, m.vxi11Port);

				assert.equal(plugin, 'tektronix-2000');
			} finally {
				await m.stop();
			}
		});

		it('should detect LeCroy.', async () => {
			const m = new MockDevice({ identity: 'LECROY,WP7300A,LCRY,1.0' });
			await m.start();

			try {
				const plugin = await Screenshot.detectPlugin('127.0.0.1', 5000, m.vxi11Port);

				assert.equal(plugin, 'lecroy-wp');
			} finally {
				await m.stop();
			}
		});

		it('should return null when IDN response is empty.', async () => {
			const m = new MockDevice({});

			m.handle('*IDN?', () => '');
			await m.start();

			try {
				const plugin = await Screenshot.detectPlugin('127.0.0.1', 5000, m.vxi11Port);

				assert.equal(plugin, null);
			} finally {
				await m.stop();
			}
		});
	});

	describe('.screenshot()', () => {
		it('should reject on unknown plugin name.', async () => {
			await assert.rejects(
				() => Screenshot.screenshot('127.0.0.1', {
					plugin: 'nonexistent-plugin',
					timeout: 500,
				}),
				/Unknown screenshot plugin/,
			);
		});

		it('should reject when address is missing.', async () => {
			await assert.rejects(
				() => Screenshot.screenshot(''),
				/Missing address/,
			);
		});

		it('should auto-detect and capture from a known instrument.', async () => {
			const mock = new MockDevice({ identity: 'Siglent Technologies,SDS1202X,SN,1.0' });

			// Register scdp handler (siglent-sds uses rawDumpPlugin with 'scdp')
			mock.handle('SCDP', () => Buffer.from('FAKE_IMAGE_DATA'));
			await mock.start();

			try {
				const result = await Screenshot.screenshot('127.0.0.1', {
					timeout: 5000,
					port: mock.vxi11Port,
				});

				assert.ok(result.data);
				assert.equal(result.format, 'bmp');
				assert.equal(result.plugin, 'siglent-sds');
			} finally {
				await mock.stop();
			}
		});

		it('should capture with explicit plugin name.', async () => {
			const mock = new MockDevice({ identity: 'TEST' });

			mock.handle('SCDP', () => Buffer.from('FAKE_SCREENSHOT'));
			await mock.start();

			try {
				const result = await Screenshot.screenshot('127.0.0.1', {
					plugin: 'siglent-sds',
					timeout: 5000,
					port: mock.vxi11Port,
				});

				assert.ok(result.data);
				assert.equal(result.plugin, 'siglent-sds');
			} finally {
				await mock.stop();
			}
		});

		it('should reject when auto-detect finds no match.', async () => {
			const mock = new MockDevice({ identity: 'UNKNOWN,NoPlugin,SN999,0.0' });
			await mock.start();

			try {
				await assert.rejects(
					() => Screenshot.screenshot('127.0.0.1', {
						timeout: 5000,
						port: mock.vxi11Port,
					}),
					/Could not auto-detect screenshot plugin/,
				);
			} finally {
				await mock.stop();
			}
		});
	});

	describe('plugin capture via tmcQueryPlugin', () => {
		let mock;

		before(async () => {
			mock = new MockDevice({ identity: 'RIGOL TECHNOLOGIES,DS1054Z,SN001,1.0' });
			// Simulate rigol-1000z: responds to 'display:data? on,0,png'
			mock.handle('DISPLAY:DATA? ON,0,PNG', () => {
				// TMC header #14 + 4 bytes data
				return Buffer.from('#14FAKE');
			});
			await mock.start();
		});

		after(async () => {
			await mock.stop();
		});

		it('should capture screenshot via tmcQueryPlugin.', async () => {
			const result = await Screenshot.screenshot('127.0.0.1', {
				plugin: 'rigol-1000z',
				timeout: 5000,
				port: mock.vxi11Port,
			});

			assert.ok(result.data);
			assert.equal(result.format, 'png');
		});
	});

	describe('plugin capture via rawDumpPlugin with array commands', () => {
		let mock;

		before(async () => {
			mock = new MockDevice({ identity: 'TEKTRONIX,DPO2024,C100,1.0' });
			// tektronix-2000 sends: ['save:image:fileformat PNG', 'hardcopy:inksaver off', 'hardcopy start']
			mock.handle('SAVE:IMAGE:FILEFORMAT PNG', () => null);
			mock.handle('HARDCOPY:INKSAVER OFF', () => null);
			mock.handle('HARDCOPY START', () => Buffer.from('PNG_DATA'));
			await mock.start();
		});

		after(async () => {
			await mock.stop();
		});

		it('should capture screenshot via rawDumpPlugin with multiple commands.', async () => {
			const result = await Screenshot.screenshot('127.0.0.1', {
				plugin: 'tektronix-2000',
				timeout: 5000,
				port: mock.vxi11Port,
			});

			assert.ok(result.data);
			assert.equal(result.format, 'png');
		});
	});

	describe('plugin capture via tmcQueryPlugin with preCommands', () => {
		let mock;

		before(async () => {
			mock = new MockDevice({ identity: 'Keysight Technologies,34401A,MY001,1.0' });
			// keysight-dmm: preCommands=['HCOP:SDUM:DATA:FORM BMP'], command='HCOP:SDUM:DATA?'
			mock.handle('HCOP:SDUM:DATA:FORM BMP', () => null);
			mock.handle('HCOP:SDUM:DATA?', () => {
				return Buffer.from('#14BMPD');
			});
			await mock.start();
		});

		after(async () => {
			await mock.stop();
		});

		it('should capture with preCommands.', async () => {
			const result = await Screenshot.screenshot('127.0.0.1', {
				plugin: 'keysight-dmm',
				timeout: 5000,
				port: mock.vxi11Port,
			});

			assert.ok(result.data);
			assert.equal(result.format, 'bmp');
		});
	});

	describe('plugin capture via tmcQueryPlugin with query preCommands', () => {
		let mock;

		before(async () => {
			mock = new MockDevice({ identity: 'Keysight Technologies,34401A,MY001,1.0' });
			// Simulate a plugin with a query preCommand (contains '?')
			mock.handle(':HARDCOPY:INKSAVER OFF', () => null);
			mock.handle(':DISPLAY:DATA? BMP, COLOR', () => {
				return Buffer.from('#14DATA');
			});
			await mock.start();
		});

		after(async () => {
			await mock.stop();
		});

		it('should handle preCommands that are queries.', async () => {
			const result = await Screenshot.screenshot('127.0.0.1', {
				plugin: 'keysight-ivx',
				timeout: 5000,
				port: mock.vxi11Port,
			});

			assert.ok(result.data);
		});
	});

	describe('plugin capture via fileBasedPlugin', () => {
		let mock;

		before(async () => {
			mock = new MockDevice({ identity: 'Rohde&Schwarz,FSV3004,SN001,1.0' });
			// rs-fsv plugin: has preCommands, saveCommand with *OPC?, readCommand, deleteCommand
			mock.handle('HCOP:DEV:LANG PNG', () => null);
			mock.handle('HCOP:CMAP:DEF4', () => null);
			mock.handle('HCOP:DEST \'MMEM\'', () => null);
			mock.handle(':MMEMORY:NAME \'C:\\R_S\\INSTR\\USER\\PRINT.PNG\'', () => null);
			mock.handle(':HCOPY:IMMEDIATE;*OPC?', () => '1');
			mock.handle(':MMEMORY:DATA? \'C:\\R_S\\INSTR\\USER\\PRINT.PNG\'', () => {
				return Buffer.from('#14DATA');
			});
			mock.handle(':MMEMORY:DELETE \'C:\\R_S\\INSTR\\USER\\PRINT.PNG\'', () => null);
			await mock.start();
		});

		after(async () => {
			await mock.stop();
		});

		it('should capture via file-based plugin.', async () => {
			const result = await Screenshot.screenshot('127.0.0.1', {
				plugin: 'rs-fsv',
				timeout: 5000,
				port: mock.vxi11Port,
			});

			assert.ok(result.data);
			assert.equal(result.format, 'png');
		});
	});

	describe('plugin capture via fileBasedPlugin with waitCommand', () => {
		let mock;

		before(async () => {
			mock = new MockDevice({ identity: 'TEKTRONIX,MSO5204,C100,1.0' });
			// tektronix-mso-5: saveCommand, *WAI wait, readCommand, deleteCommand
			mock.handle('SAVE:IMAGE \'C:/LXI-TOOLS-SCREENSHOT.PNG\'', () => null);
			mock.handle('*WAI', () => '1');
			mock.handle('FILESYSTEM:READFILE \'C:/LXI-TOOLS-SCREENSHOT.PNG\'', () => Buffer.from('PNGDATA'));
			mock.handle('FILESYSTEM:DELETE \'C:/LXI-TOOLS-SCREENSHOT.PNG\'', () => null);
			await mock.start();
		});

		after(async () => {
			await mock.stop();
		});

		it('should capture via file-based plugin with wait command.', async () => {
			const result = await Screenshot.screenshot('127.0.0.1', {
				plugin: 'tektronix-mso-5',
				timeout: 5000,
				port: mock.vxi11Port,
			});

			assert.ok(result.data);
			assert.equal(result.format, 'png');
		});
	});

	describe('LeCroy plugin capture', () => {
		let mock;

		before(async () => {
			mock = new MockDevice({ identity: 'LECROY,WP7300A,LCRY,1.0' });
			mock.handle('HCSU DEV,PNG,BCKG,WHITE,AREA,GRIDAREAONLY', () => null);
			mock.handle('SCDP', () => null);
			mock.handle('TRFL? DISK,HDD,FILE,\'D:\\HARDCOPY\\LXI_SCREENSHOT.PNG\'', () => {
				// Build a fake LeCroy response: 6 byte prefix + TMC header + data + 10 byte footer
				const prefix = Buffer.from('TRFL? ');
				const tmcHeader = Buffer.from('#15');
				const imageData = Buffer.from('IMAGE');
				const footer = Buffer.alloc(10, 0);

				return Buffer.concat([prefix, tmcHeader, imageData, footer]);
			});
			await mock.start();
		});

		after(async () => {
			await mock.stop();
		});

		it('should capture screenshot via LeCroy plugin.', async () => {
			const result = await Screenshot.screenshot('127.0.0.1', {
				plugin: 'lecroy-wp',
				timeout: 5000,
				port: mock.vxi11Port,
			});

			assert.ok(result.data);
			assert.equal(result.format, 'png');
		});
	});
});

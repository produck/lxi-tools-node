/**
 * Screenshot capture for LXI instruments.
 *
 * Mirrors screenshot.c and all plugins from lxi-tools.
 * Supports auto-detection of instrument type via *IDN? regex matching.
 */

import { connect, send, receive, disconnect, Protocol } from './lxi.js';

const IMAGE_SIZE_MAX = 0x400000;     // 4 MB default
const IMAGE_SIZE_MAX_RS = 0x1400000; // 20 MB for R&S
const IMAGE_SIZE_MAX_TEK5 = 0x800000; // 8 MB for Tektronix MSO-5

/**
 * Strip IEEE 488.2 / TMC definite-length block header.
 * Format: #<n><n-digit-length><data>
 *
 * @param {Buffer} buf
 * @param {boolean} [stripTrailingNewline=false]
 * @returns {Buffer}
 */
function stripTmcHeader(buffer, stripTrailingNewline = false) {
  if (buffer.length < 3 || buffer[0] !== 0x23) return buffer; // '#'
  const digitCount = parseInt(String.fromCharCode(buffer[1]), 10);
  if (isNaN(digitCount) || digitCount <= 0) return buffer;
  const headerLength = digitCount + 2;
  let end = buffer.length;
  if (stripTrailingNewline && end > headerLength && buffer[end - 1] === 0x0a) {
    end--;
  }
  return buffer.subarray(headerLength, end);
}

// --- Plugin Definitions ---

const plugins = [];

function registerPlugin(plugin) {
  plugins.push(plugin);
}

/**
 * Generic plugin factory for instruments that directly return image data
 * via a single SCPI query with TMC header.
 */
function tmcQueryPlugin(name, description, regex, command, format, options = {}) {
  const maxSize = options.maxSize || IMAGE_SIZE_MAX;
  const stripNewline = options.stripNewline ?? false;
  const preCommands = options.preCommands || [];

  return {
    name,
    description,
    regex,
    async capture(address, id, timeout) {
      const device = await connect(address, 0, null, timeout, Protocol.VXI11);
      try {
        for (const preCommand of preCommands) {
          await send(device, preCommand, timeout);
          // Small delay for setup commands
          if (preCommand.includes('?')) {
            await receive(device, maxSize, timeout);
          }
        }

        await send(device, command, timeout);
        const response = await receive(device, maxSize, timeout);
        const image = stripTmcHeader(response, stripNewline);
        return { data: image, format };
      } finally {
        await disconnect(device);
      }
    },
  };
}

/**
 * Plugin factory for raw dump instruments (no header stripping).
 */
function rawDumpPlugin(name, description, regex, commands, format, options = {}) {
  const maxSize = options.maxSize || IMAGE_SIZE_MAX;

  return {
    name,
    description,
    regex,
    async capture(address, id, timeout) {
      const device = await connect(address, 0, null, timeout, Protocol.VXI11);
      try {
        if (Array.isArray(commands)) {
          for (let i = 0; i < commands.length - 1; i++) {
            await send(device, commands[i], timeout);
            if (commands[i].includes('?')) {
              await receive(device, maxSize, timeout);
            }
          }
          await send(device, commands[commands.length - 1], timeout);
        } else {
          await send(device, commands, timeout);
        }
        const response = await receive(device, maxSize, timeout);
        return { data: response, format };
      } finally {
        await disconnect(device);
      }
    },
  };
}

/**
 * Plugin factory for file-based screenshot capture.
 * Save screenshot on device -> read file -> optionally delete.
 */
function fileBasedPlugin(name, description, regex, config) {
  const maxSize = config.maxSize || IMAGE_SIZE_MAX;
  const format = config.format;

  return {
    name,
    description,
    regex,
    async capture(address, id, timeout) {
      const device = await connect(address, 0, null, timeout, Protocol.VXI11);
      try {
        // Pre-commands (setup)
        if (config.preCommands) {
          for (const setupCommand of config.preCommands) {
            await send(device, setupCommand, timeout);
          }
        }

        // Save command
        await send(device, config.saveCommand, timeout);

        // Wait command (e.g., *OPC)
        if (config.waitCommand) {
          await send(device, config.waitCommand, timeout);
          const operationCompleteResponse = await receive(device, 256, timeout);
        }

        // Read file command
        await send(device, config.readCommand, timeout);
        const response = await receive(device, maxSize, timeout);
        const image = config.stripTmc ? stripTmcHeader(response, config.stripNewline ?? false) : response;

        // Delete command (cleanup)
        if (config.deleteCommand) {
          await send(device, config.deleteCommand, timeout);
        }

        return { data: image, format };
      } finally {
        await disconnect(device);
      }
    },
  };
}

// --- Register All Plugins ---

// Keysight DMM (34401A etc.)
registerPlugin(tmcQueryPlugin(
  'keysight-dmm',
  'Keysight DMM',
  /Agilent|Keysight Technologies,? 34\d{3}A/i,
  'HCOP:SDUM:DATA?',
  'bmp',
  { preCommands: ['HCOP:SDUM:DATA:FORM BMP'], stripNewline: true },
));

// Keysight DSO (MSO6000A etc.)
registerPlugin(tmcQueryPlugin(
  'keysight-dso',
  'Keysight DSO',
  /AGILENT TECHNOLOGIES,?[MD]SO6\d{3}A/i,
  ':display:data? BMP, screen, color',
  'bmp',
  { preCommands: [':hardcopy:inksaver off'], stripNewline: true },
));

// Keysight IVX (MSO-X 2000/3000 series)
registerPlugin(tmcQueryPlugin(
  'keysight-ivx',
  'Keysight InfiniiVision X',
  /AGILENT|KEYSIGHT TECHNOLOGIES,?[MD]SO-X [23]\d{3}/i,
  ':display:data? BMP, color',
  'bmp',
  { preCommands: [':hardcopy:inksaver off'], stripNewline: true },
));

// Keysight PSA (E44xxA spectrum analyzers)
registerPlugin(fileBasedPlugin(
  'keysight-psa',
  'Keysight PSA',
  /Agilent|Keysight Technologies,? E44\d{2}A/i,
  {
    format: 'gif',
    saveCommand: ':MMEM:STOR:SCR \'R:PICTURE.GIF\'',
    readCommand: ':MMEM:DATA? \'R:PICTURE.GIF\'',
    stripTmc: true,
    stripNewline: true,
  },
));

// Keysight PXA (N90xxA spectrum analyzers)
registerPlugin(fileBasedPlugin(
  'keysight-pxa',
  'Keysight PXA',
  /Agilent|Keysight Technologies,? N90\d{2}A/i,
  {
    format: 'png',
    preCommands: [':MMEM:STOR:SCR:THEM TDC'],
    saveCommand: ':MMEM:STOR:SCR \'C:\\Windows\\Temp\\sa.png\'',
    readCommand: ':MMEM:DATA? \'C:\\Windows\\Temp\\sa.png\'',
    stripTmc: true,
    stripNewline: true,
  },
));

// LeCroy oscilloscopes
registerPlugin({
  name: 'lecroy-wp',
  description: 'LeCroy WavePro/WaveRunner',
  regex: /LECROY|WP|LCRY/i,
  async capture(address, id, timeout) {
    const device = await connect(address, 0, null, timeout, Protocol.VXI11);
    try {
      await send(device, 'HCSU DEV,png,BCKG,white,AREA,gridareaonly', timeout);
      await send(device, 'SCDP', timeout); // trigger screenshot
      await send(device, 'TRFL? DISK,HDD,FILE,\'D:\\HardCopy\\lxi_screenshot.png\'', timeout);
      const response = await receive(device, IMAGE_SIZE_MAX, timeout);
      // LeCroy: skip TRFL? prefix (6 bytes), then IEEE header, strip CRC footer + terminator
      let buffer = response;
      if (buffer.length > 6) buffer = buffer.subarray(6);
      const image = stripTmcHeader(buffer);
      // Remove 8-byte CRC + 2-byte terminator if present
      const end = Math.max(0, image.length - 10);
      return { data: image.subarray(0, end), format: 'png' };
    } finally {
      await disconnect(device);
    }
  },
});

// Rigol 1000Z series
registerPlugin(tmcQueryPlugin(
  'rigol-1000z',
  'Rigol DS1000Z/MSO1000Z',
  /RIGOL TECHNOLOGIES|Rigol Technologies,? (DS|MSO)1\d{3}Z/i,
  'display:data? on,0,png',
  'png',
));

// Rigol 2000/4000/5000/7000/8000 series
registerPlugin(tmcQueryPlugin(
  'rigol-2000',
  'Rigol DS2000/MSO2000/DS4000/MSO4000/MSO5000/DS7000/MSO7000/MSO8000',
  /RIGOL TECHNOLOGIES|Rigol Technologies,? (DS|MSO)[2-8]\d{3}/i,
  ':display:data?',
  'bmp',
  { stripNewline: true },
));

// Rigol DG series
registerPlugin(tmcQueryPlugin(
  'rigol-dg',
  'Rigol DG4000/DG1000Z',
  /RIGOL TECHNOLOGIES|Rigol Technologies,? DG[14]\d{3}/i,
  ':HCOPy:SDUMp:DATA?',
  'bmp',
  { preCommands: [':HCOPy:SDUMp:DATA:FORMat BMP'] },
));

// Rigol DL3000
registerPlugin(tmcQueryPlugin(
  'rigol-dl3000',
  'Rigol DL3000',
  /RIGOL TECHNOLOGIES|Rigol Technologies,? DL30\d{2}/i,
  ':PROJ:WND:DATA?',
  'bmp',
));

// Rigol DM3068
registerPlugin(tmcQueryPlugin(
  'rigol-dm3068',
  'Rigol DM3068',
  /RIGOL TECHNOLOGIES|Rigol Technologies,? DM3068/i,
  ':DISP:DATA?',
  'bmp',
));

// Rigol DP800
registerPlugin(tmcQueryPlugin(
  'rigol-dp800',
  'Rigol DP800',
  /RIGOL TECHNOLOGIES|Rigol Technologies,? DP8\d{2}/i,
  ':SYSTem:PRINT? BMP',
  'bmp',
));

// Rigol DSA series
registerPlugin(tmcQueryPlugin(
  'rigol-dsa',
  'Rigol DSA700/DSA800',
  /RIGOL TECHNOLOGIES|Rigol Technologies,? DSA[78]\d{2}/i,
  ':PRIV:SNAP? BMP',
  'bmp',
));

// Rohde & Schwarz FSV
registerPlugin(fileBasedPlugin(
  'rs-fsv',
  'Rohde & Schwarz FSV',
  /Rohde&Schwarz,? FSV/i,
  {
    format: 'png',
    maxSize: IMAGE_SIZE_MAX_RS,
    preCommands: [
      'HCOP:DEV:LANG PNG',
      'HCOP:CMAP:DEF4',
      'HCOP:DEST \'MMEM\'',
      ':MMEMory:NAME \'C:\\R_S\\instr\\user\\Print.png\'',
    ],
    saveCommand: ':HCOPy:IMMediate;*OPC?',
    waitCommand: null,
    readCommand: ':MMEMory:DATA? \'C:\\R_S\\instr\\user\\Print.png\'',
    deleteCommand: ':MMEMory:DELete \'C:\\R_S\\instr\\user\\Print.png\'',
    stripTmc: true,
  },
));

// Rohde & Schwarz HMO / RTB
registerPlugin(tmcQueryPlugin(
  'rs-hmo-rtb',
  'Rohde & Schwarz HMO/RTB',
  /Rohde&Schwarz|HAMEG,? (HMO|RTB)\d/i,
  'HCOPy:DATA?',
  'png',
  { preCommands: ['HCOPy:FORMat PNG'], maxSize: IMAGE_SIZE_MAX_RS },
));

// Rohde & Schwarz NG
registerPlugin(tmcQueryPlugin(
  'rs-ng',
  'Rohde & Schwarz NGM/NGL',
  /Rohde&Schwarz,? (NGM|NGL)2\d{2}/i,
  'HCOPy:DATA?',
  'png',
  { maxSize: IMAGE_SIZE_MAX_RS },
));

// Rohde & Schwarz RTH
registerPlugin(fileBasedPlugin(
  'rs-rth',
  'Rohde & Schwarz RTH',
  /Rohde&Schwarz,? RTH/i,
  {
    format: 'png',
    maxSize: IMAGE_SIZE_MAX_RS,
    preCommands: [':HCOPy:LANGuage PNG'],
    saveCommand: ':MMEMory:NAME \'/media/SD/lxi-tools-screenshot.png\'',
    waitCommand: null,
    readCommand: ':MMEMory:DATA? \'/media/SD/lxi-tools-screenshot.png\'',
    deleteCommand: ':MMEMory:DELete \'/media/SD/lxi-tools-screenshot.png\'',
    stripTmc: true,
  },
));

// Siglent SDG
registerPlugin(rawDumpPlugin(
  'siglent-sdg',
  'Siglent SDG',
  /Siglent Technologies,? SDG[126]\d{3}/i,
  'scdp',
  'bmp',
));

// Siglent SDM3000
registerPlugin(rawDumpPlugin(
  'siglent-sdm3000',
  'Siglent SDM3000',
  /Siglent Technologies,? SDM3\d{3}/i,
  'scdp',
  'bmp',
));

// Siglent SDS
registerPlugin(rawDumpPlugin(
  'siglent-sds',
  'Siglent SDS',
  /Siglent Technologies,? SDS[12]\d{3}/i,
  'scdp',
  'bmp',
));

// Siglent SSA3000X
registerPlugin(rawDumpPlugin(
  'siglent-ssa3000x',
  'Siglent SSA3000X',
  /Siglent Technologies,? SSA3\d{3}X/i,
  'scdp',
  'bmp',
));

// Tektronix 2000 series
registerPlugin(rawDumpPlugin(
  'tektronix-2000',
  'Tektronix DPO2000/MSO2000',
  /TEKTRONIX,? (DPO|MSO)2\d{3}/i,
  ['save:image:fileformat PNG', 'hardcopy:inksaver off', 'hardcopy start'],
  'png',
));

// Tektronix 3000 series
registerPlugin(rawDumpPlugin(
  'tektronix-3000',
  'Tektronix TDS3000',
  /TEKTRONIX,? TDS3\d{3}/i,
  ['hardcopy:Format bmpc', 'hardcopy start'],
  'bmp',
  { maxSize: 308278 },
));

// Tektronix MSO-5
registerPlugin(fileBasedPlugin(
  'tektronix-mso-5',
  'Tektronix MSO5000',
  /TEKTRONIX,? MSO5\d{3}/i,
  {
    format: 'png',
    maxSize: IMAGE_SIZE_MAX_TEK5,
    saveCommand: 'SAVE:IMAGE \'c:/lxi-tools-screenshot.png\'',
    waitCommand: '*WAI',
    readCommand: 'FILESYSTEM:READFILE \'c:/lxi-tools-screenshot.png\'',
    deleteCommand: 'FILESYSTEM:DELETE \'c:/lxi-tools-screenshot.png\'',
    stripTmc: false,
  },
));

// --- Public API ---

/**
 * List all registered screenshot plugins.
 * @returns {Array<{ name: string, description: string }>}
 */
export function listPlugins() {
  return plugins.map(plugin => ({ name: plugin.name, description: plugin.description }));
}

/**
 * Auto-detect which screenshot plugin to use based on instrument *IDN? response.
 *
 * @param {string} address - IP address of the instrument
 * @param {number} [timeout=10000] - Timeout in milliseconds
 * @returns {Promise<string|null>} Detected plugin name, or null
 */
export async function detectPlugin(address, timeout = 10000) {
  // Get instrument ID
  const device = await connect(address, 0, null, timeout, Protocol.VXI11);
  let id;
  try {
    await send(device, '*IDN?', timeout);
    const response = await receive(device, 4096, timeout);
    id = response.toString().trim();
  } finally {
    await disconnect(device);
  }

  if (!id) return null;

  // Match against plugin regex, plugin with most submatch tokens wins
  let bestPlugin = null;
  let bestMatchCount = 0;

  for (const plugin of plugins) {
    if (!plugin.regex) continue;
    // Split ID by spaces and count regex matches per token
    const tokens = id.split(/[\s,]+/);
    let matchCount = 0;
    for (const token of tokens) {
      if (plugin.regex.test(token)) matchCount++;
    }
    // Also test the full string
    if (plugin.regex.test(id)) matchCount++;
    if (matchCount > bestMatchCount) {
      bestMatchCount = matchCount;
      bestPlugin = plugin;
    }
  }

  return bestPlugin ? bestPlugin.name : null;
}

/**
 * Capture a screenshot from an LXI instrument.
 *
 * @param {string} address - IP address of the instrument
 * @param {object} [options]
 * @param {string} [options.plugin] - Plugin name (auto-detected if omitted)
 * @param {number} [options.timeout=10000] - Timeout in milliseconds
 * @returns {Promise<{ data: Buffer, format: string, plugin: string }>}
 */
export async function screenshot(address, options = {}) {
  const timeout = options.timeout ?? 10000;
  let pluginName = options.plugin;

  if (!address) throw new Error('Missing address');

  // Auto-detect plugin if not specified
  if (!pluginName) {
    pluginName = await detectPlugin(address, timeout);
    if (!pluginName) {
      throw new Error('Could not auto-detect screenshot plugin. Specify one explicitly.');
    }
  }

  // Find plugin
  const plugin = plugins.find(entry => entry.name === pluginName);
  if (!plugin) {
    throw new Error(`Unknown screenshot plugin: ${pluginName}`);
  }

  const result = await plugin.capture(address, null, timeout);
  return { ...result, plugin: pluginName };
}

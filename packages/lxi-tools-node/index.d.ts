/**
 * lxi-tools — Pure Node.js implementation for managing LXI compatible
 * instruments via VXI-11 and raw TCP protocols.
 */

// ─── Core LXI Connection ────────────────────────────────────────────

export declare namespace lxi {
	/** Supported communication protocols. */
	const Protocol: {
		readonly VXI11: 'VXI11';
		readonly RAW: 'RAW';
	};

	/** Protocol type union. */
	type ProtocolType = typeof Protocol[keyof typeof Protocol];

	/** Session information for a connected device. */
	interface SessionInfo {
		/** @internal */
		_session: any;
		protocol: ProtocolType;
		timeout: number;
	}

	/**
	 * Connect to an LXI instrument.
	 * @param address - IP address or hostname.
	 * @param port - Port number (0 = auto: 111 for VXI11, 5025 for RAW).
	 * @param name - VXI-11 device name.
	 * @param timeout - Timeout in milliseconds.
	 * @param protocol - Communication protocol.
	 * @returns Device handle (integer).
	 */
	function connect(
		address: string,
		port?: number,
		name?: string,
		timeout?: number,
		protocol?: ProtocolType,
	): Promise<number>;

	/**
	 * Send data to a connected LXI instrument.
	 * @param device - Device handle from {@link connect}.
	 * @param command - Data to send.
	 * @param timeout - Timeout in milliseconds.
	 * @returns Number of bytes sent.
	 */
	function send(
		device: number,
		command: string | Buffer,
		timeout?: number,
	): Promise<number>;

	/**
	 * Receive data from a connected LXI instrument.
	 * @param device - Device handle from {@link connect}.
	 * @param maxLength - Maximum response length in bytes (default 5 MB).
	 * @param timeout - Timeout in milliseconds.
	 * @returns Response data.
	 */
	function receive(
		device: number,
		maxLength?: number,
		timeout?: number,
	): Promise<Buffer>;

	/**
	 * Disconnect from an LXI instrument.
	 * @param device - Device handle from {@link connect}.
	 */
	function disconnect(device: number): Promise<void>;

	/**
	 * Get session info for a device.
	 * @param device - Device handle.
	 * @returns Session info, or `undefined` if the handle is invalid.
	 */
	function getSessionInfo(device: number): SessionInfo | undefined;
}

// ─── Discovery ───────────────────────────────────────────────────────

export declare namespace discovery {
	/** A device found via VXI-11 broadcast discovery. */
	interface DiscoveredDevice {
		address: string;
		id: string;
	}

	/** A service found via mDNS/DNS-SD discovery. */
	interface DiscoveredService {
		address: string;
		id: string;
		service: string;
		port: number;
	}

	/** Options for VXI-11 broadcast discovery. */
	interface DiscoverVxi11Options {
		/** Discovery timeout in milliseconds (default 1000). */
		timeout?: number;
		/** Called with the interface name for each broadcast interface. */
		onBroadcast?: (interfaceName: string) => void;
		/** Called for each device found. */
		onDevice?: (device: DiscoveredDevice) => void;
	}

	/**
	 * Discover LXI devices on the network via VXI-11 broadcast.
	 * @param options - Discovery options.
	 */
	function discoverVxi11(
		options?: DiscoverVxi11Options,
	): Promise<DiscoveredDevice[]>;

	/** Options for mDNS/DNS-SD discovery. */
	interface DiscoverMdnsOptions {
		/** Discovery timeout in milliseconds (default 5000). */
		timeout?: number;
		/** Called for each service found. */
		onService?: (service: DiscoveredService) => void;
	}

	/**
	 * Discover LXI devices via mDNS/DNS-SD.
	 * @param options - Discovery options.
	 */
	function discoverMdns(
		options?: DiscoverMdnsOptions,
	): Promise<DiscoveredService[]>;

	/** Options for the unified discovery function. */
	interface DiscoverOptions extends DiscoverVxi11Options, DiscoverMdnsOptions {
		/** Use mDNS/DNS-SD instead of VXI-11 broadcast (default false). */
		mdns?: boolean;
	}

	/**
	 * Discover LXI devices. Delegates to {@link discoverVxi11} or {@link discoverMdns}.
	 * @param options - Discovery options.
	 */
	function discover(
		options?: DiscoverOptions,
	): Promise<DiscoveredDevice[] | DiscoveredService[]>;
}

// ─── SCPI ────────────────────────────────────────────────────────────

export declare namespace SCPI {
	/** Options for the {@link scpi} function. */
	interface ScpiOptions {
		/** Port number (0 = auto). */
		port?: number;
		/** Timeout in milliseconds (default 3000). */
		timeout?: number;
		/** Communication protocol (default 'VXI11'). */
		protocol?: lxi.ProtocolType;
		/** SCPI command string. */
		command: string;
	}

	/**
	 * Send a SCPI command to an LXI instrument and optionally receive a response.
	 * @param address - IP address of the instrument.
	 * @param options - SCPI options including the command.
	 * @returns Response string if the command is a query, `null` otherwise.
	 */
	function scpi(
		address: string,
		options?: ScpiOptions,
	): Promise<string | null>;

	/**
	 * Send a SCPI command on an already-connected device.
	 * @param device - Device handle from {@link lxi.connect}.
	 * @param command - SCPI command string.
	 * @param timeout - Override session timeout.
	 * @returns Response string if the command is a query, `null` otherwise.
	 */
	function scpiOnDevice(
		device: number,
		command: string,
		timeout?: number,
	): Promise<string | null>;

	/**
	 * Send a raw SCPI command (no newline appended, no response stripping).
	 * @param device - Device handle from {@link lxi.connect}.
	 * @param command - Raw command data.
	 * @param timeout - Timeout in milliseconds.
	 * @returns Raw response buffer if the command is a query, `null` otherwise.
	 */
	function scpiRaw(
		device: number,
		command: string | Buffer,
		timeout?: number,
	): Promise<Buffer | null>;

	/**
	 * Check if a SCPI command is a query (contains '?').
	 * @param command - SCPI command string.
	 */
	function isQuery(command: string): boolean;
}

// ─── Benchmark ───────────────────────────────────────────────────────

export declare namespace Benchmark {
	/** Options for the {@link benchmark} function. */
	interface BenchmarkOptions {
		/** Port number (0 = auto). */
		port?: number;
		/** Timeout in milliseconds (default 3000). */
		timeout?: number;
		/** Communication protocol (default 'VXI11'). */
		protocol?: lxi.ProtocolType;
		/** Number of *IDN? requests to send (default 100). */
		count?: number;
		/** Called with the current count after each request. */
		onProgress?: (currentCount: number) => void;
	}

	/** Result of a benchmark run. */
	interface BenchmarkResult {
		/** Measured requests per second. */
		requestsPerSecond: number;
		/** Total number of requests sent. */
		count: number;
		/** Elapsed time in seconds. */
		elapsed: number;
	}

	/**
	 * Benchmark an LXI instrument by sending repeated *IDN? requests.
	 * @param address - IP address of the instrument.
	 * @param options - Benchmark options.
	 */
	function benchmark(
		address: string,
		options?: BenchmarkOptions,
	): Promise<BenchmarkResult>;
}

// ─── Screenshot ──────────────────────────────────────────────────────

export declare namespace Screenshot {
	/** Options for the {@link screenshot} function. */
	interface ScreenshotOptions {
		/** Plugin name (auto-detected if omitted). */
		plugin?: string;
		/** Timeout in milliseconds (default 10000). */
		timeout?: number;
	}

	/** Result of a screenshot capture. */
	interface ScreenshotResult {
		/** Raw image data. */
		data: Buffer;
		/** Image format (e.g. 'png', 'bmp', 'gif'). */
		format: string;
		/** Name of the plugin used. */
		plugin: string;
	}

	/** Metadata for a registered screenshot plugin. */
	interface PluginInfo {
		name: string;
		description: string;
	}

	/**
	 * Capture a screenshot from an LXI instrument.
	 * @param address - IP address of the instrument.
	 * @param options - Screenshot options.
	 */
	function screenshot(
		address: string,
		options?: ScreenshotOptions,
	): Promise<ScreenshotResult>;

	/**
	 * Auto-detect which screenshot plugin to use based on instrument *IDN? response.
	 * @param address - IP address of the instrument.
	 * @param timeout - Timeout in milliseconds (default 10000).
	 * @returns Detected plugin name, or `null`.
	 */
	function detectPlugin(
		address: string,
		timeout?: number,
	): Promise<string | null>;

	/**
	 * List all registered screenshot plugins.
	 */
	function listPlugins(): PluginInfo[];
}

// ─── VXI-11 Low-level (Advanced) ────────────────────────────────────

export declare namespace vxi11 {
	/** VXI-11 session for direct device communication. */
	class Vxi11Session {
		/**
		 * Send data to the instrument.
		 * @param data - Data to send.
		 * @param timeout - Timeout in milliseconds.
		 * @returns Number of bytes sent.
		 */
		send(data: string | Buffer, timeout?: number): Promise<number>;

		/**
		 * Receive data from the instrument.
		 * @param maxLength - Maximum response length.
		 * @param timeout - Timeout in milliseconds.
		 */
		receive(maxLength?: number, timeout?: number): Promise<Buffer>;

		/** Close the VXI-11 session and destroy the link. */
		close(): Promise<void>;
	}

	/**
	 * Establish a VXI-11 connection to an instrument.
	 * @param host - IP address or hostname.
	 * @param port - Port number (0 or 111 triggers portmapper lookup).
	 * @param name - VXI-11 device name (default 'inst0').
	 * @param timeout - Timeout in milliseconds.
	 */
	function vxi11Connect(
		host: string,
		port: number,
		name: string,
		timeout: number,
	): Promise<Vxi11Session>;

	/**
	 * Resolve the VXI-11 TCP port via the portmapper service.
	 * @param host - IP address or hostname.
	 * @param timeout - Timeout in milliseconds.
	 * @returns The VXI-11 port number.
	 */
	function getVxi11Port(
		host: string,
		timeout?: number,
	): Promise<number>;
}

// ─── RPC/XDR Utilities (Advanced) ───────────────────────────────────

export declare namespace rpc {
	/** XDR (External Data Representation) encoder. */
	class XdrWriter {
		constructor(size?: number);
		writeInt32(value: number): void;
		writeUInt32(value: number): void;
		writeOpaque(data: Buffer | string): void;
		writeString(string: string): void;
		toBuffer(): Buffer;
	}

	/** XDR (External Data Representation) decoder. */
	class XdrReader {
		constructor(buffer: Buffer);
		readInt32(): number;
		readUInt32(): number;
		readOpaque(): Buffer;
		readString(): string;
		remaining(): number;
	}
}

/**
 * VXI-11 mock instrument device for testing lxi-tools-node.
 */

export declare class MockDevice {
	/**
	 * Create a mock VXI-11 instrument.
	 * @param options - Device configuration.
	 */
	constructor(options?: MockDeviceOptions);

	/** TCP port the portmapper is listening on (available after {@link start}). */
	readonly portmapperPort: number;

	/** TCP port the VXI-11 core channel is listening on (available after {@link start}). */
	readonly vxi11Port: number;

	/** Listen address. */
	readonly host: string;

	/** Configured *IDN? identity string. */
	readonly identity: string;

	/**
	 * Register a SCPI command handler.
	 * Commands are matched case-insensitively.
	 *
	 * @param command - SCPI command to handle (e.g. `'*IDN?'`, `':DISP:DATA?'`).
	 * @param handler - Function invoked when the command is received.
	 * @returns `this` for chaining.
	 */
	handle(command: string, handler: ScpiHandler): this;

	/**
	 * Remove a previously registered SCPI handler.
	 * @param command - SCPI command to remove.
	 * @returns `true` if a handler was removed.
	 */
	removeHandler(command: string): boolean;

	/**
	 * Start the mock device (portmapper + VXI-11 TCP servers).
	 * Use port `0` for OS-assigned ephemeral ports (recommended for tests).
	 *
	 * @param portmapperPort - Port for the portmapper service (default `0`).
	 * @param vxi11Port - Port for the VXI-11 core channel (default `0`).
	 */
	start(portmapperPort?: number, vxi11Port?: number): Promise<void>;

	/**
	 * Stop the mock device and release all resources.
	 */
	stop(): Promise<void>;
}

export interface MockDeviceOptions {
	/**
	 * Identity string returned by `*IDN?`.
	 * @default 'MOCK,MockDevice,SN001,1.0.0'
	 */
	identity?: string;

	/**
	 * VXI-11 maxReceiveSize reported to clients.
	 * @default 0x100000 (1 MB)
	 */
	maxReceiveSize?: number;

	/**
	 * RPC record-marking fragment size in bytes.
	 * When set to a positive value, RPC replies are split into multiple
	 * fragments of this size — useful for regression-testing the client's
	 * multi-fragment record-marking parser (see issue #001).
	 *
	 * `0` means single-fragment (default).
	 */
	fragmentSize?: number;

	/**
	 * Listen address for all TCP servers.
	 * @default '127.0.0.1'
	 */
	host?: string;
}

/**
 * A function that handles a SCPI command and returns a response.
 *
 * - Return a `string` or `Buffer` to send as the device_read response.
 * - Return `null` / `undefined` for set commands (no response).
 * - May be async.
 */
export type ScpiHandler = (
	command: string,
) => Buffer | string | null | undefined | Promise<Buffer | string | null | undefined>;

import { Transform } from 'node:stream';
export interface RunnerConfig {
    args?: string[];
    env?: Record<string, string | undefined>;
    handshakeTimeoutMs?: number;
    command?: string;
}
export declare function validateAndFormatServerArgs(config: RunnerConfig, command: string): string[];
/**
 * Ensure the dlopen memfd interceptor shim is compiled if running on Linux PRoot.
 */
export declare function ensureDlopenShim(binDir: string): string | undefined;
export declare function prepareRunnerEnv(baseEnv?: NodeJS.ProcessEnv, binDir?: string): NodeJS.ProcessEnv;
export declare const DEFAULT_HANDSHAKE_TIMEOUT_MS = 120000;
export declare function createStdoutJsonFilter(): Transform;

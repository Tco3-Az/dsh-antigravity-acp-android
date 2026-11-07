export interface PatchStats {
    faccessat2: number;
    tcmallocTagMask: number;
    tcmallocTagShift: number;
    tcmallocTotal: number;
}
export interface PatchResult {
    patched: boolean;
    sha256Before: string;
    sha256After: string;
    matches: PatchStats;
    totalPatches: number;
}
export interface ByteRange {
    start: number;
    end: number;
}
/**
 * Locate all `google_malloc` ELF sections in the outer binary and any embedded ARM64 ELFs.
 */
export declare function findGoogleMallocSections(buffer: Buffer): ByteRange[];
export declare function patchArm64Binary(buffer: Buffer): PatchResult;
/**
 * Patch an ARM64 ELF executable or .par hybrid binary on disk.
 * For large hybrid binaries (>200MB like agy_acp_server.par), patches ELF sections in-place
 * to avoid OOM on mobile devices and never touches appended .par ZIP archives.
 */
export declare function patchExecutableFile(filePath: string): Promise<PatchResult>;
export interface EnsurePatchedOptions {
    cacheDir?: string;
    sourceZip?: string;
    notify?: (msg: string) => void;
}
export declare function ensurePatchedServer(options?: EnsurePatchedOptions): Promise<{
    serverBin: string;
    helperBin: string;
    patchResultServer: PatchResult;
    patchResultHelper: PatchResult;
}>;

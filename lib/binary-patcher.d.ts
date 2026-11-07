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
/**
 * Patch TCMalloc instructions inside a buffer slice (scoped to google_malloc).
 * Translates tag operations to bits 39..41 and bounds hints to 2^38.
 */
export declare function patchTcmallocSlice(slice: Buffer, allowRaw64BitLiterals: boolean): {
    maskHits: number;
    shiftHits: number;
};
/**
 * Patch Syscall 439 (faccessat2) -> Syscall 48 (faccessat).
 */
export declare function patchSyscall439(buffer: Buffer): number;
/**
 * Patch an ARM64 binary buffer in memory. Scopes TCMalloc patches to `google_malloc` sections.
 */
export declare function patchArm64Binary(buffer: Buffer): PatchResult;
/**
 * Patch an executable file on disk. Scopes large binaries (>200MB) to ELF `google_malloc` sections.
 */
export declare function patchExecutableFile(filePath: string): Promise<PatchResult>;
export interface EnsurePatchedOptions {
    cacheDir?: string;
    notify?: (msg: string) => void;
}
export declare function ensurePatchedServer(options?: EnsurePatchedOptions): Promise<{
    serverBin: string;
    helperBin: string;
    patchResultServer: PatchResult;
    patchResultHelper: PatchResult;
}>;

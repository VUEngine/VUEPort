/**
 * The color editor's compiler, off the page's thread: building a VB Color package with paint takes a second or more
 * (Mario Clash about two), which would hold the page still. The editor sends a package once (its bytes, by a key) and
 * then paint layers to build it with; the worker keeps the read package and answers each build with the ROM
 * (transferred) and the compiler's report. See `ColorCompiler` in browser/color/vb-color-compiler.ts.
 */
import { ColorPackage, compileColorPackage, readColorPackage } from '../common/vb-color-package';
import { ColorCompileReply, ColorCompileRequest } from '../common/vb-color-compile-protocol';

const scope = self as unknown as {
    onmessage: ((event: MessageEvent<ColorCompileRequest>) => void) | null;
    postMessage(message: ColorCompileReply, transfer?: Transferable[]): void;
};

let held: { key: string, pkg: Promise<ColorPackage> } | undefined;
let original: { key: string, rom: Uint8Array } | undefined;

scope.onmessage = event => {
    const request = event.data;
    (async (): Promise<void> => {
        if (request.packageBytes) {
            held = { key: request.packageKey, pkg: readColorPackage(request.packageBytes, request.runtimeBps) };
        }
        if (request.original) {
            original = { key: request.packageKey, rom: request.original };
        }
        if (!held || held.key !== request.packageKey || !original || original.key !== request.packageKey) {
            throw new Error('the compiler was not given this package');
        }
        const build = compileColorPackage(await held.pkg, original.rom, request.paint);
        scope.postMessage({ id: request.id, rom: build.rom, stats: build.stats }, [build.rom.buffer]);
    })().catch(error => scope.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
        errorCode: (error as { code?: string } | undefined)?.code,
        errorArea: (error as { area?: number } | undefined)?.area,
        errorContext: (error as { context?: string | number } | undefined)?.context,
        errorDetail: (error as { detail?: string } | undefined)?.detail,
        errorGroups: (error as { groups?: number } | undefined)?.groups,
        errorPatchGroups: (error as { patchGroups?: number } | undefined)?.patchGroups,
        errorRoom: (error as { room?: number } | undefined)?.room,
    }));
};

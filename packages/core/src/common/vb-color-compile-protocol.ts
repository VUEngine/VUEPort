import { ColorPaintLayer } from './vb-color-package';

// a build request for the color editor's compile worker (vb-color-compile-worker.ts)
export interface ColorCompileRequest {
    id: number;
    packageKey: string;
    packageBytes?: Uint8Array; // only sent while the worker does not hold the package yet
    // the shipped BPS, for a package that only carries its hash as runtime (vb-color-package-file.ts)
    runtimeBps?: Uint8Array;
    original?: Uint8Array; // likewise
    paint: ColorPaintLayer;
}

export interface ColorCompileReply {
    id: number;
    rom?: Uint8Array;
    stats?: { [name: string]: unknown };
    error?: string;
    // typed compiler errors (vbcpkg.mjs DataAreaFull, ContextPaintError, PaletteGroupsFull), see colorBuildErrorText
    errorCode?: string;
    errorArea?: number;
    errorContext?: string | number;
    errorDetail?: string;
    errorGroups?: number;
    errorPatchGroups?: number;
    errorRoom?: number;
}

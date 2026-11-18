// brotli-wasm's web build and its wasm, aliased to these names in packages/web/esbuild.mjs since the package's
// `exports` hide the files. Used to encode exported VB Color packages (emulator-color-exchange.ts)
declare module 'brotli-wasm-web' {
    export default function init(input?: BufferSource | WebAssembly.Module): Promise<unknown>;
    export function compress(buf: Uint8Array, options?: { quality?: number }): Uint8Array;
}

declare module 'brotli-wasm-web-bytes' {
    const bytes: Uint8Array;
    export default bytes;
}

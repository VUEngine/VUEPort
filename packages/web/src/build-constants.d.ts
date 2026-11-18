// file names the build decides on (see esbuild.mjs): the worker, audio worklet and core wasm are loaded by URL at
// runtime, so a bundler cannot rewrite them, and production builds give each a content hash for caching

// from the product's own package.json
declare const VUEPORT_VERSION: string;
declare const VUEPORT_WORKER_URL: string;
declare const VUEPORT_AUDIO_WORKLET_URL: string;
declare const VUEPORT_WASM_URL: string;
declare const VUEPORT_PROBE_WORKER_URL: string;
declare const VUEPORT_COLOR_WORKER_URL: string;
// where a development build serves its own VB Color packages; '' in a release, which fetches packages.vueport.net's
declare const VUEPORT_COLOR_PACKAGES_URL: string;

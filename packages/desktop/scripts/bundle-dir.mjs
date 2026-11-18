// where a bundle lands: VUEPORT_TARGET names a Rust target triple (the release builds aarch64- and x86_64-apple-darwin
// apart), and Cargo puts such a build under target/<triple>/; unset or empty builds for this machine
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const target = process.env.VUEPORT_TARGET || undefined;

export const tauri = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri');

export const bundleDir = path.join(tauri, 'target', ...(target ? [target] : []), 'release', 'bundle');

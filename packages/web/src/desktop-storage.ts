import { VueportFile, VueportStorage, VueportUsage } from 'vueport-core/lib/common/emulator-host';
import { bytesFrom, invoke, invokeWithBytes } from './desktop-bridge';

// the emulator's files as real files under the desktop storage root (~/.vueport on macOS) rather than in OPFS, where
// they can be backed up or copied. Paths are unchanged (`roms/Red Alarm/save.sram`); the shell resolves them under
// the root and refuses anything that would escape it
export class DesktopStorage implements VueportStorage {

    async read(path: string): Promise<Uint8Array> {
        return bytesFrom(await invoke<ArrayBuffer>('storage_read', { path }));
    }

    async readText(path: string): Promise<string> {
        return new TextDecoder().decode(await this.read(path));
    }

    async write(path: string, data: Uint8Array): Promise<void> {
        // the bytes as the body, the path in a header (see invokeWithBytes); this write keeps a ROM for the start page and
        // used to stall when a large cartridge was opened
        await invokeWithBytes('storage_write', data, { 'x-vueport-path': path });
    }

    async writeText(path: string, text: string): Promise<void> {
        await this.write(path, new TextEncoder().encode(text));
    }

    async exists(path: string): Promise<boolean> {
        return invoke<boolean>('storage_exists', { path });
    }

    async delete(path: string): Promise<void> {
        await invoke('storage_delete', { path });
    }

    async list(directory: string): Promise<VueportFile[]> {
        return invoke<VueportFile[]>('storage_list', { directory });
    }

    async measure(directory: string): Promise<VueportUsage> {
        return invoke<VueportUsage>('storage_measure', { directory });
    }

    // unlike the browser's, these path helpers also take real paths, as a ROM beside its save may be at
    // `C:\\Games\\Red Alarm.vb` or `/Users/someone/Games/Red Alarm.vb`

    protected lastSeparator(path: string): number {
        return Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    }

    parent(path: string): string {
        const index = this.lastSeparator(path);
        return index <= 0 ? '' : path.slice(0, index);
    }

    stem(path: string): string {
        const name = this.name(path);
        const dot = name.lastIndexOf('.');
        return dot <= 0 ? name : name.slice(0, dot);
    }

    name(path: string): string {
        const index = this.lastSeparator(path);
        return index < 0 ? path : path.slice(index + 1);
    }

    // with the separator the directory already uses, so a Windows path stays a Windows path
    join(directory: string, name: string): string {
        if (!directory) {
            return name;
        }
        const separator = directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
        return `${directory.replace(/[\\/]+$/, '')}${separator}${name}`;
    }

    async export(name: string, data: Uint8Array): Promise<void> {
        // the bytes as the body, as Tauri's ordinary argument encoding would turn every byte of a tens-of-megabytes video
        // into a decimal number in JSON
        await invokeWithBytes('storage_export', data, { 'x-vueport-name': name });
    }

    async exportBlob(name: string, blob: Blob): Promise<void> {
        await this.export(name, new Uint8Array(await blob.arrayBuffer()));
    }

    async location(): Promise<string> {
        return invoke<string>('storage_root');
    }
}

// not a method, as the Library pane offers it without having a storage of this kind to hand
export async function revealStorage(): Promise<void> {
    await invoke<void>('storage_reveal');
}

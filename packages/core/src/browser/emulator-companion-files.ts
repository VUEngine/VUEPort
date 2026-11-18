// paths of a ROM's save, save states and cheats per the companionFiles setting. Beside the ROM each file carries the
// ROM's name like in other emulators (`Red Alarm (USA).p1.sram`); in the store each ROM gets a folder of its own
// (`roms/Red Alarm (USA)/save.sram`)
import {
    DEFAULT_SAVE_SLOT,
    EmulatorCompanionLocation,
    emulatorSaveSlot,
} from '../common/emulator-sram';
import { VueportStorage } from '../common/emulator-host';

export interface CompanionRom {
    name: string;
    // path of the ROM file, if the host knows it (never in a browser). For a ROM from an archive this is the
    // archive, so its file name differs from `name` (see besideStem)
    location?: string;
}

export const COMPANION_STORE_ROOT = 'roms';

const SHARED_ROOT = 'shared';

// archives that hold a single cartridge; same list as the web package's VB_ARCHIVE_EXTENSIONS, which core can't import
const CARTRIDGE_ARCHIVE_EXTENSIONS = ['.vb.zip', '.vbz'];

export class EmulatorCompanionFiles {

    constructor(
        protected readonly storage: VueportStorage,
        protected readonly location: () => EmulatorCompanionLocation,
    ) { }

    // can differ from the setting: a ROM without a known location falls back to the store, and the host may want
    // to tell the user
    besideRom(rom: CompanionRom): boolean {
        return this.location() === EmulatorCompanionLocation.ROM && rom.location !== undefined;
    }

    directory(rom: CompanionRom): string {
        return this.besideRom(rom)
            // location is defined whenever besideRom is true
            ? this.storage.parent(rom.location as string)
            : this.storeDirectory(rom);
    }

    protected storeDirectory(rom: CompanionRom): string {
        return this.storage.join(COMPANION_STORE_ROOT, this.storage.stem(rom.name));
    }

    protected unpacked(rom: CompanionRom): boolean {
        return rom.location !== undefined && this.storage.name(rom.location) !== rom.name;
    }

    // named after the file on disk, so Red Alarm.vbz gets Red Alarm.p1.sram whatever the ROM inside is called. A plain
    // .zip uses the ROM inside, as it may hold a whole collection that mustn't share one save
    protected besideStem(rom: CompanionRom): string {
        if (!this.unpacked(rom)) {
            return this.storage.stem(rom.name);
        }
        const file = this.storage.name(rom.location as string);
        const archive = CARTRIDGE_ARCHIVE_EXTENSIONS
            .find(extension => file.toLowerCase().endsWith(extension));
        return archive !== undefined && file.length > archive.length
            ? file.slice(0, -archive.length)
            : this.storage.stem(rom.name);
    }

    // global macros are always kept in the store, as they outlive the game they were recorded in
    globalMacros(): string {
        return this.storage.join(SHARED_ROOT, 'macros.vueport-macros.json');
    }

    // the path the cheat store derives the .cht from; it need not exist
    romPath(rom: CompanionRom): string {
        if (!this.besideRom(rom)) {
            return this.storage.join(this.directory(rom), rom.name);
        }
        // always with an extension, so taking the stem off later can't cut into a name like `Mario Clash (v1.1)`
        const extension = rom.name.slice(this.storage.stem(rom.name).length) || '.vb';
        return this.storage.join(this.directory(rom), `${this.besideStem(rom)}${extension}`);
    }

    // per player even when playing alone, as both machines of a link session have a cartridge; the store keeps
    // save.sram for player one. Slot A gets no suffix in either layout, so it's the file another emulator would read
    // (see EMULATOR_SAVE_SLOTS)
    saveRam(rom: CompanionRom, player = 1, slot: string = DEFAULT_SAVE_SLOT): string {
        const named = emulatorSaveSlot(slot);
        const suffix = named === DEFAULT_SAVE_SLOT ? '' : `.${named}`;
        return this.besideRom(rom)
            ? this.storage.join(
                this.directory(rom), `${this.besideStem(rom)}.p${player}${suffix}.sram`)
            : this.storage.join(
                this.directory(rom),
                player > 1 ? `save-${player}${suffix}.sram` : `save${suffix}.sram`);
    }

    // a linked pair is one state in one file (see wrapSaveState); the id is when it was taken. Beside the ROM the id
    // goes before the extension, so one game's files sort together
    saveState(rom: CompanionRom, id: string): string {
        return this.besideRom(rom)
            ? this.storage.join(this.directory(rom), `${this.besideStem(rom)}.${id}.state`)
            : this.storage.join(this.directory(rom), `state-${id}.state`);
    }

    // inverse of saveState: the file names are the index, so the browser lists a folder instead of keeping one
    saveStateId(rom: CompanionRom, fileName: string): string | undefined {
        if (!fileName.endsWith('.state')) {
            return undefined;
        }
        const body = fileName.slice(0, -'.state'.length);
        const prefix = this.besideRom(rom) ? `${this.besideStem(rom)}.` : 'state-';
        return body.length > prefix.length && body.startsWith(prefix)
            ? body.slice(prefix.length)
            : undefined;
    }

    // ESSound tracks are looked for in the ROM's folder whatever companionFiles says, as real hardware reads them
    // from there. Tracks from an archive are unpacked into the store instead, so we never write into the user's folder
    sounds(rom: CompanionRom): string {
        return rom.location !== undefined && !this.unpacked(rom)
            ? this.storage.parent(rom.location)
            : this.storeDirectory(rom);
    }
}

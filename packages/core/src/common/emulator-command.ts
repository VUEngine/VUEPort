/**
 * A command, as the emulator describes one.
 *
 * Deliberately the same shape as Theia's `Command`, so that the emulator's
 * commands can still be handed straight to Theia's registry while the emulator
 * itself knows nothing about it. A host with no command system of its own can
 * treat these as what they are: an id, something to call it, and a group.
 */
import { nls } from './emulator-nls';

/**
 * Reached through a local name so that `yarn nls-extract` does not try to read
 * a key out of the calls below: it matches the text `nls.localize`, and the
 * keys here are whatever a caller passed rather than literals it could see.
 * The keys it *should* find are the ones in the `Command.toLocalizedCommand`
 * calls themselves, which it handles separately.
 */
const localize = nls.localize;

export interface Command {
    id: string;
    label?: string;
    /** The English label, before translation. */
    originalLabel?: string;
    iconClass?: string;
    category?: string;
    /** The English category, before translation. */
    originalCategory?: string;
}

/**
 * A command whose label and category are translated when they are read.
 *
 * Theia's `Command.toLocalizedCommand` translates them there and then, which
 * works because Theia has its localization loaded before any extension module
 * runs. The emulator's does not: `setLocalization` is called during start-up,
 * by which time this module has long since been imported. So the strings are
 * resolved on access instead — every command here is a module-level constant,
 * and reading `.label` at registration time is late enough for the host to have
 * installed its translations.
 *
 * **The name is load-bearing**, the same way `nls.localize` is: `yarn
 * nls-extract` finds a command's strings by matching the callee text
 * `Command.toLocalizedCommand` exactly. Spelled any other way, all 42 of the
 * emulator's commands drop out of `nls.json` without a word.
 *
 * The accessors are installed with `defineProperty` rather than written as
 * getters in the object literal, because TypeScript downlevels a spread to
 * `Object.assign` — and `Object.assign` *reads* a getter on its source and
 * copies the value across, which would freeze every label at whatever it was
 * before the host had said anything. For the same reason nothing may copy a
 * command with `{ ...command }` afterwards.
 */
export namespace Command {
    export function toLocalizedCommand(
        command: Command,
        labelKey?: string,
        categoryKey?: string,
    ): Command {
        const localized: Command = {
            ...command,
            originalLabel: command.label,
            originalCategory: command.category,
        };
        Object.defineProperty(localized, 'label', {
            enumerable: true,
            get: () => command.label && localize(labelKey ?? command.id, command.label),
        });
        Object.defineProperty(localized, 'category', {
            enumerable: true,
            get: () => categoryKey && command.category
                ? localize(categoryKey, command.category)
                : command.category,
        });
        return localized;
    }
}

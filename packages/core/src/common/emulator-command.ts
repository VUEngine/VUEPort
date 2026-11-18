// same shape as Theia's Command, so the emulator's commands can be handed to Theia's registry
import { nls } from './emulator-nls';

// a local alias, so yarn nls-extract (which matches the text nls.localize) doesn't read keys from the calls below
const localize = nls.localize;

export interface Command {
    id: string;
    label?: string;
    originalLabel?: string;
    iconClass?: string;
    category?: string;
    originalCategory?: string;
}

/**
 * A command whose label and category are translated when read: unlike Theia's, the emulator's localization is installed
 * during start-up, long after these module-level constants are created. The name is load-bearing: `yarn nls-extract`
 * matches the callee text Command.toLocalizedCommand exactly, or all the commands drop out of nls.json silently. The
 * accessors use defineProperty because TypeScript downlevels a spread to Object.assign, which reads getters and would
 * freeze every label; never copy a command with spread.
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

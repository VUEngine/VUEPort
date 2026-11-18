import { VueportNotifications } from '../../common/emulator-host';
import { nls } from '../../common/emulator-nls';

export const RESTART_CONFIRM = (): string => nls.localize(
    'vueport/patches/restartConfirm',
    'The emulation needs to be reset for the ROM to pick up the change. \
Anything since your last save will be lost.',
);

// a patch is applied by rebuilding the machine from the original ROM, so switching one either way restarts the game
// and loses anything since the last save
export function confirmPatchRestart(
    notifications: VueportNotifications,
    enable: boolean,
    notes: string[] = [],
): Promise<boolean> {
    return notifications.confirm({
        title: enable
            ? nls.localize('vueport/patches/applyQuestion', 'Apply Patch?')
            : nls.localize('vueport/patches/disableQuestion', 'Disable Patch?'),
        message: [
            ...notes,
            RESTART_CONFIRM(),
        ],
        okLabel: enable
            ? nls.localize('vueport/vbColor/applyAndRestart', 'Apply and Restart')
            : nls.localize('vueport/patches/disableAndRestart', 'Disable and Restart'),
    });
}

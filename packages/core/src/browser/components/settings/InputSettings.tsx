import * as React from 'react';
import { GamepadDatabase, GamepadProfileFile, GamepadUiAction } from '../../../common/emulator-gamepad-profiles';
import { VueportNotifications } from '../../../common/emulator-host';
import { nls } from '../../../common/emulator-nls';
import { VueportInputBindings, VueportSettings } from '../../../common/emulator-settings';
import RadioSelect from '../kit/RadioSelect';
import { useXrLayout } from '../xr-layout';
import GamePadBindings from './GamePadBindings';
import KeyboardBindings from './KeyboardBindings';
import TouchSettings from './TouchSettings';

// the Input pane: the keymaps of both players, and the controller mapping, which belongs to the device rather than
// a player. Only owns the tab strip and the current page; each page draws its own top row (see input-fields.tsx)

export type InputSettingsPage = 'player1' | 'player2' | 'gamePads' | 'touch';

const PAGE_VALUES: Record<InputSettingsPage, number> = { player1: 1, player2: 2, gamePads: 3, touch: 4 };

export interface InputSettingsProps {
    settings: VueportSettings;
    bindings: VueportInputBindings;
    notifications: VueportNotifications;
    loadGamepadDatabase?: () => Promise<GamepadDatabase | undefined>;
    exportFile?: (name: string, data: Uint8Array) => Promise<void>;
    shareProfile?: (file: GamepadProfileFile, note: string) => Promise<'received' | 'duplicate'>;
    gamepadUiActions?: readonly GamepadUiAction[];
    onChange?: () => void;
    // for a link straight to one page (the status bar's controller entry); read once, on mount
    initialPage?: InputSettingsPage;
    // only given by a host with an on-screen controller; enables the Touch page and its layout editor button
    onEditTouchLayout?: () => void;
    search?: string;
}

export default function InputSettings(props: InputSettingsProps): React.JSX.Element {
    const {
        settings, bindings, notifications, loadGamepadDatabase, exportFile, shareProfile, gamepadUiActions, onChange,
        initialPage, onEditTouchLayout, search,
    } = props;
    const [chosen, setPage] = React.useState(() => PAGE_VALUES[initialPage ?? 'player1']);
    // in a headset nobody plays on the keyboard, so only the pads page is left and no tabs are needed
    const inHeadset = useXrLayout();
    const page = inHeadset ? 3 : chosen;

    const tabs = inHeadset ? undefined : <RadioSelect
        options={[
            { value: 1, label: nls.localize('vueport/input/player1', 'Player 1') },
            { value: 2, label: nls.localize('vueport/input/player2', 'Player 2') },
            { value: 3, label: nls.localize('vueport/input/gamePads/title', 'Game Pads') },
            ...onEditTouchLayout ? [{ value: 4, label: nls.localize('vueport/input/touch', 'Touch') }] : [],
        ]}
        defaultValue={page}
        onChange={options => setPage(options[0].value as number)}
    />;

    if (page === 4 && onEditTouchLayout) {
        return <TouchSettings settings={settings} tabs={tabs} onEditLayout={onEditTouchLayout} search={search} />;
    }

    if (page === 3) {
        return <GamePadBindings
            tabs={tabs}
            notifications={notifications}
            settings={settings}
            loadDatabase={loadGamepadDatabase}
            exportFile={exportFile}
            shareProfile={shareProfile}
            uiActions={gamepadUiActions}
            onChange={onChange}
        />;
    }

    return <KeyboardBindings
        // remounted per player, which drops a capture in progress when the page changes
        key={page}
        tabs={tabs}
        player={page === 2 ? 2 : 1}
        settings={settings}
        bindings={bindings}
        loadDatabase={loadGamepadDatabase}
        onChange={onChange}
    />;
}

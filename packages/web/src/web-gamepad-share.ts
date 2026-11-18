// sends a controller profile to vueport-server, which only keeps it for review
// (packages/server/src/gamepad_profiles.php)
import type { GamepadProfileFile } from 'vueport-core/lib/common/emulator-gamepad-profiles';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { GAMEPAD_PROFILES_URL } from './web-proxy';

export async function shareGamepadProfile(
    profile: GamepadProfileFile,
    note: string,
): Promise<'received' | 'duplicate'> {
    let response: Response;
    try {
        response = await fetch(GAMEPAD_PROFILES_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ profile, note }),
        });
    } catch {
        throw new Error(nls.localize('vueport/input/gamePads/shareOffline', 'the server could not be reached.'));
    }
    if (response.status === 201 || response.status === 200) {
        return response.status === 201 ? 'received' : 'duplicate';
    }
    // the server explains in `error`; a proxy or host error page in front of it would not be JSON
    const reply = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(reply?.error ?? `HTTP ${response.status}`);
}

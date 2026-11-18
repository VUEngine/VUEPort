// two short cues for WebUi's toasts (achievement unlock, error), synthesized with OscillatorNodes rather than shipped
// as assets. Its own AudioContext, as this is UI chrome, independent of the emulator's audio graph

let audioContext: AudioContext | undefined;

function context(): AudioContext | undefined {
    try {
        audioContext ??= new AudioContext();
        if (audioContext.state === 'suspended') {
            // toasts fire well after the user has interacted with the page (loading a ROM at least), so no gesture is
            // needed; a browser that still refuses is left silent
            audioContext.resume().catch(() => undefined);
        }
        return audioContext;
    } catch {
        return undefined;
    }
}

// a short sine tone with a quick attack and an exponential decay
function tone(ctx: AudioContext, atSeconds: number, frequency: number, durationSeconds: number, peakGain: number): void {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    const start = ctx.currentTime + atSeconds;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peakGain, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + durationSeconds);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + durationSeconds + 0.02);
}

// a short rising arpeggio, the shape a "reward" cue takes everywhere
export function playAchievementCue(): void {
    const ctx = context();
    if (!ctx) {
        return;
    }
    tone(ctx, 0, 523.25, 0.12, 0.2); // C5
    tone(ctx, 0.1, 659.25, 0.12, 0.2); // E5
    tone(ctx, 0.2, 783.99, 0.22, 0.22); // G5
}

// two short low notes, falling: "something's wrong" without alarm
export function playErrorCue(): void {
    const ctx = context();
    if (!ctx) {
        return;
    }
    tone(ctx, 0, 220, 0.12, 0.18); // A3
    tone(ctx, 0.13, 174.61, 0.18, 0.18); // F3
}

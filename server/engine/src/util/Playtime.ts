// Legacy saves and hiscores store ticks without a duration. Freeze their
// conversion at the pre-migration rate, never the current NODE_TICKRATE.
export const LEGACY_PLAYTIME_TICK_MS = 300;

export function legacyPlaytimeMs(ticks: number): number {
    return ticks * LEGACY_PLAYTIME_TICK_MS;
}

export function savedPlaytimeMs(value: bigint): number {
    const ms = Number(value);
    if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('Invalid saved playtime duration');
    return ms;
}

export function formatPlaytime(ms: number): string {
    return formatTime(ms, `${(ms / 1000).toLocaleString()} seconds of game time`);
}

// Highscores compare work in ticks; display every record at the same current pace.
// Do not rescale accumulated durations: they can contain multiple tick rates.
export function formatNormalizedPlaytime(ticks: number, tickMs: number): string {
    return formatTime(ticks * tickMs, `${ticks.toLocaleString()} ticks normalized to ${tickMs} ms per tick`);
}

function formatTime(ms: number, title: string): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    const time = hours > 0 ? `${hours}h ${pad(minutes)}m ${pad(seconds)}s` : minutes > 0 ? `${minutes}m ${pad(seconds)}s` : `${seconds}s`;
    return `<span title="${title}" style="font-variant-numeric: tabular-nums">${time}</span>`;
}

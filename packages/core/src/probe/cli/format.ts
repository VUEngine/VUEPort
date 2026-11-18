export function hexDump(address: number, bytes: Uint8Array): string[] {
    const out: string[] = [];
    for (let at = 0; at < bytes.length; at += 16) {
        const row = bytes.subarray(at, at + 16);
        const digits = [...row].map(byte => byte.toString(16).padStart(2, '0')).join(' ');
        const text = [...row].map(byte => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.')).join('');
        out.push(`  ${hex32(address + at)}  ${digits.padEnd(47)}  ${text}`);
    }
    return out;
}

export function hex32(value: number): string {
    return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}

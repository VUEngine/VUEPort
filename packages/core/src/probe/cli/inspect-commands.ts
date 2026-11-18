import {
    readBgMap, readCharacter, readInstances, readObjects, readPool, readVbcState, readVip, VbObject, VbVbcState, VbWorld,
} from '../vb-inspect';
import { VsuEnvelopeDirection } from '../../browser/panels/emulator-vsu-memory';
import { VbMachine } from '../vb-machine';

// the commands that show hardware state as text: vip, vsu, vbc, pool and actors. Each returns the data for
// --json and pushes lines for reading, in the terms of the app's debug panels

export function vipCommand(vb: VbMachine, args: string[], all: boolean, lines: string[]): unknown {
    const [what = 'overview', ...rest] = args;
    switch (what) {
        case 'overview': {
            const vip = readVip(vb);
            const r = vip.registers;
            // the status registers, not the control ones: DPCTRL and XPCTRL are what a game writes, DPSTTS and XPSTTS
            // what the VIP is doing
            lines.push(`display ${r.DPSTTS & 0x2 ? 'on' : 'off'}  drawing ${r.XPSTTS & 0x2 ? 'on' : 'off'}  FRMCYC ${r.FRMCYC & 0xf}`
                + `  brightness ${vip.brightness.slice(1).join('/')}  backdrop ${r.BKCOL & 3}`);
            lines.push(`GPLT ${vip.palettes.bgmap.map(shades => shades.join(',')).join('  ')}`);
            lines.push(`JPLT ${vip.palettes.object.map(shades => shades.join(',')).join('  ')}`);
            lines.push(`object groups ${vip.objectGroups.map((range, group) => `${group}:${range ? `${range.first}-${range.last}` : '-'}`).join(' ')}`);
            if (vip.vbc) {
                lines.push(vbcLine(vip.vbc));
            }
            lines.push(`worlds drawn (${vip.worlds.length}), 31 first:`);
            lines.push(...vip.worlds.map(worldLine));
            return vip;
        }
        case 'registers': {
            const registers = readVip(vb).registers;
            const entries = Object.entries(registers);
            for (let i = 0; i < entries.length; i += 6) {
                lines.push(entries.slice(i, i + 6).map(([name, value]) => `${name.padEnd(6)} ${hex(value, 2)}`).join('  '));
            }
            return registers;
        }
        case 'worlds': {
            const worlds = readVip(vb).worlds;
            lines.push(...worlds.map(worldLine));
            return worlds;
        }
        case 'objects': {
            const objects = readObjects(vb, { all });
            lines.push(`${objects.length} object${objects.length === 1 ? '' : 's'}${all ? '' : ' shown'}`);
            lines.push(...objects.map(objectLine));
            return objects;
        }
        case 'bgmap': {
            const segment = Number(rest[0]);
            const [x = 0, y = 0, width = 64, height = 64] = (rest[1] ?? '').split(',').filter(Boolean).map(Number);
            const cells = readBgMap(vb, segment, { x, y, width, height });
            lines.push(`BGMap ${segment}, cells ${x},${y} to ${x + width - 1},${y + height - 1}: char/palette, h v for flips`
                + `${cells[0]?.color ? ', then the VB Color palette' : ''}`);
            for (let row = y; row < y + height; row++) {
                const line = cells.filter(cell => cell.y === row);
                if (line.length > 0) {
                    lines.push(`  ${String(row).padStart(2)}: ${line.map(cell => `${hex(cell.char, 0).slice(2).padStart(3, '0')}/${cell.palette}`
                        + `${cell.hFlip ? 'h' : ''}${cell.vFlip ? 'v' : ''}${cell.color ? `:${cell.color.palette}` : ''}`).join(' ')}`);
                }
            }
            return cells;
        }
        case 'char': {
            const index = Number(rest[0]);
            const pixels = readCharacter(vb, index);
            lines.push(`character ${index} (${hex(index, 2)}), pixel values 0-3:`);
            lines.push(...pixels.map(row => `  ${row.join('')}`));
            return pixels;
        }
        default:
            throw new Error(`vip shows overview, registers, worlds, objects, bgmap <segment> [x,y,w,h] or char <index>; not "${what}".`);
    }
}

export function vsuCommand(vb: VbMachine, lines: string[]): unknown {
    const vsu = vb.vsu();
    for (const channel of vsu.channels) {
        const parts = [`${channel.name.padEnd(9)} ${channel.enabled ? 'on ' : 'off'}`];
        parts.push(`${channel.frequencyHz.toFixed(1).padStart(8)} Hz`);
        parts.push(`L ${String(channel.left).padStart(2)} R ${String(channel.right).padStart(2)}`);
        const envelope = channel.envelope;
        parts.push(`level ${String(envelope.initialValue).padStart(2)}`
            + `${envelope.enabled ? ` ${envelope.direction === VsuEnvelopeDirection.GROW ? 'rising' : 'falling'} every ${envelope.stepMs} ms` : ''}`);
        if (channel.waveform !== undefined) {
            parts.push(`wave ${channel.waveform}`);
        }
        lines.push(parts.join('  '));
    }
    return vsu;
}

export function vbcCommand(vb: VbMachine, cram: boolean, lines: string[]): unknown {
    const vbc = readVbcState(vb);
    if (!vbc) {
        lines.push(vb.vbc ? 'VB Color hardware, but the game has not switched VB Color mode on.' : 'Not a VB Color machine (--hardware vbc makes one).');
        return undefined;
    }
    lines.push(vbcLine(vbc));
    const palettes = vbc.cram.map((colors, palette) => ({ palette, colors }))
        .filter(entry => cram || entry.colors.some(color => color !== '#000000'));
    lines.push(`${cram ? 'CRAM' : 'CRAM palettes that are not all black'}:`);
    lines.push(...palettes.map(entry => `  ${String(entry.palette).padStart(3)}: ${entry.colors.join(' ')}`));
    return vbc;
}

export function poolCommand(vb: VbMachine, lines: string[]): unknown {
    requireEngineSymbols(vb);
    const pool = readPool(vb);
    if (!pool) {
        lines.push('The memory pools are not set up yet.');
        return undefined;
    }
    lines.push(`memory pools at ${vb.describe(pool.address)}`);
    for (const entry of pool.pools) {
        const top = entry.classes.slice(0, 4).map(occupant => `${occupant.name}×${occupant.count}`).join(', ');
        lines.push(`  ${String(entry.blockSize).padStart(4)} B  ${String(entry.usedBlocks).padStart(4)}/${String(entry.blocks).padEnd(4)}`
            + `${entry.overflows ? `  overflowed ${entry.overflows}` : ''}${top ? `  ${top}` : ''}`
            + `${entry.unidentified ? `  ${entry.unidentified} unidentified` : ''}`);
    }
    return pool;
}

export function actorsCommand(vb: VbMachine, args: string[], fields: boolean, lines: string[]): unknown {
    requireEngineSymbols(vb);
    const classes = vb.symbols!.index.classes;
    const className = args[0] ?? (classes.has('Actor') ? 'Actor' : classes.has('Entity') ? 'Entity' : undefined);
    const instances = readInstances(vb, { className, fields });
    lines.push(`${instances.length} ${className ?? 'object'}${instances.length === 1 ? '' : 's'} in the memory pools`);
    for (const instance of instances) {
        const position = ['x', 'y', 'z'].map(axis => instance.fields?.find(field => field.path === `transformation.position.${axis}`)?.value);
        lines.push(`  ${hex(instance.address, 4)}  ${instance.className}${instance.name ? ` "${instance.name}"` : ''}`
            + `${position.every(value => value !== undefined) ? `  at ${position.join(',')}` : ''}  is a ${instance.ancestry.slice(1).join(', ')}`);
        for (const field of fields ? instance.fields ?? [] : []) {
            lines.push(`      ${field.path} = ${field.value}`);
        }
    }
    return instances;
}

function requireEngineSymbols(vb: VbMachine): void {
    if (!vb.symbols) {
        throw new Error('This needs the build\'s .elf (--elf), to find the engine\'s memory pools and name the classes.');
    }
    if (!vb.symbols.index.memoryPool) {
        throw new Error('The build has no MemoryPool, so it is not a VUEngine game this can read.');
    }
}

function worldLine(world: VbWorld): string {
    const eyes = `${world.lon ? 'L' : '-'}${world.ron ? 'R' : '-'}`;
    const offset = world.paletteOffset ? `  vbc +${world.paletteOffset}` : '';
    if (world.modeName === 'Object') {
        return `  ${String(world.index).padStart(2)} Object  ${eyes}  group ${world.objectGroup ?? '-'}${offset}`;
    }
    const map = `map ${world.bgMap} ${world.scx}x${world.scy}${world.overplane ? ` over ${hex(world.overplaneIndex, 2)}` : ''}`;
    const param = world.modeName === 'BGMap' ? '' : `  param ${hex(world.param, 2)}`;
    return `  ${String(world.index).padStart(2)} ${world.modeName.padEnd(6)}  ${eyes}  ${map}  screen ${world.gx},${world.gy} p${world.gp}`
        + `  source ${world.mx},${world.my} p${world.mp}  size ${world.w + 1}x${world.h + 1}${param}${offset}`;
}

function objectLine(object: VbObject): string {
    const eyes = `${object.left ? 'L' : '-'}${object.right ? 'R' : '-'}`;
    const flips = `${object.hFlip ? 'h' : '-'}${object.vFlip ? 'v' : '-'}`;
    return `  #${String(object.index).padStart(4)}  g${object.group ?? '-'}  x ${String(object.x).padStart(4)} y ${String(object.y).padStart(3)}`
        + ` p ${String(object.parallax).padStart(3)}  char ${String(object.char).padStart(4)} pal ${object.palette}  ${flips} ${eyes}`
        + `${object.color ? `  vbc pal ${object.color.palette}${object.color.slot ? ' slot' : ''}` : ''}`;
}

function vbcLine(vbc: VbVbcState): string {
    const flags = (['colen', 'chrext', 'pcen', 'wcen', 'ccen', 'bkren', 'wramext'] as const)
        .map(name => `${name.toUpperCase()} ${vbc[name] ? 'on' : 'off'}`).join('  ');
    return `VB Color: ${flags}  CBKPAL ${vbc.cbkpal}`;
}

function hex(value: number, bytes: number): string {
    return `0x${(value >>> 0).toString(16).padStart(bytes * 2, '0')}`;
}

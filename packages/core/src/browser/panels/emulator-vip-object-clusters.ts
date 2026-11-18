import {
    isVipObjectVisible,
    VIP_CHAR_SIZE,
    VipCharacters,
    VipEye,
    VipObject,
    vipObjectExtents,
    vipObjectGroupOf,
} from './emulator-vip-memory';

// a guessed figure made of objects, and the screen rectangle it covers for one eye
export interface VipObjectCluster {
    // lowest first
    objects: number[];
    x: number;
    y: number;
    width: number;
    height: number;
}

// how many OAM slots may lie between two objects of one figure, as a cell with nothing to draw may still take a
// switched-off slot in the run
const MAX_INDEX_GAP = 4;

// how far apart in depth two objects of one figure may be. Games give figures relief this way (Jack Bros draws
// bodies at JP 4 and their details at 5), while separate figures are usually further apart
const MAX_PARALLAX_GAP = 2;

// pixels per axis two objects may disagree on their motion and still move alike, as a figure's cells shift a
// little between animation frames (Wario Land's by three or four pixels)
const MAX_MOTION_GAP = 4;

// how much motion has to be known, and fall into groups that moved alike, before a figure is split; anything less
// is more likely slots being handed out afresh
const MIN_KNOWN_MOTION = 0.75;
const MIN_GROUPED_MOTION = 0.9;

// further than this, the slot most likely holds a different object, as games hand OAM out afresh every frame; its
// motion is then unknown rather than wrong
const MAX_MOTION = 32;

/**
 * Groups the drawn objects into the figures they most likely make up. OAM is a flat list of 8x8 cells, so this guesses
 * from what a figure's objects nearly always share: their cells touch or overlap, corners included; they sit at about
 * one depth and are drawn to the same eyes (Wario Land draws its hero as one set per eye); and they are one run of OAM
 * in one group, so a gap of more than a few slots or an SPT boundary ends a figure.
 *
 * With `previous`, the objects at the last look, a figure whose objects clearly moved in different ways is split (see
 * splitByMotion). Linking is transitive. Objects the VIP does not draw (off for both eyes, past the last group) and
 * objects with a blank character are left out, as games park unused objects that way next to figures.
 */
export function vipObjectClusters(
    objects: readonly VipObject[],
    registers: DataView,
    characters: VipCharacters,
    eye: VipEye,
    previous?: readonly VipObject[]
): VipObjectCluster[] {
    const blank = new Map<number, boolean>();
    const isBlank = (char: number): boolean => {
        let answer = blank.get(char);
        if (answer === undefined) {
            answer = true;
            for (let pixel = 0; pixel < VIP_CHAR_SIZE * VIP_CHAR_SIZE && answer; pixel++) {
                answer = characters.pixel(char, pixel % VIP_CHAR_SIZE, pixel / VIP_CHAR_SIZE | 0) === 0;
            }
            blank.set(char, answer);
        }
        return answer;
    };
    // an object past the last group is never drawn, whatever its eye bits say, and usually stale
    const drawn = objects.filter(object =>
        isVipObjectVisible(object)
        && vipObjectGroupOf(registers, object.index) !== undefined
        && !isBlank(object.char));

    // runs of OAM: consecutive drawn objects, in one group, with no more than a few slots between them
    const run = new Map<number, number>();
    let current = -1;
    drawn.forEach((object, position) => {
        const before = drawn[position - 1];
        if (!before
            || object.index - before.index > MAX_INDEX_GAP
            || vipObjectGroupOf(registers, object.index) !== vipObjectGroupOf(registers, before.index)) {
            current++;
        }
        run.set(object.index, current);
    });

    // union-find over the drawn objects, by position in drawn
    const parent = drawn.map((unused, position) => position);
    const find = (position: number): number => {
        while (parent[position] !== position) {
            parent[position] = parent[parent[position]];
            position = parent[position];
        }
        return position;
    };

    // only objects of one run can be linked, so each object is compared with the ones after it in its run
    for (let a = 0; a < drawn.length; a++) {
        for (let b = a + 1; b < drawn.length && run.get(drawn[b].index) === run.get(drawn[a].index); b++) {
            if (objectsLinked(drawn[a], drawn[b])) {
                parent[find(b)] = find(a);
            }
        }
    }

    const members = new Map<number, VipObject[]>();
    drawn.forEach((object, position) => {
        const root = find(position);
        const list = members.get(root);
        if (list) {
            list.push(object);
        } else {
            members.set(root, [object]);
        }
    });

    return [...members.values()].flatMap(list => splitByMotion(list, previous)).map(list => {
        // with JY read as objectRow reads it, so a figure straddling the top edge is outlined where it is
        const extents = list.map(object => ({ ...vipObjectExtents(object, eye), y: objectRow(object) }));
        const left = Math.min(...extents.map(extent => extent.x));
        const top = Math.min(...extents.map(extent => extent.y));
        const right = Math.max(...extents.map(extent => extent.x + extent.width));
        const bottom = Math.max(...extents.map(extent => extent.y + extent.height));
        return {
            objects: list.map(object => object.index),
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        };
    });
}

export function vipObjectClusterOf(
    clusters: readonly VipObjectCluster[], index: number
): VipObjectCluster | undefined {
    return clusters.find(cluster => cluster.objects.includes(index));
}

// JY is eight bits and wraps: an object a few rows above the screen is a value near 255, which read plainly would
// be two hundred rows away from the rest of its figure
function objectRow(object: VipObject): number {
    return object.jy > 0xff - VIP_CHAR_SIZE ? object.jy - 0x100 : object.jy;
}

function objectsLinked(a: VipObject, b: VipObject): boolean {
    return a.lon === b.lon
        && a.ron === b.ron
        && Math.abs(a.jp - b.jp) <= MAX_PARALLAX_GAP
        && Math.abs(a.jx - b.jx) <= VIP_CHAR_SIZE
        && Math.abs(objectRow(a) - objectRow(b)) <= VIP_CHAR_SIZE;
}

// undefined when it cannot be told: nothing to compare with, a slot not drawn to the same eyes then, or a jump too
// far to be the same object moving
function motionOf(
    object: VipObject, previous: readonly VipObject[] | undefined
): { x: number, y: number } | undefined {
    const before = previous?.[object.index];
    if (!before || before.lon !== object.lon || before.ron !== object.ron) {
        return undefined;
    }
    const x = object.jx - before.jx;
    const y = objectRow(object) - objectRow(before);
    return Math.abs(x) <= MAX_MOTION && Math.abs(y) <= MAX_MOTION ? { x, y } : undefined;
}

/**
 * The objects' motions are sorted into groups that moved alike. The figure is split only if most of its motion is
 * known, nearly all of it in groups of two or more, and at least two groups moved further apart than animation would
 * shift a figure's cells. Each object then goes with its group, an unknown one with a known neighbour, and groups whose
 * objects do not touch fall apart further. Cautious, as it compares slots rather than objects and Wario Land rearranges
 * its hero's slots every animation frame.
 */
function splitByMotion(list: VipObject[], previous: readonly VipObject[] | undefined): VipObject[][] {
    if (!previous || list.length < 4) {
        return [list];
    }
    const motions = new Map<number, { x: number, y: number }>();
    list.forEach(object => {
        const motion = motionOf(object, previous);
        if (motion) {
            motions.set(object.index, motion);
        }
    });
    if (motions.size < 4 || motions.size < list.length * MIN_KNOWN_MOTION) {
        return [list];
    }

    // grouped around the first motion of each group, fine for groups as far apart as those acted on have to be
    const groups: { x: number, y: number, objects: number[] }[] = [];
    motions.forEach((motion, index) => {
        const group = groups.find(candidate =>
            Math.abs(candidate.x - motion.x) <= MAX_MOTION_GAP && Math.abs(candidate.y - motion.y) <= MAX_MOTION_GAP);
        if (group) {
            group.objects.push(index);
        } else {
            groups.push({ ...motion, objects: [index] });
        }
    });
    const solid = groups.filter(group => group.objects.length > 1);
    const grouped = solid.reduce((sum, group) => sum + group.objects.length, 0);
    const apart = solid.some(a => solid.some(b =>
        Math.abs(a.x - b.x) > 2 * MAX_MOTION_GAP || Math.abs(a.y - b.y) > 2 * MAX_MOTION_GAP));
    if (solid.length < 2 || grouped < motions.size * MIN_GROUPED_MOTION || !apart) {
        return [list];
    }

    // label each object with its group, then hand the unlabelled ones (unknown, or in a group of one) a labelled
    // neighbour's label until nothing is left
    const label = new Map<number, number>();
    solid.forEach((group, id) => group.objects.forEach(index => label.set(index, id)));
    for (let changed = true; changed;) {
        changed = false;
        for (const object of list) {
            if (label.has(object.index)) {
                continue;
            }
            const neighbour = list.find(other => label.has(other.index) && objectsLinked(object, other));
            if (neighbour) {
                label.set(object.index, label.get(neighbour.index)!);
                changed = true;
            }
        }
    }

    const parts: VipObject[][] = [];
    const placed = new Set<number>();
    for (const seed of list) {
        if (placed.has(seed.index)) {
            continue;
        }
        const part = [seed];
        placed.add(seed.index);
        for (let at = 0; at < part.length; at++) {
            for (const other of list) {
                if (!placed.has(other.index)
                    && label.get(other.index) === label.get(part[at].index)
                    && objectsLinked(part[at], other)) {
                    placed.add(other.index);
                    part.push(other);
                }
            }
        }
        parts.push(part.sort((a, b) => a.index - b.index));
    }
    return parts;
}

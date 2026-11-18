// the VB Color mark, traced art that keeps the tracer's flipped, tenth-scale transform, padded to a square box to
// align with the other icons. In core because both hosts draw the title bar
import * as React from 'react';

const GLYPH_X = -32; // the glyph's own square, padded out from the traced path's 427 × 491
const GLYPH_SIZE = 491;

export function VbColorIcon(props: {
    size?: number,
    // square the icon takes up, with the glyph centered at `size`, so labels in a column of larger icons (the
    // settings rail) still line up
    box?: number,
}): React.JSX.Element {
    const size = props.size ?? 18;
    const box = Math.max(size, props.box ?? size);
    const extent = GLYPH_SIZE * box / size;
    const pad = (extent - GLYPH_SIZE) / 2;
    return <svg
        width={box}
        height={box}
        viewBox={`${GLYPH_X - pad} ${-pad} ${extent} ${extent}`}
        fill='currentColor'
        aria-hidden='true'
    >
        <g transform='translate(0,491) scale(0.1,-0.1)'>
            <path d='M3000 4883 c-261 -39 -401 -79 -645 -180 -185 -78 -335 -159 -530
-289 -251 -167 -451 -327 -649 -522 -620 -611 -992 -1243 -1127 -1917 -31
-155 -39 -510 -15 -675 79 -541 467 -992 1012 -1175 255 -86 451 -109 854
-102 225 3 297 8 395 26 290 53 574 158 831 306 138 79 222 144 308 236 160
172 217 373 166 586 -44 188 -159 316 -342 381 -64 22 -89 25 -208 26 -162 0
-186 -5 -470 -114 -250 -95 -328 -118 -456 -130 -203 -19 -357 28 -458 140
-79 87 -123 235 -111 370 44 490 469 1103 994 1433 121 77 219 116 288 117 82
0 96 -11 137 -110 68 -163 193 -263 365 -291 143 -24 326 18 480 108 124 73
268 228 334 360 76 150 102 266 101 453 -1 145 -18 242 -68 374 -53 140 -195
318 -321 403 -205 138 -408 194 -693 192 -81 -1 -158 -3 -172 -6z' />
        </g>
    </svg>;
}

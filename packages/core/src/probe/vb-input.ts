import { VbKey } from '../common/vb-constants';
import { parseKeys } from './vb-keys';

export interface InputSpan {
    from: number;
    to: number; // inclusive
    keys: number;
}

// what the machine is told is held, frame by frame. Spans win over a movie where they cover a frame; a frame
// neither covers is left to the machine's own `keys`. Frames are VbMachine.frame, which are the app's too, so a
// movie recorded in VUEPort replays here frame for frame
export class VbInput {

    protected readonly spans: InputSpan[] = [];
    protected movie: number[] = [];
    protected movieStart = 0;

    constructor(spans: InputSpan[] = []) {
        spans.forEach(span => this.add(span));
    }

    // `120-180:A+RIGHT`, `120:A` (that frame alone) or `120+30:A` (thirty frames from 120)
    static parseSpan(spec: string): InputSpan {
        const match = /^\s*(\d+)\s*(?:([-+])\s*(\d+))?\s*:(.*)$/.exec(spec);
        if (!match) {
            throw new Error(`Cannot read "${spec}" as frames and buttons, e.g. 120-180:A+RIGHT.`);
        }
        const from = Number(match[1]);
        const to = match[2] === '-'
            ? Number(match[3])
            : match[2] === '+' ? from + Math.max(1, Number(match[3])) - 1 : from;
        if (to < from) {
            throw new Error(`"${spec}" ends before it starts.`);
        }
        return { from, to, keys: parseKeys(match[4]) };
    }

    add(span: InputSpan): this {
        this.spans.push({ ...span, keys: span.keys | VbKey.SGN });
        return this;
    }

    // frames are VbKey masks as parseVesMovie reads them; the signature bit is added here as the app's player does
    setMovie(frames: number[], start = 0): this {
        this.movie = frames.map(keys => keys | VbKey.SGN);
        this.movieStart = start;
        return this;
    }

    // undefined for a frame nothing here covers
    keysAt(frame: number): number | undefined {
        let keys: number | undefined;
        for (const span of this.spans) {
            if (frame >= span.from && frame <= span.to) {
                keys = (keys ?? 0) | span.keys;
            }
        }
        if (keys !== undefined) {
            return keys;
        }
        const index = frame - this.movieStart;
        return index >= 0 && index < this.movie.length ? this.movie[index] : undefined;
    }

    // -1 for an empty script
    get end(): number {
        const spanEnd = this.spans.reduce((last, span) => Math.max(last, span.to), -1);
        const movieEnd = this.movie.length > 0 ? this.movieStart + this.movie.length - 1 : -1;
        return Math.max(spanEnd, movieEnd);
    }
}

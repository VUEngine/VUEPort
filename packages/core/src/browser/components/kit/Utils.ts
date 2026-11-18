// copied from VES's editors/.../Common/Utils, so that nothing here reaches into the editors. Own isNumber and
// debounce rather than lodash's, whose CommonJS barrel cannot be tree-shaken and costs a hundred kilobytes

// number primitives and boxed numbers, NaN included
export const isNumber = (value: unknown): value is number =>
    typeof value === 'number' || value instanceof Number;

export const clamp = (value: number, min: number, max: number, deflt: number = 0): number =>
    isNumber(value)
        ? Math.min(Math.max(value, min), max)
        : deflt;

// trailing edge only, with the last call's arguments and this
export interface Debounced<A extends unknown[]> {
    (...args: A): void
    cancel(): void // drops a pending call, so an unmounting component can stop it landing on a dead state
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, wait: number): Debounced<A> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const debounced = function (this: unknown, ...args: A): void {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            timer = undefined;
            fn.apply(this, args);
        }, wait);
    } as Debounced<A>;
    debounced.cancel = () => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };
    return debounced;
}

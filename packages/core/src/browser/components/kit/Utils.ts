/**
 * The handful of helpers the copied controls need.
 *
 * Copied from VES's `editors/.../Common/Utils` for the same reason the
 * controls themselves are: so that nothing here reaches into the editors.
 */
import { isNumber } from 'lodash';

export const clamp = (value: number, min: number, max: number, deflt: number = 0): number =>
    isNumber(value)
        ? Math.min(Math.max(value, min), max)
        : deflt;

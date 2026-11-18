import { ArrowFatDown, ArrowFatUp } from '@phosphor-icons/react';
import * as React from 'react';

export type TableSortValue = string | number | boolean | null | undefined;
export type TableSortDirection = 'ascending' | 'descending';

export interface TableSort<K extends string> {
    column?: K;
    direction?: TableSortDirection;
}

export function nextTableSort<K extends string>(sort: TableSort<K>, column: K): TableSort<K> {
    return sort.column === column
        ? { column, direction: sort.direction === 'ascending' ? 'descending' : 'ascending' }
        : { column, direction: 'ascending' };
}

// stable, with absent values kept at the end in either direction
export function sortTableRows<T, K extends string>(
    rows: readonly T[], sort: TableSort<K>, valueOf: (row: T, column: K) => TableSortValue
): T[] {
    if (!sort.column || !sort.direction) {
        return [...rows];
    }
    const column = sort.column;
    const direction = sort.direction === 'ascending' ? 1 : -1;
    return rows.map((row, index) => ({ row, index })).sort((a, b) => {
        const left = valueOf(a.row, column);
        const right = valueOf(b.row, column);
        const leftMissing = left === undefined || left === null;
        const rightMissing = right === undefined || right === null;
        if (leftMissing || rightMissing) {
            return leftMissing === rightMissing ? a.index - b.index : leftMissing ? 1 : -1;
        }
        const compared = typeof left === 'string' && typeof right === 'string'
            ? left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
            : Number(left) - Number(right);
        return compared === 0 ? a.index - b.index : compared * direction;
    }).map(entry => entry.row);
}

interface SortableHeaderProps<K extends string>
    extends Omit<React.ThHTMLAttributes<HTMLTableCellElement>, 'onClick'> {
    column: K;
    sort: TableSort<K>;
    onSort: (column: K) => void;
}

export function SortableHeader<K extends string>({
    column, sort, onSort, children, ...attributes
}: SortableHeaderProps<K>): React.ReactElement {
    const active = sort.column === column;
    return <th {...attributes} aria-sort={active ? sort.direction : 'none'}>
        <button type='button' className='vp-sortable-header' onClick={() => onSort(column)}>
            <span>{children}</span>
            <span className='vp-sortable-indicator' aria-hidden='true'>
                {active
                    ? sort.direction === 'ascending'
                        ? <ArrowFatDown size={12} weight='fill' />
                        : <ArrowFatUp size={12} weight='fill' />
                    : <></>
                }
            </span>
        </button>
    </th>;
}

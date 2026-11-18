import * as React from 'react';

// a download in the browser, a file in the project in VES; a host that cannot take one leaves it out and panels show
// no Export button (see VueportDockHost.exportFile)
export type VipExportFile = (name: string, data: Uint8Array) => Promise<void>;

// one file pixel per source pixel, shared by every VIP inspector with an Export PNG button
export async function exportVipImage(exportFile: VipExportFile, name: string, image: ImageData): Promise<void> {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d')?.putImageData(image, 0, 0);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (blob) {
        await exportFile(name, new Uint8Array(await blob.arrayBuffer()));
    }
}

/**
 * Draws ImageData at an integer zoom. The canvas stays at source resolution and is scaled by CSS, so pixels stay crisp
 * and a redraw does not repaint the scaled area. Overlays are separate absolutely positioned elements, so none is
 * scaled with the bitmap: with `cellSize`, grid lines (`showGrid`) and a border around the `selected` cell; `extents`,
 * a border around a rectangle in source pixels; `around`, a fainter one for what that is part of.
 */
export function VipCanvas(props: {
    image: ImageData,
    zoom: number,
    onPick?: (x: number, y: number) => void,
    onHover?: (point: { x: number, y: number } | undefined) => void,
    title?: string,
    cellSize?: number,
    showGrid?: boolean,
    selected?: { x: number, y: number }, // in cell units
    extents?: { x: number, y: number, width: number, height: number }, // in source pixels, e.g. where a world lands
    around?: { x: number, y: number, width: number, height: number }, // fainter, e.g. the figure an object is part of
}): React.JSX.Element {
    const { image, zoom, onPick, onHover, title, cellSize, showGrid, selected, extents, around } = props;
    const ref = React.useRef<HTMLCanvasElement>(null);

    React.useEffect(() => {
        const canvas = ref.current;
        const context = canvas?.getContext('2d');
        if (canvas && context) {
            canvas.width = image.width;
            canvas.height = image.height;
            context.putImageData(image, 0, 0);
        }
    }, [image]);

    const width = image.width * zoom;
    const height = image.height * zoom;
    const cellPx = cellSize ? cellSize * zoom : 0;

    return <div className='vp-canvas-wrapper' style={{ width, height }}>
        <canvas
            className='vp-canvas'
            ref={ref}
            title={title}
            style={{ width, height }}
            onMouseMove={onHover && (event => {
                const bounds = event.currentTarget.getBoundingClientRect();
                onHover({
                    x: Math.floor((event.clientX - bounds.left) / zoom),
                    y: Math.floor((event.clientY - bounds.top) / zoom),
                });
            })}
            onMouseLeave={onHover && (() => onHover(undefined))}
            onClick={event => {
                if (!onPick) {
                    return;
                }
                const bounds = event.currentTarget.getBoundingClientRect();
                onPick(
                    Math.floor((event.clientX - bounds.left) / zoom),
                    Math.floor((event.clientY - bounds.top) / zoom)
                );
            }}
        />
        {showGrid && cellPx > 0 &&
            <div
                className='vp-canvas-grid'
                style={{ backgroundSize: `${cellPx}px ${cellPx}px` }}
            />
        }
        {selected && cellPx > 0 &&
            <div
                className='vp-canvas-selection'
                style={{ width: cellPx, height: cellPx, left: selected.x * cellPx, top: selected.y * cellPx }}
            />
        }
        {(extents || around) &&
            // clipped by a layer of its own, as a world can sit partly or wholly off screen
            <div className='vp-canvas-clip'>
                {around && <div
                    className='vp-canvas-extents vp-canvas-around'
                    style={{
                        width: around.width * zoom,
                        height: around.height * zoom,
                        left: around.x * zoom,
                        top: around.y * zoom,
                    }}
                />}
                {extents && <div
                    className='vp-canvas-extents'
                    style={{
                        width: extents.width * zoom,
                        height: extents.height * zoom,
                        left: extents.x * zoom,
                        top: extents.y * zoom,
                    }}
                />}
            </div>
        }
    </div>;
}

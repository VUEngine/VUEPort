import * as React from 'react';
import qrcode from 'qrcode-generator';

// the quiet zone around the code, in modules; the standard asks for four, phone cameras read two well and it keeps the
// code large in a small window
const MARGIN = 2;

// drawn as one SVG path of its dark modules, so it stays sharp at any size and needs no canvas. Always dark on
// white, as cameras read light-on-dark codes badly. Medium error correction copes with a slightly glary screen and
// keeps an address in a small, coarse code a phone can read from across a desk
export function QrCode(props: { value: string, size?: number, label: string }): React.JSX.Element {
    const { value, size = 176, label } = props;
    const { count, path } = React.useMemo(() => {
        const code = qrcode(0, 'M');
        code.addData(value, 'Byte');
        code.make();
        const modules = code.getModuleCount();
        let d = '';
        for (let row = 0; row < modules; row++) {
            for (let col = 0; col < modules; col++) {
                if (code.isDark(row, col)) {
                    d += `M${col + MARGIN} ${row + MARGIN}h1v1h-1z`;
                }
            }
        }
        return { count: modules + MARGIN * 2, path: d };
    }, [value]);
    return <svg
        className='vp-qr'
        role='img'
        aria-label={label}
        width={size}
        height={size}
        viewBox={`0 0 ${count} ${count}`}
        shapeRendering='crispEdges'
    >
        <rect width={count} height={count} fill='#fff' />
        <path d={path} fill='#000' />
    </svg>;
}

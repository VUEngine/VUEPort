import * as React from 'react';

// a table, as Planet VB's ramp is piecewise (flat red for the first fifth, then two gradients) and the exact colours
// can be checked against theirs
const SCORE_COLORS = [
    '#FF0000', '#FF0000', '#FF0000', '#FF0000', '#FF0000', '#FF0000', '#FF0000', '#FF0000',
    '#FF0000', '#FF0000', '#FF0000', '#FF0000', '#FF0000', '#FF0000', '#FF0000', '#FF0000',
    '#FF0000', '#FF0000', '#FF0000', '#FF0000', '#FE0501', '#FD0A01', '#FC0F02', '#FB1402',
    '#FA1903', '#F91E03', '#F82304', '#F72804', '#F62D05', '#F53305', '#F33806', '#F23D06',
    '#F14207', '#F04707', '#EF4C08', '#EE5108', '#ED5609', '#EC5B09', '#EB600A', '#EA650B',
    '#E96A0B', '#E86F0C', '#E7740C', '#E6790D', '#E57E0D', '#E4830E', '#E3880E', '#E28D0F',
    '#E1920F', '#E09810', '#DE9D10', '#DDA211', '#DCA711', '#DBAC12', '#DAB112', '#D9B613',
    '#D8BB13', '#D7C014', '#D6C514', '#D5CA15', '#D1C815', '#CEC515', '#CAC316', '#C7C016',
    '#C3BE16', '#C0BB16', '#BCB916', '#B9B617', '#B5B417', '#B2B117', '#AEAF17', '#AAAC17',
    '#A7AA18', '#A3A718', '#A0A518', '#9CA218', '#99A018', '#959D19', '#929B19', '#8E9819',
    '#8A9619', '#879319', '#83911A', '#808E1A', '#7C8C1A', '#79891A', '#75871A', '#72841B',
    '#6E821B', '#6B7F1B', '#677D1B', '#637A1B', '#60781C', '#5C751C', '#59731C', '#55701C',
    '#526E1C', '#4E6B1D', '#4B691D', '#47661D',
];

// undefined also outside 1-100, so an unexpected answer draws no badge rather than a wrong one
export const getScoreColor = (score?: number): string | undefined => {
    if (score && score >= 0 && score <= 100) {
        return SCORE_COLORS[score - 1];
    }
    return undefined;
};

// nothing at all without a score, rather than a column of grey dashes
export function ScoreBadge(props: { score?: number, className?: string }): React.JSX.Element | undefined {
    const color = getScoreColor(props.score);
    if (color === undefined) {
        return undefined;
    }
    return <span
        className={`vp-score${props.className ? ` ${props.className}` : ''}`}
        style={{ background: color }}
    >{Math.round(props.score!)}</span>;
}

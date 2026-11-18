import { ArrowSquareOut, Info } from '@phosphor-icons/react';
import * as React from 'react';
import { ROM_HEADER_MAKERS } from 'vueport-core/lib/browser/emulator-types';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { WebEmulator } from './web-emulator';
import { vbColorSupportLabel } from 'vueport-core/lib/browser/emulator-types';
import { PLANET_VB_URL } from './web-homebrew';
import { useEmptyBoxUrl } from './web-empty-box';
import { PlanetVbGame, PlanetVbUnavailableError, cachedRom, lookupRom } from './web-planet-vb';
import { Window } from 'vueport-core/lib/browser/components/kit/Window';

// unknown values pass through as-is
function kindLabel(kind: string): string {
    switch (kind) {
        case 'game':
            return nls.localize('vueport/romInfo/kindGame', 'Game');
        case 'homebrew':
            return nls.localize('vueport/romInfo/kindHomebrew', 'Homebrew');
        case 'tech-demo':
            return nls.localize('vueport/romInfo/kindTechDemo', 'Technical Demo');
        default:
            return kind;
    }
}

// opened from the ROM name in the title bar: the catalog's entry (falling back to the plain catalog link when
// unreachable) and what is in the cartridge (header, size, hash)
export default function WebRomInfo(props: {
    emulator: WebEmulator,
    onClose: () => void,
}): React.JSX.Element {
    const { emulator, onClose } = props;
    const hash = emulator.romChecksum;

    // so reopening shows the entry at once rather than flashing "Looking this game up…" every time; see cachedRom
    const known = cachedRom(hash);
    const [game, setGame] = React.useState<PlanetVbGame | undefined>(known?.game);
    const [state, setState] = React.useState<'loading' | 'found' | 'missing' | 'unavailable'>(
        known ? (known.game ? 'found' : 'missing') : 'loading');
    const [artFailed, setArtFailed] = React.useState(false);
    const [backgroundFailed, setBackgroundFailed] = React.useState(false);
    const emptyBox = useEmptyBoxUrl('front');

    React.useEffect(() => {
        const cached = cachedRom(hash);
        if (cached) {
            setGame(cached.game);
            setState(cached.game ? 'found' : 'missing');
            setArtFailed(false);
            setBackgroundFailed(false);
            return undefined;
        }
        let live = true;
        setState('loading');
        setArtFailed(false);
        setBackgroundFailed(false);
        lookupRom(hash)
            .then(result => {
                if (!live) {
                    return;
                }
                setGame(result);
                setState(result ? 'found' : 'missing');
            })
            .catch(error => {
                if (live) {
                    setState(error instanceof PlanetVbUnavailableError ? 'unavailable' : 'missing');
                }
            });
        return () => { live = false; };
    }, [hash]);

    const headerName = emulator.romHeader.name.trim();

    // for the matched dump, unlike the header below, which does not need the catalog
    const romInformation: [string, string][] = [
        [
            nls.localize('vueport/romInfo/file', 'File'),
            emulator.archiveName
                ? nls.localize('vueport/romInfo/inArchive', '{0} in {1}', emulator.romName ?? '', emulator.archiveName)
                : emulator.romName ?? '—',
        ],
        [nls.localize('vueport/status/title', 'Title'), game?.romTitle ?? '—'],
        [nls.localize('vueport/romInfo/md5', 'MD5'), game?.md5 ?? '—'],
        [nls.localize('vueport/status/checksum', 'CRC32'), game?.crc32 ?? '—'],
        [nls.localize('vueport/romInfo/version', 'Version'), game?.version ?? '—'],
        [
            nls.localize('vueport/romInfo/latest', 'Latest'),
            game
                ? (game.latest
                    ? nls.localize('vueport/romInfo/yes', 'Yes')
                    : nls.localize('vueport/romInfo/no', 'No'))
                : '—',
        ],
        [nls.localize('vueport/status/size', 'Size'), `${emulator.romSize} MBit`],
    ];

    const makerCode = emulator.romHeader.maker.trim();
    const makerName = ROM_HEADER_MAKERS[makerCode];
    const romHeaderInfo: [string, string][] = [
        [nls.localize('vueport/status/title', 'Title'), headerName || '—'],
        [nls.localize('vueport/status/maker', 'Maker'), makerCode ? `${makerCode}${makerName ? ` (${makerName})` : ''}` : '—'],
        [nls.localize('vueport/status/code', 'Code'), emulator.romHeader.code.trim() || '—'],
        [nls.localize('vueport/romInfo/version', 'Version'), `1.${emulator.romHeader.version}`],
        ...(emulator.vbcSupportEnabled
            ? [[
                'VB Color',
                `${emulator.romHeader.vbcSupport.toString(16).toUpperCase().padStart(2, '0')} `
                    + `(${vbColorSupportLabel(emulator.romHeader.vbcSupport)})`,
            ] as [string, string]]
            : []),
    ];

    // a dimmer second line names the other company only when it differs, as most entries have just one credit
    const primaryCredit = game?.developer || game?.publisher;
    const subtitle = [primaryCredit, game?.released].filter(Boolean).join(' · ');
    const publisherLine = game?.developer && game.publisher && game.publisher !== game.developer
        ? nls.localize('vueport/romInfo/publishedBy', 'Published by {0}', game.publisher)
        : undefined;

    // named() in web-planet-vb.ts joins a multi-value field into one string, so it is split back here into one pill
    // each
    const pills = game
        ? [
            ...game.genre.split(',').map(entry => entry.trim()),
            ...game.region.split('/').map(entry => entry.trim()),
            game.players,
            game.status,
            game.kind && kindLabel(game.kind),
        ].filter(Boolean)
        : [];

    return <Window
        title={nls.localize('vueport/romInfo/title', 'Game Information')}
        icon={<Info size={22} />}
        onClose={onClose}
        compact
    >
        <div className='vp-rom-info'>
            <div className='vp-rom-info-game'>
                {state === 'loading' &&
                    <p className='vp-rom-info-status'>
                        {nls.localize('vueport/romInfo/loading', 'Looking this game up on Planet VB…')}
                    </p>}

                {state === 'missing' &&
                    <p className='vp-rom-info-status'>
                        {nls.localize('vueport/romInfo/missing',
                            'Planet VB has no entry for this ROM.')}
                    </p>}

                {state === 'unavailable' &&
                    <p className='vp-rom-info-status'>
                        {nls.localize('vueport/romInfo/unavailable',
                            'Planet VB could not be reached.')}
                        {' '}
                        <a href={PLANET_VB_URL} target='_blank' rel='noreferrer'>
                            {nls.localize('vueport/romInfo/openPlanetVb', 'Open Planet VB')}
                        </a>
                    </p>}

                {state === 'found' && game && <>
                    <div className='vp-rom-info-banner'>
                        {/* an <img> rather than a CSS background, so a broken link falls back like the box art */}
                        {game.backgrounds[0] && !backgroundFailed &&
                            <img
                                className='vp-rom-info-banner-img'
                                src={game.backgrounds[0].url}
                                alt=''
                                onError={() => setBackgroundFailed(true)}
                            />}
                        <div className='vp-rom-info-banner-fade' />
                        <div className='vp-rom-info-banner-content'>
                            {game.covers[0]?.faces.front && !artFailed
                                ? <img
                                    className='vp-rom-info-banner-art'
                                    src={game.covers[0].faces.front}
                                    alt={nls.localize('vueport/romInfo/boxArtAlt', 'Box art for {0}', game.title)}
                                    onError={() => setArtFailed(true)}
                                />
                                : <img className='vp-rom-info-banner-art' src={emptyBox} alt='' />}
                            <div className='vp-rom-info-banner-text'>
                                <h1 className='vp-rom-info-title'>{game.title}</h1>
                                {subtitle &&
                                    <p className='vp-rom-info-subtitle'>{subtitle}</p>}
                                {publisherLine &&
                                    <p className='vp-rom-info-subtitle vp-rom-info-subtitle-secondary'>
                                        {publisherLine}
                                    </p>}
                                {pills.length > 0 &&
                                    <div className='vp-rom-info-pills'>
                                        {pills.map((pill, index) =>
                                            <span key={index} className='vp-rom-info-pill'>{pill}</span>)}
                                    </div>}
                            </div>
                        </div>
                    </div>

                    {game.description &&
                        <p className='vp-rom-info-description'>{game.description}</p>}

                    {game.planetVbUrl &&
                        <p>
                            <a className='vp-rom-info-link' href={game.planetVbUrl} target='_blank' rel='noreferrer'>
                                {nls.localize('vueport/romInfo/moreOnPlanetVb', 'More on Planet Virtual Boy')}
                                <ArrowSquareOut size={13} />
                            </a>
                        </p>}
                </>}
            </div>

            <section className='vp-rom-info-cartridge'>
                <h4>{nls.localize('vueport/romInfo/romInformation', 'ROM Information')}</h4>
                <div className='vp-rom-info-cartridge-strip'>
                    {romInformation.map(([name, value]) => <div key={name} className='vp-rom-info-cartridge-item'>
                        <span className='vp-rom-info-cartridge-label'>{name}</span>
                        <span className='vp-rom-info-cartridge-value'>{value}</span>
                    </div>)}
                </div>
            </section>

            <section className='vp-rom-info-cartridge'>
                <h4>{nls.localize('vueport/romInfo/romHeader', 'ROM Header')}</h4>
                <div className='vp-rom-info-cartridge-strip'>
                    {romHeaderInfo.map(([name, value]) => <div key={name} className='vp-rom-info-cartridge-item'>
                        <span className='vp-rom-info-cartridge-label'>{name}</span>
                        <span className='vp-rom-info-cartridge-value'>{value}</span>
                    </div>)}
                </div>
            </section>
        </div>
    </Window>;
}

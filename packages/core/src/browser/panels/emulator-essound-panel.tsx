import { MusicNotes, Play, Plug, Stop } from '@phosphor-icons/react';
import { formatLogTime } from '../../common/emulator-log';
import { nls } from '../../common/emulator-nls';
import * as React from 'react';
import EmptyContainer from '../components/kit/EmptyContainer';
import {
    ES_SOUND_FIRST_MP3,
    ES_SOUND_FIRST_WAV,
    ES_SOUND_LAST_MP3,
    ES_SOUND_LAST_WAV,
    ES_SOUND_TITLES_FILE,
} from '../../common/emulator-essound';
import { ES_SOUND_HISTORY_LENGTH, EsSoundNowPlaying, EsSoundPlayer, EsSoundTrack } from '../emulator-essound-player';
import { EmulatorPanelType, hex, DebugSource, Panel } from './emulator-panel';
import { emulatorPanelTitleIcon } from './emulator-panel-icons';

// `0:07`, `1:58`: a track's length, and how far into it playback is
function formatDuration(seconds: number): string {
    const whole = Math.floor(Math.max(0, seconds));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export class EsSoundPanel extends Panel {

    constructor(
        source: DebugSource,
        instanceId: string,
        protected readonly player: EsSoundPlayer
    ) {
        super(EmulatorPanelType.ES_SOUND, source, instanceId);
        this.title.label = nls.localize('vueport/debug/panels/esSound/title', 'ESSound');
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.ES_SOUND);
        this.addClass('vp-split');
        this.addClass('vp-essound');
        this.toDispose.push(this.player.onDidChange(() => this.update()));
    }

    // only the playback position moves between announced changes, so polling redraws only while something plays
    protected refresh(): void {
        if (this.player.playing.length > 0) {
            this.update();
        }
    }

    protected render(): React.ReactNode {
        if (!this.player.isScanned) {
            return <EmptyContainer
                title={nls.localize(
                    'vueport/general/notRunning',
                    'The emulator is not running.',
                )}
                icon={<Plug size={32} />}
            />;
        }

        const tracks = this.player.list;
        const nowPlaying = this.player.nowPlaying;
        // "none found" reads the same for an empty folder, wrongly named files or an unreadable folder,
        // so the folder is named and any refusal repeated verbatim
        const lookedIn = this.player.lookedIn;
        const failure = this.player.scanFailure;

        return <>
            {tracks.length === 0
                ? <EmptyContainer
                    title={failure
                        ? nls.localize('vueport/debug/panels/esSound/unreadable', 'The ROM\'s folder could not be read')
                        : nls.localize('vueport/debug/panels/esSound/noFiles', 'No ESSound audio files found')}
                    description={lookedIn === undefined
                        ? nls.localize(
                            'vueport/debug/panels/esSound/noFolderDescription',
                            'Where this ROM came from is not known, so there is no folder to look in. Pack {0} up to {1} \
and/or {2} up to {3} into a .vbz together with the ROM and open that instead. Until there is something to play, the \
emulator will pretend that it does not support ESSound.',
                            `${ES_SOUND_FIRST_MP3}.mp3`,
                            `${ES_SOUND_LAST_MP3}.mp3`,
                            `${ES_SOUND_FIRST_WAV}.wav`,
                            `${ES_SOUND_LAST_WAV}.wav`,
                        )
                        : failure
                        ? nls.localize(
                            'vueport/debug/panels/esSound/unreadableDescription',
                            'Looked in {0}: {1}',
                            lookedIn ?? '?', failure)
                        : nls.localize(
                            'vueport/debug/panels/esSound/noFilesDescription',
                            'Put {0} up to {1} and/or {2} up to {3} next to the ROM, then load it again. Until there is \
something to play, the emulator will pretend that it does not support ESSound. Looked in {4}.',
                            `${ES_SOUND_FIRST_MP3}.mp3`,
                            `${ES_SOUND_LAST_MP3}.mp3`,
                            `${ES_SOUND_FIRST_WAV}.wav`,
                            `${ES_SOUND_LAST_WAV}.wav`,
                            lookedIn ?? '?',
                        )}
                    icon={<MusicNotes size={32} />}
                />
                : <div className='vp-essound-layout'>
                    <section className='vp-essound-files'>
                        {nowPlaying.length === 0
                            ? this.renderNothingPlaying()
                            : nowPlaying.map(entry => this.renderNowPlaying(entry))}
                        <div className='vp-essound-scroll vp-scroll'>
                            <table className='vp-table vp-essound-table vp-essound-tracks'>
                                <thead>
                                    <tr>
                                        <th>#</th>
                                        <th>{nls.localize('vueport/debug/panels/esSound/titleColumn', 'Title')}</th>
                                        <th>{nls.localize('vueport/general/file', 'File')}</th>
                                        <th className='length'>{nls.localize('vueport/debug/panels/esSound/length', 'Length')}</th>
                                        <th />
                                    </tr>
                                </thead>
                                <tbody>
                                    {tracks.map(track => {
                                        const playing = nowPlaying.some(entry => entry.track === track);
                                        return <tr key={track.id} className={playing ? 'playing' : ''}>
                                            <td>{track.id}</td>
                                            <td className='name title' title={track.title}>{track.title ?? ''}</td>
                                            <td className='name'>{track.name}</td>
                                            <td className='length'>
                                                {track.seconds === undefined ? '–' : formatDuration(track.seconds)}
                                            </td>
                                            <td>{this.renderPlayButton(track, playing)}</td>
                                        </tr>;
                                    })}
                                </tbody>
                            </table>
                        </div>
                        {this.player.titlesProblem && <div className='vp-footer'>
                            {nls.localize(
                                'vueport/debug/panels/esSound/titlesProblem',
                                '{0} could not be used: {1}',
                                ES_SOUND_TITLES_FILE, this.player.titlesProblem)}
                        </div>}
                    </section>
                    {this.renderHistory()}
                </div>
            }
        </>;
    }

    protected renderNowPlaying(entry: EsSoundNowPlaying): React.ReactNode {
        const { track, position, loop, waiting } = entry;
        const length = track.seconds;
        const progress = length ? Math.min(1, position / length) : 0;
        const details = [
            track.name,
            `${Math.round(track.size / 1024)} KB`,
            loop
                ? nls.localize('vueport/debug/panels/esSound/looping', 'looping')
                : nls.localize('vueport/debug/panels/esSound/once', 'once'),
        ];
        if (waiting) {
            details.push(nls.localize('vueport/debug/panels/esSound/waiting', 'waiting'));
        }
        return <div key={track.kind} className='vp-essound-now'>
            {this.renderPlayButton(track, true)}
            <div className='vp-essound-now-text'>
                <div className='vp-essound-now-title'>
                    {track.title ?? nls.localize('vueport/debug/panels/esSound/trackNumber', 'Track {0}', track.id)}
                </div>
                <div className='vp-essound-now-details'>{details.join(' · ')}</div>
            </div>
            <div className='vp-essound-now-time'>
                {formatDuration(position)} / {length === undefined ? '–' : formatDuration(length)}
            </div>
            <div
                className={`vp-essound-now-bar${length ? ' seekable' : ''}`}
                title={length ? nls.localize('vueport/debug/panels/esSound/seek', 'Click to jump there') : undefined}
                onClick={length ? event => this.seek(event, track, length) : undefined}
            >
                <div className='vp-essound-now-track'>
                    <div style={{ width: `${progress * 100}%` }} />
                </div>
            </div>
        </div>;
    }

    // the same block with nothing in it, so the list below does not jump when a track starts or ends
    protected renderNothingPlaying(): React.ReactNode {
        return <div className='vp-essound-now idle'>
            <button className='vp-essound-play' disabled>
                <Stop size={12} weight='fill' />
            </button>
            <div className='vp-essound-now-text'>
                <div className='vp-essound-now-title'>
                    {nls.localize('vueport/debug/panels/esSound/nothingPlaying', 'Nothing is playing')}
                </div>
                <div className='vp-essound-now-details'>
                    {nls.localize('vueport/debug/panels/esSound/pickTrack', 'Play a track from the list below')}
                </div>
            </div>
            <div className='vp-essound-now-time'>0:00 / 0:00</div>
            <div className='vp-essound-now-bar'>
                <div className='vp-essound-now-track' />
            </div>
        </div>;
    }

    protected seek(event: React.MouseEvent<HTMLElement>, track: EsSoundTrack, length: number): void {
        const bounds = event.currentTarget.getBoundingClientRect();
        const fraction = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
        this.player.seek(track.id, fraction * length);
    }

    protected renderPlayButton(track: EsSoundTrack, playing: boolean): React.ReactNode {
        return playing
            ? <button
                className='vp-essound-play playing'
                title={nls.localize('vueport/debug/panels/esSound/stop', 'Stop {0}', track.name)}
                onClick={() => this.player.stopTrack(track.id)}
            >
                <Stop size={12} weight='fill' />
            </button>
            : <button
                className='vp-essound-play'
                title={nls.localize('vueport/debug/panels/esSound/play', 'Play {0}', track.name)}
                onClick={() => this.player.audition(track.id)}
            >
                <Play size={12} weight='fill' />
            </button>;
    }

    protected renderHistory(): React.ReactNode {
        const commands = this.player.commands;
        return <section className='vp-essound-history'>
            <h4>
                {nls.localize('vueport/debug/panels/esSound/lastCommands', 'Last {0} Commands', ES_SOUND_HISTORY_LENGTH)}
            </h4>
            <div className='vp-essound-scroll vp-scroll'>
                {commands.length === 0
                    ? <div className='vp-footer'>
                        {nls.localize('vueport/debug/panels/esSound/noCommands', 'The game has not written to the ESSound port.')}
                    </div>
                    : <table className='vp-table vp-essound-table'>
                        <tbody>
                            {commands.map((entry, index) => (
                                <tr key={index} className={entry.problem ? 'inactive' : ''} title={entry.problem}>
                                    <td className='vp-log-time'>{formatLogTime(entry.time)}</td>
                                    <td><code>{hex(entry.message.raw, 4)}</code></td>
                                    <td className='name'>{entry.description}</td>
                                    <td className='name'>{entry.problem ?? ''}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                }
            </div>
        </section>;
    }
}

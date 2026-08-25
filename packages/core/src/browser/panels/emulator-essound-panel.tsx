import { MusicNotes, Plug } from '@phosphor-icons/react';
import { nls } from '../../common/emulator-nls';
import * as React from 'react';
import HContainer from '../components/kit/HContainer';
import EmptyContainer from '../components/kit/EmptyContainer';
import {
    ES_SOUND_FIRST_MP3,
    ES_SOUND_FIRST_WAV,
    ES_SOUND_LAST_MP3,
    ES_SOUND_LAST_WAV,
} from '../../common/emulator-essound';
import { ES_SOUND_HISTORY_LENGTH, VesEmulatorEsSoundPlayer } from '../emulator-essound-player';
import { EmulatorPanelType, hex, VesEmulatorDebugSource, VesEmulatorPanel } from './emulator-panel';

export class VesEmulatorEsSoundPanel extends VesEmulatorPanel {

    constructor(
        source: VesEmulatorDebugSource,
        instanceId: string,
        protected readonly player: VesEmulatorEsSoundPlayer
    ) {
        super(EmulatorPanelType.ES_SOUND, source, instanceId);
        this.title.label = nls.localize('vueport/panels/esSound', 'ESSound');
        this.addClass('vueport-vip-split');
        this.toDispose.push(this.player.onDidChange(() => this.update()));
    }

    protected startPolling(): void {
        this.refresh();
    }

    protected refresh(): void {
        this.update();
    }

    protected render(): React.ReactNode {
        if (!this.player.isScanned) {
            return <EmptyContainer
                title={nls.localize(
                  'vueport/panels/notRunning',
                  'The emulator is not running.',
                )}
                icon={<Plug size={32} />}
            />;
        }

        const tracks = this.player.list;
        const playing = this.player.playing;

        return <>
            {tracks.length === 0
                ? <EmptyContainer
                    title={nls.localize('vueport/esSound/noFiles', 'No ESSound audio files found')}
                    description={nls.localize(
                        'vueport/esSound/noFilesDescription',
                        'Put {0} up to {1} and/or {2} up to {3} next to the ROM, then load it again. Until there is \
something to play, the emulator will pretend that it does not support ESSound.',
                        `${ES_SOUND_FIRST_MP3}.mp3`,
                        `${ES_SOUND_LAST_MP3}.mp3`,
                        `${ES_SOUND_FIRST_WAV}.wav`,
                        `${ES_SOUND_LAST_WAV}.wav`,
                    )}
                    icon={<MusicNotes size={32} />}
                />
                : <HContainer>
                    <table className='vueport-vip-table vueport-essound-table'>
                        <thead>
                            <tr>
                                <th>{nls.localize('vueport/esSound/track', 'Track')}</th>
                                <th>{nls.localize('vueport/general/file', 'File')}</th>
                                <th>{nls.localize('vueport/esSound/size', 'Size')}</th>
                                <th>{nls.localize('vueport/esSound/state', 'State')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {tracks.map(track => (
                                <tr key={track.id}>
                                    <td>{track.id}</td>
                                    <td className='name'>{track.name}</td>
                                    <td>{Math.round(track.size / 1024)} KB</td>
                                    <td>{playing.includes(track.id)
                                        ? nls.localize('vueport/esSound/playing', 'Playing')
                                        : ''}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {this.renderHistory()}
                </HContainer>
            }
        </>;
    }

    protected renderHistory(): React.ReactNode {
        const commands = this.player.commands;
        return <div className='vueport-vip-detail'>
            <fieldset className='vueport-vip-inspector-group vueport-essound-history'>
                <legend>
                    {nls.localize('vueport/esSound/lastCommands', 'Last {0} Commands', ES_SOUND_HISTORY_LENGTH)}
                </legend>
                {commands.length === 0
                    ? <div className='vueport-vip-footer'>
                        {nls.localize('vueport/esSound/noCommands', 'The game has not written to the ESSound port.')}
                    </div>
                    : <table className='vueport-vip-table vueport-essound-table'>
                        <tbody>
                            {commands.map((entry, index) => (
                                <tr key={index} className={entry.problem ? 'inactive' : ''} title={entry.problem}>
                                    <td><code>{hex(entry.message.raw, 4)}</code></td>
                                    <td className='name'>{entry.description}</td>
                                    <td className='name'>{entry.problem ?? ''}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                }
            </fieldset>
        </div>;
    }
}

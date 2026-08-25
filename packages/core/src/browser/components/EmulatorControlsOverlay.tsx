import { nls } from '../../common/emulator-nls';
import { VueportInputBindings, VueportSettings } from '../../common/emulator-settings';
import * as React from 'react';
import styled from 'styled-components';
// Reached through `src` rather than as a sibling, because `tsc` emits no
// assets: the path has to be the one that works from `lib/browser/components`,
// where this ends up. `declare module '*.png'` is what lets it type-check from
// the source's own position. The package ships `src` as well as `lib`.
import IMAGE_VB_CONTROLLER from '../../../src/browser/images/vb-controller.png';
import HContainer from '../components/kit/HContainer';
import VContainer from '../components/kit/VContainer';
import RadioSelect from '../components/kit/RadioSelect';
import EmulatorButtonAssignment, { EmulatorAssignableCommand } from './EmulatorButtonAssignment';
import { EmulatorCommands, EmulatorGamePadButton, emulatorGamePadCommand } from '../emulator-commands';
import { EMULATOR_FOCUS_CONTEXT } from '../emulator-commands';

const ControlsOverlay = styled.div`
  align-items: flex-start;
  display: flex;
  height: 100%;
  padding: calc(var(--theia-ui-padding) * 4) calc(var(--theia-ui-padding) * 2);

  &>div {
    margin: auto;
  }

  &>div>div {
    align-self: center;
    display: flex;
    justify-content: space-between;
  }

  &>div>div {
    border-bottom: 1px dashed var(--theia-editorGroup-border);
    margin-bottom: calc(var(--theia-ui-padding) * 4);
    padding-bottom: calc(var(--theia-ui-padding) * 4);
  }

  &>div>div:last-child {
    border-bottom: none;
    margin-bottom: 0;
    padding-bottom: 0;
  }
`;

const Controller = styled.div`
    align-items: center;

    .controllerImage {
        margin: 0 calc(var(--theia-ui-padding) * 4);
        position: relative;
    }

    .controllerImage img {
        max-width: 500px;
        width: 100%;
    }
`;

const SameControls = styled.label`
    align-items: center;
    cursor: pointer;
    display: flex;
    gap: var(--theia-ui-padding);
`;

const ControllerImage = styled.div`
    margin: 0 calc(var(--theia-ui-padding) * 4);
    position: relative;

    img {
        max-width: 500px;
        width: 100%;
    }
`;

const ControllerButtonOverlay = styled.div`
    border: 4px solid var(--theia-focusBorder);
    cursor: pointer;
    opacity: 0;
    position: absolute;

    &:hover,
    &.highlighted {
        opacity: 1;
    }

    &.power {
        height: 4%;
        left: 43.1%;
        top: 35%;
        width: 12.4%;
        border-radius: 2px;
    }

    &.select,
    &.start,
    &.a,
    &.b,
    &.lt,
    &.rt {
        border-radius: 50%;
        height: 7.8%;
        width: 7.8%;
    }

    &.lup,
    &.lleft,
    &.lright,
    &.ldown,
    &.rup,
    &.rleft,
    &.rright,
    &.rdown {
        border-radius: 2px;
        height: 5.5%;
        width: 5.5%;
    }

    &.select {
        left: 26.5%;
        top: 37.6%;
    }

    &.start {
        left: 34.2%;
        top: 41.35%;
    }

    &.lup {
        border-bottom-width: 0;
        left: 14.3%;
        top: 29%;
    }

    &.lleft {
        border-right-width: 0;
        left: 10%;
        top: 33.1%;
    }

    &.lright {
        border-left-width: 0;
        left: 19.5%;
        top: 33.1%;
    }

    &.ldown {
        border-top-width: 0;
        left: 14.3%;
        top: 38%;
    }

    &.lt {
        left: 13.2%;
        top: 6.9%;
    }

    &.b {
        right: 34.2%;
        top: 41.35%;
    }

    &.a {
        right: 26.4%;
        top: 37.6%;
    }

    &.rup {
        border-bottom-width: 0;
        right: 14.2%;
        top: 29%;
    }

    &.rleft {
        border-right-width: 0;
        right: 19.5%;
        top: 33.1%;
    }

    &.rright {
        border-left-width: 0;
        right: 9.9%;
        top: 33.1%;
    }

    &.rdown {
        border-top-width: 0;
        right: 14.2%;
        top: 38%;
    }

    &.rt {
        right: 13%;
        top: 6.9%;
    }
`;

export interface EmulatorControlsOverlayProps {
    settings: VueportSettings
    bindings: VueportInputBindings
}

export interface EmulatorControlsOverlayState {
    /** Whose mappings are being looked at, which is not tied to any emulator. */
    player: number
}

export class EmulatorControlsOverlay extends React.Component<EmulatorControlsOverlayProps, EmulatorControlsOverlayState> {
    protected settings: VueportSettings;
    protected bindings: VueportInputBindings;

    protected controllerButtonAssignmentSelectRef = React.createRef<HTMLDivElement>();
    protected controllerButtonAssignmentStartRef = React.createRef<HTMLDivElement>();
    protected controllerButtonAssignmentARef = React.createRef<HTMLDivElement>();
    protected controllerButtonAssignmentBRef = React.createRef<HTMLDivElement>();
    protected controllerButtonAssignmentLUpRef = React.createRef<HTMLDivElement>();
    protected controllerButtonAssignmentLLeftRef = React.createRef<HTMLDivElement>();
    protected controllerButtonAssignmentLRightRef = React.createRef<HTMLDivElement>();
    protected controllerButtonAssignmentLDownRef = React.createRef<HTMLDivElement>();
    protected controllerButtonAssignmentRUpRef = React.createRef<HTMLDivElement>();
    protected controllerButtonAssignmentRLeftRef = React.createRef<HTMLDivElement>();
    protected controllerButtonAssignmentRRightRef = React.createRef<HTMLDivElement>();
    protected controllerButtonAssignmentRDownRef = React.createRef<HTMLDivElement>();
    protected controllerButtonAssignmentLTRef = React.createRef<HTMLDivElement>();
    protected controllerButtonAssignmentRTRef = React.createRef<HTMLDivElement>();
    protected controllerButtonAssignmentPowerRef = React.createRef<HTMLDivElement>();
    protected controllerButtonSelectRef = React.createRef<HTMLDivElement>();
    protected controllerButtonStartRef = React.createRef<HTMLDivElement>();
    protected controllerButtonARef = React.createRef<HTMLDivElement>();
    protected controllerButtonBRef = React.createRef<HTMLDivElement>();
    protected controllerButtonLUpRef = React.createRef<HTMLDivElement>();
    protected controllerButtonLLeftRef = React.createRef<HTMLDivElement>();
    protected controllerButtonLRightRef = React.createRef<HTMLDivElement>();
    protected controllerButtonLDownRef = React.createRef<HTMLDivElement>();
    protected controllerButtonRUpRef = React.createRef<HTMLDivElement>();
    protected controllerButtonRLeftRef = React.createRef<HTMLDivElement>();
    protected controllerButtonRRightRef = React.createRef<HTMLDivElement>();
    protected controllerButtonRDownRef = React.createRef<HTMLDivElement>();
    protected controllerButtonLTRef = React.createRef<HTMLDivElement>();
    protected controllerButtonRTRef = React.createRef<HTMLDivElement>();
    protected controllerButtonPowerRef = React.createRef<HTMLDivElement>();

    constructor(props: EmulatorControlsOverlayProps) {
        super(props);

        this.bindings = props.bindings;
        this.settings = props.settings;
        this.state = { player: 1 };
    }

    /**
     * The command carrying one button's mapping for the player being looked
     * at. Player 2 has a set of its own, which is what makes its controls
     * separately configurable.
     */
    protected commandFor(button: EmulatorGamePadButton): EmulatorAssignableCommand {
        return emulatorGamePadCommand(button, this.state.player);
    }

    protected setPlayer(player: number): void {
        this.setState({ player });
    }

    /** Whether player 2 answers to player 1's keys. */
    protected get sameControls(): boolean {
        return this.settings.get('player2SameControls');
    }

    protected async setSameControls(sameControls: boolean): Promise<void> {
        await this.settings.set('player2SameControls', sameControls);
        // Nothing else here holds the answer, so the redraw has to be asked for.
        this.forceUpdate();
    }

    render(): React.JSX.Element {
        const isPlayer2 = this.state.player === 2;
        // Nothing to configure while player 2 is on player 1's keys, and the
        // function keys below are the application's rather than either
        // player's, so they belong to the first player's page only.
        const configurable = !isPlayer2 || !this.sameControls;

        return <ControlsOverlay>
            <div>
                <div>
                    <VContainer>
                        <RadioSelect
                            options={[
                                { value: 1, label: nls.localize('vueport/player1', 'Player 1') },
                                { value: 2, label: nls.localize('vueport/player2', 'Player 2') },
                            ]}
                            defaultValue={this.state.player}
                            onChange={options => this.setPlayer(options[0].value as number)}
                        />
                        {isPlayer2 &&
                            <SameControls>
                                <input
                                    type='checkbox'
                                    checked={this.sameControls}
                                    onChange={e => this.setSameControls(e.target.checked)}
                                />
                                {nls.localize('vueport/sameAsPlayer1', 'Same as Player 1')}
                            </SameControls>
                        }
                    </VContainer>
                </div>
                {!configurable &&
                    <div>
                        <VContainer>
                            {nls.localize(
                                'vueport/player2SameControlsHint',
                                'Player 2 answers to the same keys as player 1. Uncheck the box above to give it a set of its own.',
                            )}
                        </VContainer>
                    </div>
                }
                {configurable && <>
                <Controller>
                    <VContainer>
                        <EmulatorButtonAssignment
                            command={this.commandFor('lTrigger')}
                            refObject={this.controllerButtonAssignmentLTRef}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonLTRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonLTRef)}
                        />
                        <br />
                        <EmulatorButtonAssignment
                            command={this.commandFor('lUp')}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                            refObject={this.controllerButtonAssignmentLUpRef}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonLUpRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonLUpRef)}
                        />
                        <EmulatorButtonAssignment
                            command={this.commandFor('lRight')}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                            refObject={this.controllerButtonAssignmentLRightRef}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonLRightRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonLRightRef)}
                        />
                        <EmulatorButtonAssignment
                            command={this.commandFor('lDown')}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                            refObject={this.controllerButtonAssignmentLDownRef}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonLDownRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonLDownRef)}
                        />
                        <EmulatorButtonAssignment
                            command={this.commandFor('lLeft')}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                            refObject={this.controllerButtonAssignmentLLeftRef}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonLLeftRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonLLeftRef)}
                        />
                        <br />
                        <EmulatorButtonAssignment
                            command={this.commandFor('select')}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                            refObject={this.controllerButtonAssignmentSelectRef}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonSelectRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonSelectRef)}
                        />
                        <EmulatorButtonAssignment
                            command={this.commandFor('start')}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                            refObject={this.controllerButtonAssignmentStartRef}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonStartRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonStartRef)}
                        />
                    </VContainer>
                    <ControllerImage>
                        <img src={IMAGE_VB_CONTROLLER} />
                        <ControllerButtonOverlay
                            className='power'
                            ref={this.controllerButtonPowerRef}
                            onClick={() => this.assignKeybinding(EmulatorCommands.INPUT_TOGGLE_LOW_POWER)}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonAssignmentPowerRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonAssignmentPowerRef)}
                        />
                        <ControllerButtonOverlay
                            className='select'
                            ref={this.controllerButtonSelectRef}
                            onClick={() => this.assignKeybinding(this.commandFor('select'))}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonAssignmentSelectRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonAssignmentSelectRef)}
                        />
                        <ControllerButtonOverlay
                            className='start'
                            ref={this.controllerButtonStartRef}
                            onClick={() => this.assignKeybinding(this.commandFor('start'))}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonAssignmentStartRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonAssignmentStartRef)}
                        />
                        <ControllerButtonOverlay
                            className='a'
                            ref={this.controllerButtonARef}
                            onClick={() => this.assignKeybinding(this.commandFor('a'))}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonAssignmentARef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonAssignmentARef)}
                        />
                        <ControllerButtonOverlay
                            className='b'
                            ref={this.controllerButtonBRef}
                            onClick={() => this.assignKeybinding(this.commandFor('b'))}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonAssignmentBRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonAssignmentBRef)}
                        />
                        <ControllerButtonOverlay
                            className='lup'
                            ref={this.controllerButtonLUpRef}
                            onClick={() => this.assignKeybinding(this.commandFor('lUp'))}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonAssignmentLUpRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonAssignmentLUpRef)}
                        />
                        <ControllerButtonOverlay
                            className='lleft'
                            ref={this.controllerButtonLLeftRef}
                            onClick={() => this.assignKeybinding(this.commandFor('lLeft'))}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonAssignmentLLeftRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonAssignmentLLeftRef)}
                        />
                        <ControllerButtonOverlay
                            className='lright'
                            ref={this.controllerButtonLRightRef}
                            onClick={() => this.assignKeybinding(this.commandFor('lRight'))}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonAssignmentLRightRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonAssignmentLRightRef)}
                        />
                        <ControllerButtonOverlay
                            className='ldown'
                            ref={this.controllerButtonLDownRef}
                            onClick={() => this.assignKeybinding(this.commandFor('lDown'))}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonAssignmentLDownRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonAssignmentLDownRef)}
                        />
                        <ControllerButtonOverlay
                            className='rup'
                            ref={this.controllerButtonRUpRef}
                            onClick={() => this.assignKeybinding(this.commandFor('rUp'))}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonAssignmentRUpRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonAssignmentRUpRef)}
                        />
                        <ControllerButtonOverlay
                            className='rleft'
                            ref={this.controllerButtonRLeftRef}
                            onClick={() => this.assignKeybinding(this.commandFor('rLeft'))}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonAssignmentRLeftRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonAssignmentRLeftRef)}
                        />
                        <ControllerButtonOverlay
                            className='rright'
                            ref={this.controllerButtonRRightRef}
                            onClick={() => this.assignKeybinding(this.commandFor('rRight'))}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonAssignmentRRightRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonAssignmentRRightRef)}
                        />
                        <ControllerButtonOverlay
                            className='rdown'
                            ref={this.controllerButtonRDownRef}
                            onClick={() => this.assignKeybinding(this.commandFor('rDown'))}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonAssignmentRDownRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonAssignmentRDownRef)}
                        />
                        <ControllerButtonOverlay
                            className='lt'
                            ref={this.controllerButtonLTRef}
                            onClick={() => this.assignKeybinding(this.commandFor('lTrigger'))}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonAssignmentLTRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonAssignmentLTRef)}
                        />
                        <ControllerButtonOverlay
                            className='rt'
                            ref={this.controllerButtonRTRef}
                            onClick={() => this.assignKeybinding(this.commandFor('rTrigger'))}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonAssignmentRTRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonAssignmentRTRef)}
                        />
                    </ControllerImage>
                    <VContainer>
                        <EmulatorButtonAssignment
                            command={this.commandFor('rTrigger')}
                            refObject={this.controllerButtonAssignmentRTRef}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonRTRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonRTRef)}
                        />
                        <br />
                        <EmulatorButtonAssignment
                            command={this.commandFor('rUp')}
                            refObject={this.controllerButtonAssignmentRUpRef}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonRUpRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonRUpRef)}
                        />
                        <EmulatorButtonAssignment
                            command={this.commandFor('rRight')}
                            refObject={this.controllerButtonAssignmentRRightRef}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonRRightRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonRRightRef)}
                        />
                        <EmulatorButtonAssignment
                            command={this.commandFor('rDown')}
                            refObject={this.controllerButtonAssignmentRDownRef}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonRDownRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonRDownRef)}
                        />
                        <EmulatorButtonAssignment
                            command={this.commandFor('rLeft')}
                            refObject={this.controllerButtonAssignmentRLeftRef}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonRLeftRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonRLeftRef)}
                        />
                        <br />
                        <EmulatorButtonAssignment
                            command={this.commandFor('a')}
                            refObject={this.controllerButtonAssignmentARef}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonARef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonARef)}
                        />
                        <EmulatorButtonAssignment
                            command={this.commandFor('b')}
                            refObject={this.controllerButtonAssignmentBRef}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonBRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonBRef)}
                        />
                    </VContainer>
                </Controller>
                </>}
                {this.state.player === 1 &&
                <HContainer>
                    <VContainer>
                        <EmulatorButtonAssignment
                            command={EmulatorCommands.INPUT_PAUSE_TOGGLE}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                        />
                        <EmulatorButtonAssignment
                            command={EmulatorCommands.INPUT_RESET}
                            refObject={this.controllerButtonAssignmentPowerRef}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                            onMouseEnter={() => this.toggleRefHighlighted(this.controllerButtonPowerRef)}
                            onMouseLeave={() => this.toggleRefHighlighted(this.controllerButtonPowerRef)}
                        />
                        <EmulatorButtonAssignment
                            command={EmulatorCommands.INPUT_AUDIO_MUTE}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                        />
                        <EmulatorButtonAssignment
                            command={EmulatorCommands.INPUT_TOGGLE_LOW_POWER}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                        />
                    </VContainer>
                    <VContainer>
                        <EmulatorButtonAssignment
                            command={EmulatorCommands.INPUT_FRAME_ADVANCE}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                        />
                        <EmulatorButtonAssignment
                            command={EmulatorCommands.INPUT_TOGGLE_FAST_FORWARD}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                        />
                        <EmulatorButtonAssignment
                            command={EmulatorCommands.INPUT_TOGGLE_SLOWMOTION}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                        />
                        <EmulatorButtonAssignment
                            command={EmulatorCommands.INPUT_REWIND}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                        />
                    </VContainer>
                    <VContainer>
                        <EmulatorButtonAssignment
                            command={EmulatorCommands.INPUT_SAVE_STATE}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                        />
                        <EmulatorButtonAssignment
                            command={EmulatorCommands.INPUT_LOAD_STATE}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                        />
                        <EmulatorButtonAssignment
                            command={EmulatorCommands.INPUT_STATE_SLOT_INCREASE}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                        />
                        <EmulatorButtonAssignment
                            command={EmulatorCommands.INPUT_STATE_SLOT_DECREASE}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                        />
                    </VContainer>
                    <VContainer>
                        <EmulatorButtonAssignment
                            command={EmulatorCommands.INPUT_FULLSCREEN}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                        />
                        <EmulatorButtonAssignment
                            command={EmulatorCommands.INPUT_SCREENSHOT}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                        />
                        <EmulatorButtonAssignment
                            command={EmulatorCommands.INPUT_TOGGLE_CONTROLS_OVERLAY}
                            bindings={this.bindings}
                            when={EMULATOR_FOCUS_CONTEXT}
                        />
                    </VContainer>
                </HContainer>
                }
            </div>
        </ControlsOverlay>;
    }

    protected toggleRefHighlighted = (buttonOverlayRef: React.RefObject<HTMLDivElement>) =>
        buttonOverlayRef.current?.classList.toggle('highlighted');

    /**
     * Clicking a button on the picture maps a key to it, the same as clicking
     * its row. The rows read their mapping from the keybinding registry as
     * they render, so a change made here needs a redraw to show up in them.
     */
    protected assignKeybinding = async (command: EmulatorAssignableCommand) => {
        if (await this.bindings.capture(command, EMULATOR_FOCUS_CONTEXT)) {
            this.forceUpdate();
        }
    };

}

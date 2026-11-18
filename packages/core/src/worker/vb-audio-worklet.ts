// drains the core worker's interleaved stereo buffers into the audio graph and returns each emptied one. That return
// clocks emulation, so this is the session's timing source; buffers are cycled, never allocated or copied. Bundled as a
// standalone AudioWorklet entry point, so it must not import anything from Theia

import { VB_AUDIO_PROCESSOR } from '../common/vb-constants';

// AudioWorklet globals, which lib.dom does not declare
declare abstract class AudioWorkletProcessor {
    readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioProcessor): void;

class AudioProcessor extends AudioWorkletProcessor {

    protected readonly buffers: Float32Array[] = []; // filled buffers waiting to be played, oldest first

    protected offset = 0; // read position within the oldest buffer, in floats

    protected core: MessagePort | undefined;

    constructor() {
        super();
        this.port.onmessage = event => {
            this.core = event.data.core as MessagePort;
            this.core.onmessage = message => this.receive(message.data);
            this.port.postMessage(0);
        };
    }

    // buffers and instructions share the port so they stay in order: a flush has to land between the audio before and
    // after it
    protected receive(data: ArrayBuffer | { flush: true }): void {
        if (data instanceof ArrayBuffer) {
            this.buffers.push(new Float32Array(data));
            return;
        }
        if (data.flush) {
            this.flush();
        }
    }

    // queued audio came from a machine state that has since been reset or replaced by a loaded state
    protected flush(): void {
        this.offset = 0;
        if (this.buffers.length === 0) {
            return;
        }
        const emptied = this.buffers.splice(0).map(buffer => buffer.buffer as ArrayBuffer);
        this.core?.postMessage(emptied, emptied);
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        const output = outputs[0];
        const length = output[0].length;
        let emptied: ArrayBuffer[] | undefined;

        for (let x = 0; x < length;) {

            // underrun: silence for the rest of this quantum rather than stuttering; the worker notices and presents
            // its staged frame
            if (this.buffers.length === 0) {
                for (; x < length; x++) {
                    output[0][x] = output[1][x] = 0;
                }
                break;
            }

            const buffer = this.buffers[0];
            let y = this.offset;
            for (; x < length && y < buffer.length; x++, y += 2) {
                output[0][x] = buffer[y];
                output[1][x] = buffer[y + 1];
            }

            if (y === buffer.length) {
                emptied ??= [];
                emptied.push(this.buffers.shift()!.buffer as ArrayBuffer);
                this.offset = 0;
            } else {
                this.offset = y;
            }
        }

        if (emptied) {
            this.core?.postMessage(emptied, emptied);
        }

        return true;
    }
}

registerProcessor(VB_AUDIO_PROCESSOR, AudioProcessor);

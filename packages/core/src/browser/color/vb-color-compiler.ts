import { ColorCompileReply, ColorCompileRequest } from '../../common/vb-color-compile-protocol';
import { ColorBuild, ColorPackageIndex, ColorPaintLayer, compileColorPackage } from '../../common/vb-color-package';

// compiles a VB Color package plus the editor's paint, in a worker if the host provides one (a build can take a
// second or more and shouldn't block the page), otherwise on the main thread
export class ColorCompiler {
    protected worker?: Worker;
    protected next = 1;
    protected readonly waiting = new Map<number, { resolve: (build: ColorBuild) => void, reject: (error: Error) => void }>();
    protected sent?: string; // key of the package the worker already holds, so its bytes are only sent once

    constructor(protected readonly workerUrl?: string) { }

    // builds `index`'s package with the paint; its file is `source.bytes`, known by `key`, and `source.runtime` is the
    // shipped BPS for packages that only carry its hash
    async compile(key: string, source: { bytes: Uint8Array, runtime?: Uint8Array }, index: ColorPackageIndex, paint: ColorPaintLayer): Promise<ColorBuild> {
        const worker = this.start();
        if (!worker) {
            return compileColorPackage(index.pkg, index.original, paint);
        }
        const id = this.next++;
        const request: ColorCompileRequest = { id, packageKey: key, paint };
        if (this.sent !== key) {
            request.packageBytes = source.bytes;
            request.runtimeBps = source.runtime;
            request.original = index.original;
            this.sent = key;
        }
        return new Promise<ColorBuild>((resolve, reject) => {
            this.waiting.set(id, { resolve, reject });
            worker.postMessage(request);
        });
    }

    protected start(): Worker | undefined {
        if (this.worker || !this.workerUrl || typeof Worker === 'undefined') {
            return this.worker;
        }
        try {
            this.worker = new Worker(this.workerUrl);
        } catch {
            return undefined;
        }
        this.worker.onmessage = (event: MessageEvent<ColorCompileReply>) => {
            const reply = event.data;
            const waiting = this.waiting.get(reply.id);
            this.waiting.delete(reply.id);
            if (!waiting) {
                return;
            }
            if (reply.error !== undefined || !reply.rom) {
                // we no longer know what the worker holds, so send the package again with the next build
                this.sent = undefined;
                // typed compiler errors keep their code and data so colorBuildErrorText can phrase them
                waiting.reject(Object.assign(new Error(reply.error ?? 'the compiler gave no ROM'), {
                    code: reply.errorCode, area: reply.errorArea, context: reply.errorContext, detail: reply.errorDetail,
                    groups: reply.errorGroups, patchGroups: reply.errorPatchGroups, room: reply.errorRoom,
                }));
            } else {
                waiting.resolve({ rom: reply.rom, stats: reply.stats ?? {} });
            }
        };
        this.worker.onerror = event => {
            const error = new Error(event.message || 'the compiler stopped');
            this.waiting.forEach(waiting => waiting.reject(error));
            this.waiting.clear();
            this.dispose();
        };
        return this.worker;
    }

    dispose(): void {
        this.worker?.terminate();
        this.worker = undefined;
        this.sent = undefined;
    }
}

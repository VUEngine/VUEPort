// ProbeForks behind a message port, so a fork run for thousands of frames never holds up the page. Bundled as a
// worker entry by VUEPort's web build and VUEngine Studio, used via ProbeForkWorker in probe-session.ts. Each
// ProbeForkRequest carries an id, each answer the id back with a `result` or an `error`
import { ProbeForkRequest, ProbeForks } from './probe-forks';

const forks = new ProbeForks();

const scope = self as unknown as {
    onmessage: ((event: MessageEvent<ProbeForkRequest>) => void) | null,
    postMessage(message: unknown): void,
};

scope.onmessage = event => {
    const request = event.data;
    forks.handle(request).then(
        result => scope.postMessage({ id: request.id, result }),
        (error: unknown) => scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) }),
    );
};

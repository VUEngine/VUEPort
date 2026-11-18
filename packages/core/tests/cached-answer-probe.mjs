// a value read once and kept, unless the read could not answer: the policy behind the symbol table. A read that
// failed while a build was still writing the `.elf` used to be remembered as "no symbols", leaving the Memory
// Pools and Actors panels empty for as long as the ROM was open
import { CachedAnswer } from '../lib/common/emulator-cached-answer.js';

let failures = 0;
function check(label, actual, expected) {
    if (!Object.is(actual, expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
        return;
    }
    console.log(`  ok   ${label}`);
}

// moved by hand, so no wall time is spent
function clock() {
    let at = 1000;
    return { now: () => at, advance: ms => { at += ms; } };
}

console.log('An answer is read once');
{
    let reads = 0;
    const answer = new CachedAnswer(async () => { reads++; return { value: 'symbols', settled: true }; }, 2000);
    check('the first ask reads', await answer.get(), 'symbols');
    check('the second does not', await answer.get(), 'symbols');
    check('so it was read once', reads, 1);
}

console.log('\nConcurrent askers share one read');
{
    let reads = 0;
    let release;
    const answer = new CachedAnswer(() => {
        reads++;
        return new Promise(resolve => { release = () => resolve({ value: 'symbols', settled: true }); });
    }, 2000);
    const both = Promise.all([answer.get(), answer.get(), answer.get()]);
    release();
    check('all three get the answer', (await both).join(','), 'symbols,symbols,symbols');
    check('from one read', reads, 1);
}

console.log('\n"There is nothing there" is an answer, and is kept');
{
    let reads = 0;
    const answer = new CachedAnswer(async () => { reads++; return { settled: true }; }, 2000);
    check('it answers with nothing', await answer.get(), undefined);
    await answer.get();
    await answer.get();
    check('and is not asked again', reads, 1);
}

console.log('\n"I could not tell" is not, and is retried');
{
    const time = clock();
    let reads = 0;
    const answer = new CachedAnswer(async () => {
        reads++;
        return reads < 3 ? { settled: false } : { value: 'symbols', settled: true };
    }, 2000, time.now);

    check('the first read cannot answer', await answer.get(), undefined);
    check('asking again inside the delay does not read', await answer.get(), undefined);
    check('so there has been one read', reads, 1);

    time.advance(2000);
    check('after the delay it tries again', await answer.get(), undefined);
    check('and that is a second read', reads, 2);

    time.advance(2000);
    check('the read that succeeds is the one that is kept', await answer.get(), 'symbols');
    time.advance(10000);
    await answer.get();
    check('and nothing reads after that', reads, 3);
}

console.log('\nA read that throws is a stumble, not an answer');
{
    const time = clock();
    let reads = 0;
    const answer = new CachedAnswer(async () => {
        reads++;
        if (reads === 1) { throw new Error('the file was busy'); }
        return { value: 'symbols', settled: true };
    }, 2000, time.now);

    let message;
    try { await answer.get(); } catch (error) { message = error.message; }
    check('the failure reaches the caller', message, 'the file was busy');
    time.advance(2000);
    check('and the next ask reads again', await answer.get(), 'symbols');
    check('twice in total', reads, 2);
}

console.log('\nClearing forgets the answer and any wait');
{
    const time = clock();
    let reads = 0;
    const answer = new CachedAnswer(async () => { reads++; return { settled: false }; }, 2000, time.now);
    await answer.get();
    check('a failed read leaves nothing held', answer.isAnswered, false);
    answer.clear();
    check('clearing lifts the wait, so a rebuild is picked up at once',
        await answer.get(), undefined);
    check('which read again', reads, 2);
}

console.log('\nClearing mid-read is not undone by the read finishing');
{
    let release;
    const answer = new CachedAnswer(
        () => new Promise(resolve => { release = resolve; }), 2000);
    const inFlight = answer.get();
    answer.clear();
    release({ settled: false });
    await inFlight;
    // the stale read must not set a retry delay on the cleared cache, so a just-rebuilt ROM is readable at once
    let reads = 0;
    const after = new CachedAnswer(async () => { reads++; return { value: 'x', settled: true }; }, 2000);
    check('a cleared cache reads on the next ask', await after.get(), 'x');
    check('the stale read left nothing behind', answer.isAnswered, false);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

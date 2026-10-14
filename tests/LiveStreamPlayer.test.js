import assert from 'node:assert/strict';
import test from 'node:test';

import { LiveStreamPlayer, LIVE_STATE } from '../src/livetv/LiveStreamPlayer.js';

/**
 * ============================================================================
 * Dispatcharr Live Player Connection Test Suite
 * ============================================================================
 * Verifies the "one connection at a time" contract of LiveStreamPlayer
 * against a fake engine and a virtual clock:
 *   1. A stream is never opened while another one is open.
 *   2. The next channel opens only `switchDelay` ms after the previous closed.
 *   3. Fast zapping opens only the last requested channel.
 *   4. Failures are retried a bounded number of times, then the player stops.
 *   5. Stop/Back during a pending retry never reopens a stream.
 *   6. Events of a closed stream are ignored.
 * ============================================================================
 */

const SWITCH_DELAY = 1000;

function flushMicrotasks() {
    let chain = Promise.resolve();
    for (let i = 0; i < 50; i++) chain = chain.then(() => {});
    return chain;
}

function createClock() {
    let now = 0;
    let nextId = 1;
    const timers = new Map();
    return {
        now: () => now,
        setTimeout: (fn, ms) => {
            const id = nextId++;
            timers.set(id, { at: now + ms, fn });
            return id;
        },
        clearTimeout: (id) => timers.delete(id),
        /** Run every timer due within `ms`, letting promises settle in between. */
        async advance(ms = 0) {
            const end = now + ms;
            for (;;) {
                await flushMicrotasks();
                let nextKey = null;
                let next = null;
                timers.forEach((timer, id) => {
                    if (timer.at <= end && (!next || timer.at < next.at)) {
                        next = timer;
                        nextKey = id;
                    }
                });
                if (!next) break;
                timers.delete(nextKey);
                now = next.at;
                next.fn();
            }
            now = end;
            await flushMicrotasks();
        }
    };
}

class FakeEngine {
    constructor(clock) {
        this.clock = clock;
        this.type = 'fake';
        this.isOpen = false;
        this.log = [];
        this.violations = 0;
        this.emit = null;
    }

    open(url, emit) {
        if (this.isOpen) this.violations++;
        this.isOpen = true;
        this.emit = emit;
        this.log.push({ op: 'open', url, at: this.clock.now() });
    }

    close() {
        this.isOpen = false;
        this.log.push({ op: 'close', at: this.clock.now() });
        return Promise.resolve();
    }

    destroy() {
        this.log.push({ op: 'destroy', at: this.clock.now() });
    }

    opens() {
        return this.log.filter((entry) => entry.op === 'open');
    }
}

function setup() {
    const clock = createClock();
    const engine = new FakeEngine(clock);
    const states = [];
    const player = new LiveStreamPlayer({
        createEngine: () => engine,
        onState: (state, detail) => states.push({ state, attempt: detail && detail.attempt }),
        timing: { switchDelay: SWITCH_DELAY },
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        now: clock.now
    });
    return { clock, engine, states, player };
}

const channel = (id) => ({
    uuid: `uuid-${id}`,
    name: `Channel ${id}`,
    streamUrl: `http://dispatcharr/proxy/ts/stream/${id}`
});

test('switching closes the old stream and waits the switch delay before opening the next', async () => {
    const { clock, engine, player } = setup();

    player.play(channel('A'));
    await clock.advance();
    engine.emit({ type: 'progress', data: { time: 1 } });
    await clock.advance(5000);

    player.play(channel('B'));
    await clock.advance(SWITCH_DELAY - 1);
    assert.equal(engine.isOpen, false, 'old stream closed, new one not opened yet');
    await clock.advance(1);

    const [, close] = engine.log;
    const lastOpen = engine.opens().pop();
    assert.equal(close.op, 'close');
    assert.equal(lastOpen.url, channel('B').streamUrl);
    assert.ok(lastOpen.at - close.at >= SWITCH_DELAY);
    assert.equal(engine.violations, 0);
});

test('fast zapping opens only the last requested channel', async () => {
    const { clock, engine, player } = setup();

    player.play(channel('A'));
    await clock.advance();
    player.play(channel('B'));
    player.play(channel('C'));
    await clock.advance(300);
    player.play(channel('D'));
    await clock.advance(5000);

    assert.deepEqual(
        engine.opens().map((entry) => entry.url),
        [channel('A').streamUrl, channel('D').streamUrl]
    );
    assert.equal(engine.violations, 0);
});

test('a channel that does not start is retried with pauses, then stops with an error', async () => {
    const { clock, engine, states, player } = setup();

    player.play(channel('A'));
    for (let i = 0; i < 10; i++) {
        await clock.advance();
        if (engine.isOpen) engine.emit({ type: 'error', data: { message: '503' } });
        await clock.advance(6000);
    }

    // 1 start + 3 automatic retries, each after a full close
    assert.equal(engine.opens().length, 4);
    assert.equal(engine.isOpen, false);
    assert.equal(states[states.length - 1].state, LIVE_STATE.ERROR);
    assert.equal(engine.violations, 0);

    // Nothing reopens on its own after the error
    await clock.advance(120000);
    assert.equal(engine.opens().length, 4);
});

test('a start that never shows a picture times out and is retried', async () => {
    const { clock, engine, states, player } = setup();

    player.play(channel('A'));
    await clock.advance(15000);
    assert.equal(engine.isOpen, false);
    assert.equal(states[states.length - 1].state, LIVE_STATE.CONNECTING);
    assert.equal(states[states.length - 1].attempt, 1);

    await clock.advance(1500);
    assert.equal(engine.opens().length, 2);
});

test('stop during a pending retry never reopens the stream', async () => {
    const { clock, engine, player } = setup();

    player.play(channel('A'));
    await clock.advance();
    engine.emit({ type: 'error', data: { message: '503' } });
    await clock.advance(100);

    await player.stop();
    await clock.advance(60000);

    assert.equal(engine.opens().length, 1);
    assert.equal(engine.isOpen, false);
});

test('destroy closes the open stream and disposes the engine', async () => {
    const { clock, engine, player } = setup();

    player.play(channel('A'));
    await clock.advance();
    await player.destroy();

    assert.equal(engine.isOpen, false);
    assert.equal(engine.log[engine.log.length - 1].op, 'destroy');
    player.play(channel('B'));
    await clock.advance(5000);
    assert.equal(engine.opens().length, 1);
});

test('events of a closed stream are ignored', async () => {
    const { clock, engine, states, player } = setup();

    player.play(channel('A'));
    await clock.advance();
    const emitA = engine.emit;
    player.play(channel('B'));
    await clock.advance(SWITCH_DELAY);
    engine.emit({ type: 'progress', data: { time: 1 } });
    const before = states.length;

    emitA({ type: 'error', data: { message: 'late error from A' } });
    emitA({ type: 'ended' });
    await clock.advance(5000);

    assert.equal(states.length, before);
    assert.equal(states[states.length - 1].state, LIVE_STATE.PLAYING);
    assert.equal(engine.opens().length, 2);
});

test('a stream that drops mid-playback reconnects to the same channel', async () => {
    const { clock, engine, states, player } = setup();

    player.play(channel('A'));
    await clock.advance();
    engine.emit({ type: 'progress', data: { time: 1 } });
    await clock.advance(10000);
    engine.emit({ type: 'progress', data: { time: 11 } });
    engine.emit({ type: 'ended' });
    await clock.advance();

    assert.equal(states[states.length - 1].state, LIVE_STATE.RECONNECTING);
    assert.equal(engine.isOpen, false);
    await clock.advance(2000);
    assert.equal(engine.opens().length, 2);
    assert.equal(engine.opens()[1].url, channel('A').streamUrl);
});

test('a frozen picture is detected and reconnected', async () => {
    const { clock, engine, states, player } = setup();

    player.play(channel('A'));
    await clock.advance();
    engine.emit({ type: 'progress', data: { time: 1 } });
    await clock.advance(16000);

    assert.equal(states[states.length - 1].state, LIVE_STATE.RECONNECTING);
    await clock.advance(2000);
    assert.equal(engine.opens().length, 2);
    assert.equal(engine.violations, 0);
});

test('a failing reconnect uses the reconnect budget, then stops with an error', async () => {
    const { clock, engine, states, player } = setup();

    player.play(channel('A'));
    await clock.advance();
    engine.emit({ type: 'progress', data: { time: 1 } });
    engine.emit({ type: 'ended' });
    for (let i = 0; i < 6; i++) {
        await clock.advance(9000);
        if (engine.isOpen) engine.emit({ type: 'error', data: { message: '503' } });
    }
    await clock.advance(9000);

    // 1 start + 3 reconnects
    assert.equal(engine.opens().length, 4);
    assert.equal(states[states.length - 1].state, LIVE_STATE.ERROR);
    assert.equal(engine.isOpen, false);
});

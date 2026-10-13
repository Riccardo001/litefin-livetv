import assert from 'node:assert/strict';
import test from 'node:test';

import { DtvZapper } from '../src/livetv/DtvZapper.js';

/**
 * ============================================================================
 * Dispatcharr Live TV Zapping Test Suite
 * ============================================================================
 * Verifies the debounced channel switching used by the live player:
 *   1. Rapid Up/Down presses only move the displayed channel.
 *   2. A single switch is committed after the debounce delay.
 *   3. "Last channel" swaps between the two most recent channels.
 *   4. Returning to the playing channel before the delay cancels the switch.
 * ============================================================================
 */

function createFakeTimers() {
    let nextId = 1;
    const timers = new Map();
    return {
        setTimeout: (fn, ms) => {
            const id = nextId++;
            timers.set(id, fn);
            return id;
        },
        clearTimeout: (id) => timers.delete(id),
        flush: () => {
            const pending = Array.from(timers.values());
            timers.clear();
            pending.forEach((fn) => fn());
        },
        get size() {
            return timers.size;
        }
    };
}

function createZapper(overrides = {}) {
    const timers = createFakeTimers();
    const commits = [];
    const zapper = new DtvZapper({
        ids: [1, 2, 3, 4],
        currentId: 2,
        onCommit: (id) => commits.push(id),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        ...overrides
    });
    return { zapper, timers, commits };
}

test('rapid presses move the displayed channel and commit once', () => {
    const { zapper, timers, commits } = createZapper();

    assert.equal(zapper.step(1), 3);
    assert.equal(zapper.step(1), 4);
    assert.equal(zapper.step(1), 1, 'wraps to the first channel');
    assert.equal(zapper.displayedId, 1);
    assert.equal(zapper.currentId, 2, 'nothing switched yet');
    assert.equal(timers.size, 1, 'only one debounce timer is alive');
    assert.deepEqual(commits, []);

    timers.flush();
    assert.deepEqual(commits, [1]);
    assert.equal(zapper.currentId, 1);
    assert.equal(zapper.previousId, 2);
    assert.equal(zapper.isPending, false);
});

test('coming back to the playing channel before the delay does not switch', () => {
    const { zapper, timers, commits } = createZapper();

    zapper.step(1);
    zapper.step(-1);
    timers.flush();
    assert.deepEqual(commits, []);
    assert.equal(zapper.previousId, null);
});

test('last channel swaps between the two most recent channels', () => {
    const { zapper, commits } = createZapper();

    assert.equal(zapper.jumpToPrevious(), null, 'no previous channel yet');
    zapper.jumpTo(4);
    assert.equal(zapper.jumpToPrevious(), 2);
    assert.equal(zapper.jumpToPrevious(), 4);
    assert.deepEqual(commits, [4, 2, 4]);
});

test('jumpTo cancels a pending debounced selection', () => {
    const { zapper, timers, commits } = createZapper();

    zapper.step(1);
    zapper.jumpTo(1);
    timers.flush();
    assert.deepEqual(commits, [1]);
    assert.equal(zapper.previousId, 2);
});

test('restored previous channel is honoured and destroy stops commits', () => {
    const { zapper, timers, commits } = createZapper({ previousId: 3 });

    assert.equal(zapper.jumpToPrevious(), 3);
    zapper.step(1);
    zapper.destroy();
    timers.flush();
    assert.deepEqual(commits, [3]);
});

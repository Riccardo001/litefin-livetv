/**
 * ============================================================================
 * Litefin Tizen - Live Stream Player
 * ============================================================================
 * Drives a live-only engine (LiveAvPlayEngine / LiveVideoEngine) for
 * Dispatcharr channels and guarantees that the TV never holds more than
 * one stream connection:
 *
 *   - Every start, switch, retry and stop runs through one serial queue.
 *   - A stream is opened only after the previous one has been closed AND
 *     `switchDelay` ms have passed since, so Dispatcharr can stop the old
 *     channel and free the provider slot (IPTV accounts are often limited
 *     to one connection; Dispatcharr only frees it when it sees the
 *     disconnect, and a new request waits just ~3 s for a free slot).
 *   - Requests superseded while waiting (fast zapping, Back) never open.
 *
 * Failures are bounded: a channel that does not start is retried a few
 * times with growing pauses (covers "slot still busy"), a stream that drops
 * mid-playback is reconnected to the SAME channel (never auto-advanced),
 * then the player stops and reports ERROR. Nothing retries after that
 * until the user asks.
 *
 * No platform or logger imports, so the logic runs under `node --test`.
 * ============================================================================
 */

/** States reported through `onState`. */
export const LIVE_STATE = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    PLAYING: 'playing',
    BUFFERING: 'buffering',
    RECONNECTING: 'reconnecting',
    ERROR: 'error'
};

/** Default timings (ms). */
export const LIVE_TIMING = {
    /** Pause between closing a stream and opening the next one. */
    switchDelay: 1000,
    /** Max wait for the first picture. */
    startTimeout: 15000,
    /** Playback with no time progress for this long counts as a drop. */
    stallTimeout: 15000,
    stallCheckInterval: 2000,
    /** Max wait for an engine to confirm close() before moving on. */
    closeTimeout: 3000,
    /** Pauses before each automatic retry of a channel that does not start. */
    startRetryDelays: [1500, 3000, 5000],
    /** Pauses before each automatic reconnect after a mid-playback drop. */
    reconnectDelays: [2000, 4000, 8000],
    /** Healthy playback for this long restores the reconnect budget. */
    healthyReset: 60000
};

const NOOP_LOG = { debug() {}, info() {}, warn() {}, error() {} };

export class LiveStreamPlayer {
    /**
     * @param {Object} options
     * @param {function(): Object} options.createEngine - Returns the playback engine (called once, lazily)
     * @param {function(string, Object=): void} options.onState - (state, detail) callback
     * @param {Object} [options.log] - Logger ({debug, info, warn, error})
     * @param {Object} [options.timing] - Overrides for LIVE_TIMING
     * @param {Function} [options.setTimeout] - Timer injection for tests
     * @param {Function} [options.clearTimeout] - Timer injection for tests
     * @param {Function} [options.now] - Clock injection for tests
     */
    constructor(options) {
        this._createEngine = options.createEngine;
        this._onState = options.onState || (() => {});
        this._log = options.log || NOOP_LOG;
        this._timing = Object.assign({}, LIVE_TIMING, options.timing || {});
        this._setTimeout = options.setTimeout || ((fn, ms) => setTimeout(fn, ms));
        this._clearTimeout = options.clearTimeout || ((id) => clearTimeout(id));
        this._now = options.now || (() => Date.now());

        this._engine = null;
        this._isOpen = false;
        this._closedAt = null;
        this._queue = Promise.resolve();
        // Bumped by every request: queued work of an older request is skipped
        this._gen = 0;
        // Bumped by every open/close: engine events of an older stream are ignored
        this._attempt = 0;
        this._wake = null;
        this._watchTimers = [];

        this._channel = null;
        this._state = LIVE_STATE.IDLE;
        this._startFailures = 0;
        this._reconnects = 0;
        // First picture seen for the current attempt / for the current channel
        this._hasPlayed = false;
        this._everPlayed = false;
        this._lastTime = -1;
        this._lastProgressAt = 0;
        this._destroyed = false;
    }

    /** Engine type in use ('avplay', 'html5') or null before the first start. */
    get engineType() {
        return this._engine ? this._engine.type : null;
    }

    /** Channel currently playing or starting. */
    get channel() {
        return this._channel;
    }

    /** True while a stream connection is open. */
    get isOpen() {
        return this._isOpen;
    }

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * Start (or switch to) a channel.
     * @param {Object} channel - Store channel ({uuid, name, streamUrl})
     * @returns {Promise<void>} Resolves when the request has been processed
     */
    play(channel) {
        if (this._destroyed || !channel) return Promise.resolve();
        this._channel = channel;
        this._startFailures = 0;
        this._reconnects = 0;
        this._everPlayed = false;
        return this._request(LIVE_STATE.CONNECTING, 0, 0);
    }

    /**
     * Retry the current channel after an error (user-initiated).
     * @returns {Promise<void>}
     */
    retry() {
        return this._channel ? this.play(this._channel) : Promise.resolve();
    }

    /**
     * Stop playback and release the connection.
     * @returns {Promise<void>} Resolves once the stream is closed
     */
    stop() {
        this._bump();
        this._clearWatch();
        this._setState(LIVE_STATE.IDLE);
        return this._enqueue(() => this._closeEngine());
    }

    /**
     * Stop and dispose the engine. The instance cannot be reused.
     * @returns {Promise<void>}
     */
    destroy() {
        if (this._destroyed) return this._queue;
        this._destroyed = true;
        return this.stop().then(() => {
            if (this._engine) {
                try {
                    this._engine.destroy();
                } catch (e) {
                    this._log.warn('Engine destroy failed:', e && e.message);
                }
                this._engine = null;
            }
        });
    }

    // ========================================================================
    // Serial Queue
    // ========================================================================

    /**
     * Close whatever is open, wait for the slot to be released, then open
     * the current channel - unless a newer request arrived meanwhile.
     */
    _request(state, minDelay, attemptNumber) {
        const gen = this._bump();
        this._clearWatch();
        this._hasPlayed = false;
        this._setState(state, { channel: this._channel, attempt: attemptNumber });

        return this._enqueue(async () => {
            await this._closeEngine();
            if (gen !== this._gen) return;

            const sinceClose = this._closedAt !== null ? this._now() - this._closedAt : Infinity;
            const wait = Math.max(minDelay, this._timing.switchDelay - sinceClose);
            if (wait > 0) {
                this._log.debug(`Waiting ${wait} ms before opening ${this._channel.name}`);
                await this._sleep(wait);
                if (gen !== this._gen) return;
            }
            this._open();
        });
    }

    _enqueue(task) {
        const run = this._queue.then(task).catch((err) => {
            this._log.error('Live player step failed:', err && err.message ? err.message : err);
        });
        this._queue = run;
        return run;
    }

    /** Invalidate queued work, silence the open stream and cut short a pending wait. */
    _bump() {
        this._gen++;
        this._attempt++;
        if (this._wake) this._wake();
        return this._gen;
    }

    _sleep(ms) {
        return new Promise((resolve) => {
            let id = null;
            const done = () => {
                if (id !== null) this._clearTimeout(id);
                if (this._wake === done) this._wake = null;
                resolve();
            };
            this._wake = done;
            id = this._setTimeout(done, ms);
        });
    }

    // ========================================================================
    // Engine Lifecycle
    // ========================================================================

    _open() {
        if (!this._engine) this._engine = this._createEngine();
        const channel = this._channel;
        const attempt = ++this._attempt;
        this._isOpen = true;
        this._lastTime = -1;
        this._log.info(`Opening ${channel.name} via ${this._engine.type}: ${channel.streamUrl}`);

        try {
            this._engine.open(channel.streamUrl, (event) => this._onEngineEvent(attempt, event));
        } catch (err) {
            this._onFailure(attempt, 'open', (err && (err.message || err.name)) || 'open failed');
            return;
        }
        this._watch(
            () => this._onFailure(attempt, 'timeout', `no picture after ${this._timing.startTimeout} ms`),
            this._timing.startTimeout
        );
    }

    async _closeEngine() {
        if (!this._engine || !this._isOpen) return;
        this._isOpen = false;
        this._attempt++;
        const startedAt = this._now();
        let timer = null;
        try {
            await Promise.race([
                this._engine.close(),
                new Promise((resolve) => {
                    timer = this._setTimeout(() => {
                        this._log.warn(`Engine close not confirmed after ${this._timing.closeTimeout} ms`);
                        resolve();
                    }, this._timing.closeTimeout);
                })
            ]);
        } catch (err) {
            this._log.warn('Engine close failed:', err && err.message);
        }
        if (timer !== null) this._clearTimeout(timer);
        this._closedAt = this._now();
        this._log.info(`Stream closed (${this._closedAt - startedAt} ms)`);
    }

    // ========================================================================
    // Engine Events
    // ========================================================================

    _onEngineEvent(attempt, event) {
        if (attempt !== this._attempt || !this._isOpen || !event) return;

        switch (event.type) {
            case 'playing':
                this._markProgress();
                if (!this._hasPlayed) this._onFirstFrame(attempt);
                else if (this._state === LIVE_STATE.BUFFERING)
                    this._setState(LIVE_STATE.PLAYING, { channel: this._channel });
                break;
            case 'progress': {
                const time = event.data && typeof event.data.time === 'number' ? event.data.time : null;
                if (time === null || time === this._lastTime) break;
                this._lastTime = time;
                this._markProgress();
                if (!this._hasPlayed) this._onFirstFrame(attempt);
                else if (this._state === LIVE_STATE.BUFFERING)
                    this._setState(LIVE_STATE.PLAYING, { channel: this._channel });
                break;
            }
            case 'waiting':
                if (this._hasPlayed) this._setState(LIVE_STATE.BUFFERING, { channel: this._channel });
                break;
            case 'ended':
                // A live stream never ends on purpose: the connection dropped
                this._onFailure(attempt, 'ended', 'stream ended');
                break;
            case 'error':
                this._onFailure(attempt, 'error', (event.data && event.data.message) || 'playback error');
                break;
            default:
                break;
        }
    }

    _onFirstFrame(attempt) {
        this._hasPlayed = true;
        this._everPlayed = true;
        this._startFailures = 0;
        this._clearWatch();
        this._setState(LIVE_STATE.PLAYING, { channel: this._channel });
        this._log.info(`Playing ${this._channel.name}`);

        const check = () => {
            if (attempt !== this._attempt) return;
            if (this._now() - this._lastProgressAt > this._timing.stallTimeout) {
                this._onFailure(attempt, 'stall', `no progress for ${this._timing.stallTimeout} ms`);
                return;
            }
            this._watch(check, this._timing.stallCheckInterval);
        };
        this._watch(check, this._timing.stallCheckInterval);
        this._watch(() => {
            if (attempt === this._attempt) this._reconnects = 0;
        }, this._timing.healthyReset);
    }

    _markProgress() {
        this._lastProgressAt = this._now();
    }

    // ========================================================================
    // Failure Handling
    // ========================================================================

    /**
     * Single entry point for every failure signal. Engines can report one
     * failure several times (error event + rejected play + watchdog); the
     * first one retires the attempt (_bump) and the duplicates are ignored.
     * A channel that never showed a picture uses the start budget; once it
     * has played, failures (including a reconnect that does not start) use
     * the reconnect budget.
     */
    _onFailure(attempt, reason, message) {
        if (attempt !== this._attempt || !this._isOpen || this._destroyed) return;
        const name = this._channel ? this._channel.name : '?';
        this._log.warn(`${name}: ${reason} (${message})`);

        if (!this._everPlayed) {
            const delays = this._timing.startRetryDelays;
            if (this._startFailures < delays.length) {
                const delay = delays[this._startFailures++];
                this._request(LIVE_STATE.CONNECTING, delay, this._startFailures);
                return;
            }
        } else {
            const delays = this._timing.reconnectDelays;
            if (this._reconnects < delays.length) {
                const delay = delays[this._reconnects++];
                this._request(LIVE_STATE.RECONNECTING, delay, this._reconnects);
                return;
            }
        }

        // Out of retries: release the connection and wait for the user
        this._bump();
        this._clearWatch();
        this._enqueue(() => this._closeEngine());
        this._setState(LIVE_STATE.ERROR, { channel: this._channel, reason, message });
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    _setState(state, detail) {
        this._state = state;
        try {
            this._onState(state, detail || {});
        } catch (e) {
            this._log.error('onState handler failed:', e);
        }
    }

    _watch(fn, ms) {
        const id = this._setTimeout(() => {
            const index = this._watchTimers.indexOf(id);
            if (index !== -1) this._watchTimers.splice(index, 1);
            fn();
        }, ms);
        this._watchTimers.push(id);
    }

    _clearWatch() {
        this._watchTimers.forEach((id) => this._clearTimeout(id));
        this._watchTimers = [];
    }
}

export default LiveStreamPlayer;

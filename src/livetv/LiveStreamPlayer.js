/**
 * ============================================================================
 * Litefin Tizen - Live Stream Player
 * ============================================================================
 * Thin wrapper that drives Litefin's existing playback engines directly for
 * Dispatcharr live channels (plain progressive MPEG-TS / fMP4 URLs):
 *   - Tizen  → TizenAVPlayer (AVPlay demuxes raw HTTP TS natively)
 *   - webOS  → WebOSPlayer   (native media pipeline)
 *   - others → HtmlVideoPlayer (desktop browser, used with fMP4 output)
 *
 * JellyfinPlayer is deliberately bypassed: its recovery paths re-request
 * Jellyfin PlaybackInfo, which does not exist for these streams.
 *
 * Responsibilities handled here because the engines do not:
 *  - Session tokens, so late events from a previous channel are ignored.
 *  - Always stopping the previous stream before opening the next one
 *    (Dispatcharr may only have one provider slot free).
 *  - A startup watchdog (webOS/HTML5 engines have none).
 *  - Retries: a 503 "slot busy / channel stopping" during fast zapping
 *    surfaces as a startup error; a stream that drops mid-playback is
 *    reconnected to the SAME channel (never auto-advanced).
 * ============================================================================
 */

import { logger } from '../utils/Logger.js';
import { platformInfo } from '../utils/PlatformInfo.js';
import { PlayerSettings } from '../utils/PlayerSettings.js';
import { TizenAVPlayer } from '../player/core/TizenAVPlayer.js';
import { WebOSPlayer } from '../player/core/WebOSPlayer.js';
import { HtmlVideoPlayer } from '../player/core/HtmlVideoPlayer.js';

const log = logger.create('LiveStreamPlayer');

/** Max wait for the first frame before declaring the start failed. */
const START_TIMEOUT = 15000;
/** Startup failures retried automatically (covers 503 while a slot frees up). */
const START_RETRIES = 2;
const START_RETRY_DELAY = 1000;
/** Mid-stream drops reconnected automatically (backoff doubles each time). */
const RECONNECT_RETRIES = 3;
const RECONNECT_BASE_DELAY = 1000;
/** Playback with no time progress for this long is treated as a drop. */
const STALL_TIMEOUT = 12000;
/** Healthy playback for this long resets the reconnect budget. */
const HEALTHY_RESET = 60000;

/** States reported through `onState`. */
export const LIVE_STATE = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    PLAYING: 'playing',
    BUFFERING: 'buffering',
    RECONNECTING: 'reconnecting',
    ERROR: 'error'
};

export class LiveStreamPlayer {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - Full-screen element hosting the video
     * @param {function(string, Object=): void} options.onState - (state, detail) callback
     */
    constructor(options) {
        this._container = options.container;
        this._onState = options.onState || (() => {});
        this._backend = null;
        this._backendType = null;
        this._session = 0;
        this._channel = null;
        this._state = LIVE_STATE.IDLE;
        this._timers = [];
        this._startAttempts = 0;
        this._reconnects = 0;
        this._hasPlayed = false;
        this._lastProgressAt = 0;
        this._lastTime = -1;
        this._destroyed = false;
    }

    /** Backend type in use ('tizen', 'webos', 'html5') or null. */
    get backendType() {
        return this._backendType;
    }

    /** Channel currently playing or starting. */
    get channel() {
        return this._channel;
    }

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * Start (or switch to) a channel.
     * @param {Object} channel - Store channel ({uuid, name, streamUrl})
     * @returns {Promise<void>}
     */
    async play(channel) {
        if (this._destroyed || !channel) return;
        this._channel = channel;
        this._startAttempts = 0;
        this._reconnects = 0;
        await this._start(LIVE_STATE.CONNECTING);
    }

    /**
     * Retry the current channel after an error (user-initiated).
     * @returns {Promise<void>}
     */
    retry() {
        if (!this._channel) return Promise.resolve();
        return this.play(this._channel);
    }

    /**
     * Stop playback and release the decoder/network connection.
     * @returns {Promise<void>}
     */
    async stop() {
        this._session++;
        this._clearTimers();
        await this._stopBackend();
        this._setState(LIVE_STATE.IDLE);
    }

    /**
     * Stop and dispose the engine. The instance cannot be reused.
     * @returns {Promise<void>}
     */
    async destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        await this.stop();
        if (this._backend) {
            try {
                // TizenAVPlayer.destroy() does not clear its own timers: always stop() first
                this._backend.destroy();
            } catch (e) {
                log.warn('Backend destroy failed:', e && e.message);
            }
            this._backend = null;
        }
    }

    // ========================================================================
    // Session Lifecycle
    // ========================================================================

    async _start(state) {
        const session = ++this._session;
        this._clearTimers();
        this._hasPlayed = false;
        this._lastTime = -1;
        this._setState(state, { channel: this._channel, attempt: this._startAttempts });

        // Release the previous stream first: Dispatcharr may have a single
        // provider slot, and AVPlay is a process-wide singleton.
        await this._stopBackend();
        if (session !== this._session || this._destroyed) return;

        this._ensureBackend(session);
        this._addTimer(() => this._handleFailure(session, 'timeout', 'Start timeout'), START_TIMEOUT);

        const channel = this._channel;
        log.info(`Starting ${channel.name} via ${this._backendType}: ${channel.streamUrl}`);

        try {
            await this._backend.play({
                url: channel.streamUrl,
                isHls: false,
                playMethod: 'DirectPlay',
                autoPlay: true,
                item: { Id: channel.uuid, Name: channel.name, Type: 'TvChannel' },
                /* A video stream entry enables TizenAVPlayer's buffering tuning
                 * (initial/resume buffer + buffering timeout). Audio/subtitle
                 * indices are omitted on purpose: a -1 subtitle index makes
                 * AVPlay wait 2 s for track info before starting. */
                mediaSource: { Id: channel.uuid, MediaStreams: [{ Type: 'Video' }] }
            });
        } catch (err) {
            if (session === this._session) {
                this._handleFailure(session, 'error', (err && err.message) || 'Playback failed');
            }
        }
    }

    _ensureBackend(session) {
        if (this._backend) {
            // Rebind events to the new session (engines keep one callback)
            this._backend.onEvent = (event) => this._onBackendEvent(session, event);
            return;
        }

        const options = {
            container: this._container,
            settings: PlayerSettings,
            onEvent: (event) => this._onBackendEvent(session, event)
        };
        const preferred = PlayerSettings.get('playerBackend');
        const hasAvPlay = !!((window.webapis && window.webapis.avplay) || (window.tizen && window.tizen.avplay));

        // Respect an explicit "HTML5" engine choice made in the player settings
        if (platformInfo.isTizen && hasAvPlay && preferred !== 'html5') {
            this._backendType = 'tizen';
            this._backend = new TizenAVPlayer(options);
        } else if (platformInfo.isWebOS && preferred !== 'html5') {
            this._backendType = 'webos';
            this._backend = new WebOSPlayer(options);
        } else {
            this._backendType = 'html5';
            this._backend = new HtmlVideoPlayer(options);
        }
        log.info(`Engine: ${this._backendType}`);
    }

    async _stopBackend() {
        if (!this._backend) return;
        // Detach first so the engine's own stop/error events are ignored
        this._backend.onEvent = () => {};
        try {
            await this._backend.stop();
        } catch (e) {
            log.debug('Backend stop failed:', e && e.message);
        }
    }

    // ========================================================================
    // Engine Events
    // ========================================================================

    _onBackendEvent(session, event) {
        if (session !== this._session || !event) return;

        switch (event.type) {
            case 'playing':
            case 'playbackstart':
                this._markProgress();
                if (!this._hasPlayed && event.type === 'playing') {
                    this._onFirstFrame(session);
                } else if (this._hasPlayed && this._state === LIVE_STATE.BUFFERING) {
                    this._setState(LIVE_STATE.PLAYING, { channel: this._channel });
                }
                break;
            case 'timeupdate': {
                const time = event.data && typeof event.data.time === 'number' ? event.data.time : null;
                if (time !== null && time !== this._lastTime) {
                    this._lastTime = time;
                    this._markProgress();
                    if (!this._hasPlayed) {
                        // AVPlay reports the first rendered frame through time updates
                        this._onFirstFrame(session);
                    } else if (this._state === LIVE_STATE.BUFFERING) {
                        this._setState(LIVE_STATE.PLAYING, { channel: this._channel });
                    }
                }
                break;
            }
            case 'waiting':
                if (this._hasPlayed) this._setState(LIVE_STATE.BUFFERING, { channel: this._channel });
                break;
            case 'ended':
                // A live stream never ends on purpose: the connection dropped
                this._handleFailure(session, 'ended', 'Stream ended');
                break;
            case 'error':
                this._handleFailure(session, 'error', (event.data && event.data.message) || 'Playback error');
                break;
            default:
                break;
        }
    }

    _onFirstFrame(session) {
        this._hasPlayed = true;
        this._startAttempts = 0;
        this._clearTimers();
        this._setState(LIVE_STATE.PLAYING, { channel: this._channel });
        this._watchStalls(session);
        this._addTimer(() => {
            if (session === this._session) this._reconnects = 0;
        }, HEALTHY_RESET);
    }

    _markProgress() {
        this._lastProgressAt = Date.now();
    }

    _watchStalls(session) {
        const check = () => {
            if (session !== this._session) return;
            if (Date.now() - this._lastProgressAt > STALL_TIMEOUT) {
                this._handleFailure(session, 'stall', 'No progress');
                return;
            }
            this._addTimer(check, 2000);
        };
        this._addTimer(check, 2000);
    }

    // ========================================================================
    // Failure Handling
    // ========================================================================

    /**
     * Single entry point for every failure signal. Engines can report one
     * failure several times (event + rejected promise + their own timers);
     * bumping the session on the first signal drops the duplicates.
     */
    _handleFailure(session, reason, message) {
        if (session !== this._session || this._destroyed) return;
        this._session++;
        this._clearTimers();
        log.warn(`${this._channel ? this._channel.name : '?'}: ${reason} (${message})`);

        if (!this._hasPlayed) {
            if (this._startAttempts < START_RETRIES) {
                this._startAttempts++;
                this._scheduleRestart(START_RETRY_DELAY, LIVE_STATE.CONNECTING);
                return;
            }
            this._fail(reason, message);
            return;
        }

        if (this._reconnects < RECONNECT_RETRIES) {
            const delay = RECONNECT_BASE_DELAY * Math.pow(2, this._reconnects);
            this._reconnects++;
            this._scheduleRestart(delay, LIVE_STATE.RECONNECTING);
            return;
        }
        this._fail(reason, message);
    }

    _scheduleRestart(delay, state) {
        const session = this._session;
        this._setState(state, { channel: this._channel, attempt: this._startAttempts || this._reconnects });
        this._stopBackend();
        this._addTimer(() => {
            if (session === this._session) this._start(state);
        }, delay);
    }

    _fail(reason, message) {
        this._stopBackend();
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
            log.error('onState handler failed:', e);
        }
    }

    _addTimer(fn, ms) {
        this._timers.push(setTimeout(fn, ms));
    }

    _clearTimers() {
        this._timers.forEach((id) => clearTimeout(id));
        this._timers = [];
    }
}

export default LiveStreamPlayer;

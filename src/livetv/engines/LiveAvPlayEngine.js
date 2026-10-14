/**
 * ============================================================================
 * Litefin Tizen - Live AVPlay Engine (Samsung Tizen)
 * ============================================================================
 * Minimal live-only playback engine on Samsung AVPlay, which demuxes the raw
 * MPEG-TS from Dispatcharr in hardware.
 *
 *   open():  open → setListener → display rect → buffering → prepareAsync → play
 *   close(): stop (only in the states where AVPlay allows it) → close, which
 *            drops the HTTP connection to Dispatcharr
 *
 * AVPlay is a process-wide singleton and its callbacks can still arrive after
 * close(); every open() gets a token and callbacks of an older token are
 * dropped. There are no seeks, track switches or suspend/restore calls: the
 * VOD player's extra AVPlay calls in the wrong state are what wedge it.
 * ============================================================================
 */

/** Seconds of stream AVPlay buffers before starting / after a rebuffer. */
const BUFFER_FOR_PLAY_SEC = 3;
const BUFFER_FOR_RESUME_SEC = 5;
/** Seconds AVPlay waits for buffering before reporting it. */
const BUFFERING_TIMEOUT_SEC = 10;

/** AVPlay states in which stop() is a valid call. */
const STOPPABLE_STATES = ['READY', 'PLAYING', 'PAUSED'];

function describeError(error) {
    if (!error) return 'Unknown AVPlay error';
    if (typeof error === 'string') return error;
    return error.name || error.message || String(error);
}

export class LiveAvPlayEngine {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - Element the video plane is aligned to
     * @param {Object} options.avplay - webapis.avplay
     * @param {Object} [options.log] - Logger ({debug, warn})
     */
    constructor(options) {
        this._container = options.container;
        this._av = options.avplay;
        this._log = options.log || { debug() {}, warn() {} };
        this._token = 0;
        this._opened = false;
    }

    /** Engine name for logs. */
    get type() {
        return 'avplay';
    }

    /**
     * Start a stream. Throws when AVPlay refuses to open it.
     * @param {string} url - Stream URL
     * @param {function(Object): void} emit - Receives {type, data} events of THIS stream only
     */
    open(url, emit) {
        const av = this._av;
        // Another player (or a crashed session) may have left AVPlay open
        this._release();

        const token = ++this._token;
        const send = (type, data) => {
            if (token === this._token) emit({ type, data });
        };

        av.open(url);
        this._opened = true;
        av.setListener({
            onbufferingstart: () => send('waiting'),
            onbufferingprogress: () => {},
            onbufferingcomplete: () => {},
            oncurrentplaytime: (ms) => send('progress', { time: ms / 1000 }),
            onstreamcompleted: () => send('ended'),
            onerror: (type) => send('error', { message: describeError(type) }),
            onevent: () => {},
            onsubtitlechange: () => {},
            ondrmevent: () => {}
        });
        this._applyDisplay();

        try {
            av.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', BUFFER_FOR_PLAY_SEC);
            av.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', BUFFER_FOR_RESUME_SEC);
        } catch (e) {
            this._log.debug('setBufferingParam not supported:', describeError(e));
        }
        try {
            av.setTimeoutForBuffering(BUFFERING_TIMEOUT_SEC);
        } catch (e) {
            this._log.debug('setTimeoutForBuffering not supported:', describeError(e));
        }

        av.prepareAsync(
            () => {
                if (token !== this._token) return;
                // Some firmware resets the display rect during prepare
                this._applyDisplay();
                try {
                    av.play();
                } catch (e) {
                    send('error', { message: `play(): ${describeError(e)}` });
                }
            },
            (error) => send('error', { message: `prepare: ${describeError(error)}` })
        );
    }

    /**
     * Stop the stream and close AVPlay (drops the HTTP connection).
     * @returns {Promise<void>}
     */
    close() {
        this._token++;
        this._release();
        return new Promise((resolve) => setTimeout(resolve, 0));
    }

    /** Release everything; the engine must not be used afterwards. */
    destroy() {
        this._token++;
        this._release();
    }

    /**
     * stop() is only valid once prepared; while prepareAsync is still
     * running (IDLE) close() alone aborts the connection.
     */
    _release() {
        const av = this._av;
        let state = 'NONE';
        try {
            state = av.getState();
        } catch (e) {}
        if (state === 'NONE' && !this._opened) return;
        this._opened = false;

        if (STOPPABLE_STATES.indexOf(state) !== -1) {
            try {
                av.stop();
            } catch (e) {
                this._log.warn('AVPlay stop failed:', describeError(e));
            }
        }
        if (state !== 'NONE') {
            try {
                av.close();
            } catch (e) {
                this._log.warn('AVPlay close failed:', describeError(e));
            }
        }
    }

    /** Align the hardware video plane with the container, letterboxed. */
    _applyDisplay() {
        const rect = this._container.getBoundingClientRect();
        const width = Math.round(rect.width || window.innerWidth || 1920);
        const height = Math.round(rect.height || window.innerHeight || 1080);
        try {
            this._av.setDisplayRect(Math.round(rect.left || 0), Math.round(rect.top || 0), width, height);
            this._av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
        } catch (e) {
            this._log.warn('AVPlay display setup failed:', describeError(e));
        }
    }
}

export default LiveAvPlayEngine;

/**
 * ============================================================================
 * Litefin Tizen - Live Video Engine (HTML5 <video>)
 * ============================================================================
 * Minimal live-only playback engine on a <video> element. Used on webOS
 * (native media pipeline, raw MPEG-TS) and in desktop browsers (fMP4).
 *
 * Every open() creates a brand new <video> element and close() tears it
 * down completely: pause, drop the source, load() (aborts the HTTP request
 * and releases the decoder) and remove it from the DOM. The VOD player keeps
 * one element alive across items, which lets webOS hold on to the previous
 * pipeline and its connection to Dispatcharr - with a single-connection
 * IPTV account the next channel then fails.
 *
 * Deliberately absent: seeking, track selection, resume positions and the
 * VOD player's stall "kick" (currentTime += 0.5). A live TS stream cannot
 * seek; on webOS the kick opens a new connection or wedges the pipeline.
 * ============================================================================
 */

import { MediaHelper } from '../../player/core/MediaHelper.js';

const MEDIA_ERRORS = {
    1: 'MEDIA_ERR_ABORTED',
    2: 'MEDIA_ERR_NETWORK',
    3: 'MEDIA_ERR_DECODE',
    4: 'MEDIA_ERR_SRC_NOT_SUPPORTED'
};

const VIDEO_EVENTS = ['playing', 'timeupdate', 'waiting', 'ended', 'error', 'loadedmetadata', 'resize'];

function describeError(error) {
    if (!error) return 'Unknown media error';
    const name = MEDIA_ERRORS[error.code] || `MEDIA_ERR_${error.code}`;
    return error.message ? `${name}: ${error.message}` : name;
}

export class LiveVideoEngine {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - Element hosting the video
     */
    constructor(options) {
        this._container = options.container;
        this._container.classList.add('dtv-video-host');
        this._video = null;
        this._handler = null;
    }

    /** Engine name for logs. */
    get type() {
        return 'html5';
    }

    /**
     * Start a stream on a fresh <video> element.
     * @param {string} url - Stream URL
     * @param {function(Object): void} emit - Receives {type, data} events of THIS stream only
     */
    open(url, emit) {
        this._teardown();

        const video = document.createElement('video');
        video.className = 'dtv-video';
        video.setAttribute('playsinline', 'true');
        video.setAttribute('webkit-playsinline', 'true');
        video.preload = 'auto';
        video.autoplay = true;
        const volume = MediaHelper.getSavedVolume();
        video.volume = volume >= 0 && volume <= 1 ? volume : 1;

        // Events of an element that was already torn down are dropped
        const handler = (e) => {
            if (this._video !== video) return;
            switch (e.type) {
                case 'playing':
                    emit({ type: 'playing' });
                    break;
                case 'timeupdate':
                    emit({ type: 'progress', data: { time: video.currentTime } });
                    break;
                case 'waiting':
                    emit({ type: 'waiting' });
                    break;
                case 'ended':
                    emit({ type: 'ended' });
                    break;
                case 'error':
                    emit({ type: 'error', data: { message: describeError(video.error) } });
                    break;
                default:
                    // loadedmetadata / resize: intrinsic size known or changed
                    this._fit();
                    break;
            }
        };
        VIDEO_EVENTS.forEach((name) => video.addEventListener(name, handler));
        this._video = video;
        this._handler = handler;

        this._container.appendChild(video);
        this._fit();
        video.src = url;

        const playing = video.play();
        if (playing && typeof playing.catch === 'function') {
            playing.catch((err) => {
                // AbortError = close() interrupted the load, not a stream failure
                if (this._video === video && err && err.name !== 'AbortError') {
                    emit({ type: 'error', data: { message: `play(): ${err.name || ''} ${err.message || ''}`.trim() } });
                }
            });
        }
    }

    /**
     * Stop the stream and release the element, decoder and connection.
     * @returns {Promise<void>}
     */
    close() {
        this._teardown();
        // Give the media pipeline one task to process the unload
        return new Promise((resolve) => setTimeout(resolve, 0));
    }

    /** Release everything; the engine must not be used afterwards. */
    destroy() {
        this._teardown();
        this._container.classList.remove('dtv-video-host');
    }

    _teardown() {
        const video = this._video;
        if (!video) return;
        this._video = null;
        VIDEO_EVENTS.forEach((name) => video.removeEventListener(name, this._handler));
        this._handler = null;
        try {
            video.pause();
        } catch (e) {}
        try {
            video.removeAttribute('src');
            video.load();
        } catch (e) {}
        if (video.parentNode) video.parentNode.removeChild(video);
    }

    /**
     * Size the element box to the picture (letterbox / pillarbox). The webOS
     * hardware video plane follows the element box and ignores object-fit,
     * so a 4:3 channel in a 16:9 box would be stretched.
     */
    _fit() {
        const video = this._video;
        if (!video) return;
        const cw = this._container.clientWidth || window.innerWidth || 1920;
        const ch = this._container.clientHeight || window.innerHeight || 1080;
        let w = cw;
        let h = ch;
        if (video.videoWidth && video.videoHeight) {
            const scale = Math.min(cw / video.videoWidth, ch / video.videoHeight);
            w = Math.round(video.videoWidth * scale);
            h = Math.round(video.videoHeight * scale);
        }
        const style = video.style;
        style.left = `${Math.round((cw - w) / 2)}px`;
        style.top = `${Math.round((ch - h) / 2)}px`;
        style.width = `${w}px`;
        style.height = `${h}px`;
    }
}

export default LiveVideoEngine;

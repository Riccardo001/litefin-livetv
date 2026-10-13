/**
 * ============================================================================
 * Litefin Tizen - Channel Logo Cache
 * ============================================================================
 * Dispatcharr serves logos at their original size (often large PNGs or
 * SVGs). Decoding dozens of those while scrolling a channel list is costly on
 * 2020 TV SoCs, so every logo is downscaled ONCE into a small PNG and kept:
 *  - in memory as an object URL (bounded LRU), and
 *  - in IndexedDB for later sessions (7-day expiry).
 *
 * Network loads are throttled (TVs allow only a few connections per host).
 * If a logo cannot be read back through a canvas (no CORS headers), the
 * original URL is used as-is; if it cannot load at all, the caller's
 * fallback (channel initials) stays visible.
 * ============================================================================
 */

import { logger } from '../utils/Logger.js';

const log = logger.create('LogoCache');

// Target box of the downscaled logo (2x the on-screen size for sharpness)
const LOGO_MAX_WIDTH = 240;
const LOGO_MAX_HEIGHT = 135;

const MAX_CONCURRENT = 4;
const MEMORY_LIMIT = 400;
const DB_NAME = 'litefin-dtv';
const DB_STORE = 'logos';
const DB_TTL = 7 * 24 * 60 * 60 * 1000;

class LogoCache {
    constructor() {
        /** url -> {src: string|null, objectUrl: boolean} */
        this._memory = new Map();
        /** url -> Promise */
        this._pending = new Map();
        this._queue = [];
        this._active = 0;
        this._dbPromise = null;
    }

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * Show `url` in `img` once ready. The <img> gets the `loaded` class on
     * success and `failed` when no image could be loaded, so CSS can reveal
     * the initials fallback. Safe with recycled (virtualized) elements.
     * @param {HTMLImageElement} img
     * @param {string} url - Logo URL ('' when the channel has no logo)
     */
    apply(img, url) {
        if (!img) return;
        img._dtvLogoUrl = url;
        img.classList.remove('loaded', 'failed');

        if (!url) {
            img.removeAttribute('src');
            img.classList.add('failed');
            return;
        }

        const cached = this._memory.get(url);
        if (cached) {
            this._show(img, cached);
            return;
        }

        img.removeAttribute('src');
        this.load(url).then((entry) => {
            if (img._dtvLogoUrl === url) this._show(img, entry);
        });
    }

    /**
     * Resolve a logo entry for `url` (memory → IndexedDB → network).
     * @param {string} url
     * @returns {Promise<{src: string|null}>}
     */
    load(url) {
        const cached = this._memory.get(url);
        if (cached) return Promise.resolve(cached);
        const pending = this._pending.get(url);
        if (pending) return pending;

        const promise = this._readDb(url)
            .then((blob) => {
                if (blob) return { src: URL.createObjectURL(blob), objectUrl: true };
                return this._enqueue(() => this._fetchAndResize(url));
            })
            .catch((err) => {
                log.debug('Logo load failed:', url, err && err.message);
                return { src: null };
            })
            .then((entry) => {
                this._pending.delete(url);
                this._remember(url, entry);
                return entry;
            });

        this._pending.set(url, promise);
        return promise;
    }

    // ========================================================================
    // Network + Resize
    // ========================================================================

    _enqueue(task) {
        return new Promise((resolve) => {
            this._queue.push({ task, resolve });
            this._drain();
        });
    }

    _drain() {
        while (this._active < MAX_CONCURRENT && this._queue.length) {
            const { task, resolve } = this._queue.shift();
            this._active++;
            task()
                .catch(() => ({ src: null }))
                .then((entry) => {
                    this._active--;
                    resolve(entry);
                    this._drain();
                });
        }
    }

    _fetchAndResize(url) {
        return this._loadImage(url, true)
            .then((image) => {
                const blobPromise = this._resize(image);
                return blobPromise.then((blob) => {
                    if (!blob) return { src: url, objectUrl: false };
                    this._writeDb(url, blob);
                    return { src: URL.createObjectURL(blob), objectUrl: true };
                });
            })
            .catch(() =>
                // No CORS headers: show the original image without resizing
                this._loadImage(url, false).then(
                    () => ({ src: url, objectUrl: false }),
                    () => ({ src: null })
                )
            );
    }

    _loadImage(url, anonymous) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            if (anonymous) image.crossOrigin = 'anonymous';
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error('Image load failed'));
            image.src = url;
        });
    }

    /**
     * Draw the image into a canvas no larger than the target box.
     * @returns {Promise<Blob|null>} null when the canvas cannot be exported
     */
    _resize(image) {
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        if (!width || !height) return Promise.resolve(null);

        const scale = Math.min(1, LOGO_MAX_WIDTH / width, LOGO_MAX_HEIGHT / height);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));

        return new Promise((resolve) => {
            try {
                const ctx = canvas.getContext('2d');
                ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
                canvas.toBlob((blob) => resolve(blob || null), 'image/png');
            } catch (e) {
                // Tainted canvas (SecurityError) or missing toBlob
                resolve(null);
            }
        });
    }

    // ========================================================================
    // Memory LRU
    // ========================================================================

    _remember(url, entry) {
        this._memory.delete(url);
        this._memory.set(url, entry);
        while (this._memory.size > MEMORY_LIMIT) {
            const oldestUrl = this._memory.keys().next().value;
            const oldest = this._memory.get(oldestUrl);
            this._memory.delete(oldestUrl);
            if (oldest && oldest.objectUrl && oldest.src) {
                try {
                    URL.revokeObjectURL(oldest.src);
                } catch (e) {}
            }
        }
    }

    _show(img, entry) {
        if (entry && entry.src) {
            img.onload = () => img.classList.add('loaded');
            img.onerror = () => img.classList.add('failed');
            img.src = entry.src;
        } else {
            img.classList.add('failed');
        }
    }

    // ========================================================================
    // IndexedDB Persistence
    // ========================================================================

    _openDb() {
        if (this._dbPromise) return this._dbPromise;
        this._dbPromise = new Promise((resolve) => {
            try {
                if (typeof indexedDB === 'undefined') {
                    resolve(null);
                    return;
                }
                const request = indexedDB.open(DB_NAME, 1);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => resolve(null);
                request.onblocked = () => resolve(null);
            } catch (e) {
                resolve(null);
            }
        });
        return this._dbPromise;
    }

    _readDb(url) {
        return this._openDb().then(
            (db) =>
                new Promise((resolve) => {
                    if (!db) {
                        resolve(null);
                        return;
                    }
                    try {
                        const request = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(url);
                        request.onsuccess = () => {
                            const row = request.result;
                            resolve(row && row.blob && Date.now() - row.savedAt < DB_TTL ? row.blob : null);
                        };
                        request.onerror = () => resolve(null);
                    } catch (e) {
                        resolve(null);
                    }
                })
        );
    }

    _writeDb(url, blob) {
        this._openDb().then((db) => {
            if (!db) return;
            try {
                db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put({ blob, savedAt: Date.now() }, url);
            } catch (e) {
                log.debug('Logo cache write skipped:', e && e.message);
            }
        });
    }
}

export const logoCache = new LogoCache();
export default logoCache;

/**
 * ============================================================================
 * Litefin Tizen - Dispatcharr Live TV Zapping Logic
 * ============================================================================
 * Keeps track of the playing channel, the channel currently shown in the
 * overlay while the user is still pressing Up/Down, and the previously
 * watched channel ("last channel" key).
 *
 * Rapid presses only move the pending selection; the stream switch is
 * committed once the user stops pressing for `delay` ms. This avoids opening
 * and closing a provider connection for every intermediate channel.
 *
 * Timers are injectable so the logic can be unit tested without a DOM.
 * ============================================================================
 */

import { stepChannel } from './DtvModel.js';

export const ZAP_COMMIT_DELAY = 700;

export class DtvZapper {
    /**
     * @param {Object} options
     * @param {Array<number>} options.ids - Ordered channel ids of the active list
     * @param {number} options.currentId - Channel playing at start
     * @param {number|null} [options.previousId] - Restored "last channel"
     * @param {function(number): void} options.onCommit - Called when a switch must happen
     * @param {number} [options.delay] - Debounce before committing (ms)
     * @param {Function} [options.setTimeout] - Timer injection for tests
     * @param {Function} [options.clearTimeout] - Timer injection for tests
     */
    constructor(options) {
        this._ids = options.ids || [];
        this._currentId = options.currentId;
        this._previousId = options.previousId != null ? options.previousId : null;
        this._pendingId = null;
        this._onCommit = options.onCommit;
        this._delay = options.delay != null ? options.delay : ZAP_COMMIT_DELAY;
        this._setTimeout = options.setTimeout || ((fn, ms) => setTimeout(fn, ms));
        this._clearTimeout = options.clearTimeout || ((id) => clearTimeout(id));
        this._timer = null;
    }

    /** Channel currently playing (or being started). */
    get currentId() {
        return this._currentId;
    }

    /** Channel shown in the overlay: pending selection, else the current one. */
    get displayedId() {
        return this._pendingId != null ? this._pendingId : this._currentId;
    }

    /** Channel the "last channel" key returns to. */
    get previousId() {
        return this._previousId;
    }

    /** True while a debounced switch is waiting to be committed. */
    get isPending() {
        return this._pendingId != null;
    }

    /**
     * Move the pending selection by `step` channels (wrapping).
     * @param {number} step - +1 next, -1 previous
     * @returns {number|null} Newly displayed channel id
     */
    step(step) {
        const next = stepChannel(this._ids, this.displayedId, step);
        if (next == null) return null;
        this._pendingId = next;
        this._schedule();
        return next;
    }

    /**
     * Switch to the previously watched channel immediately.
     * @returns {number|null} Target channel id, or null when there is none
     */
    jumpToPrevious() {
        if (this._previousId == null || this._previousId === this._currentId) return null;
        return this.jumpTo(this._previousId);
    }

    /**
     * Switch to a channel immediately, cancelling any pending selection.
     * @param {number} id
     * @returns {number}
     */
    jumpTo(id) {
        this._pendingId = id;
        this.commit();
        return id;
    }

    /**
     * Commit the pending selection now (no-op when nothing is pending or the
     * pending channel is already playing).
     */
    commit() {
        this._cancelTimer();
        const target = this._pendingId;
        this._pendingId = null;
        if (target == null || target === this._currentId) return;
        this._previousId = this._currentId;
        this._currentId = target;
        this._onCommit(target);
    }

    /** Drop the pending selection without switching. */
    cancel() {
        this._cancelTimer();
        this._pendingId = null;
    }

    /** Release timers. */
    destroy() {
        this.cancel();
        this._onCommit = () => {};
    }

    _schedule() {
        this._cancelTimer();
        this._timer = this._setTimeout(() => {
            this._timer = null;
            this.commit();
        }, this._delay);
    }

    _cancelTimer() {
        if (this._timer != null) {
            this._clearTimeout(this._timer);
            this._timer = null;
        }
    }
}

export default DtvZapper;

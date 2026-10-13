/**
 * ============================================================================
 * Litefin Tizen - Dispatcharr Zapping Overlay
 * ============================================================================
 * Bottom info banner shown while watching a live channel: number, logo,
 * name, list, airing program with time range and progress, next program,
 * clock and connection status. Also hosts the error panel and short toasts
 * (e.g. favorite added). Only opacity/transform are animated.
 * ============================================================================
 */

import { escapeHtml } from '../../utils/Utils.js';
import { i18n } from '../../utils/i18n.js';
import { dtvStore } from '../../livetv/DtvStore.js';
import { programProgress } from '../../livetv/DtvModel.js';
import { bindLogo, formatRange, logoHtml, programTitle, starIcon } from './DtvTemplates.js';

const AUTO_HIDE = 5000;
const TOAST_TIME = 2000;

export default class DtvZapOverlay {
    /**
     * @param {HTMLElement} container - Player page root
     */
    constructor(container) {
        this.container = container;
        this._channel = null;
        this._listName = '';
        this._status = '';
        this._visible = false;
        this._sticky = false;

        this.container.insertAdjacentHTML(
            'beforeend',
            `
            <div class="dtv-zap">
                <div class="dtv-zap-clock"></div>
                <div class="dtv-zap-panel">
                    <div class="dtv-zap-channel"></div>
                    <div class="dtv-zap-now">
                        <div class="dtv-zap-now-line">
                            <span class="dtv-zap-badge"></span>
                            <span class="dtv-zap-time"></span>
                            <span class="dtv-zap-title"></span>
                        </div>
                        <div class="dtv-progress"><div class="dtv-progress-bar"></div></div>
                    </div>
                    <div class="dtv-zap-next"></div>
                    <div class="dtv-zap-status"></div>
                </div>
            </div>
            <div class="dtv-player-message"></div>
            <div class="dtv-zap-toast"></div>
            `
        );
        this._el = this.container.querySelector('.dtv-zap');
        this._clock = this._el.querySelector('.dtv-zap-clock');
        this._channelEl = this._el.querySelector('.dtv-zap-channel');
        this._badge = this._el.querySelector('.dtv-zap-badge');
        this._time = this._el.querySelector('.dtv-zap-time');
        this._title = this._el.querySelector('.dtv-zap-title');
        this._progress = this._el.querySelector('.dtv-progress');
        this._bar = this._el.querySelector('.dtv-progress-bar');
        this._next = this._el.querySelector('.dtv-zap-next');
        this._statusEl = this._el.querySelector('.dtv-zap-status');
        this._message = this.container.querySelector('.dtv-player-message');
        this._toast = this.container.querySelector('.dtv-zap-toast');

        this._tickTimer = setInterval(() => {
            if (this._visible) this.refresh();
        }, 15000);
    }

    /** @returns {boolean} */
    get isVisible() {
        return this._visible;
    }

    /**
     * Show the banner for a channel.
     * @param {Object} channel
     * @param {Object} [options]
     * @param {string} [options.listName] - Name of the list being zapped
     * @param {boolean} [options.sticky] - Do not auto-hide (connecting / error)
     */
    show(channel, options = {}) {
        const listChanged = options.listName !== undefined && options.listName !== this._listName;
        if (listChanged) this._listName = options.listName;
        if (channel && (channel !== this._channel || listChanged)) {
            this._channel = channel;
            this._renderChannel();
        }
        this._sticky = !!options.sticky;
        this.refresh();
        this._visible = true;
        this._el.classList.add('visible');
        this._scheduleHide();
    }

    hide() {
        clearTimeout(this._hideTimer);
        this._visible = false;
        this._el.classList.remove('visible');
    }

    /**
     * Status line under the program info ('' hides it).
     * @param {string} text
     * @param {boolean} [sticky] - Keep the banner up while the status lasts
     */
    setStatus(text, sticky) {
        this._status = text || '';
        this._statusEl.textContent = this._status;
        this._statusEl.style.display = this._status ? '' : 'none';
        this._sticky = !!sticky;
        if (this._visible) this._scheduleHide();
    }

    /**
     * Centered error panel ('' hides it).
     * @param {string} title
     * @param {string} [hint]
     */
    setMessage(title, hint) {
        if (!title) {
            this._message.classList.remove('visible');
            return;
        }
        this._message.innerHTML = `
            <div class="dtv-player-message-title">${escapeHtml(title)}</div>
            ${hint ? `<div class="dtv-player-message-hint">${escapeHtml(hint)}</div>` : ''}
        `;
        this._message.classList.add('visible');
    }

    /**
     * Short notification in the top center.
     * @param {string} text
     */
    toast(text) {
        this._toast.textContent = text;
        this._toast.classList.add('visible');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => this._toast.classList.remove('visible'), TOAST_TIME);
    }

    /** Update program info, progress, favorite star and clock. */
    refresh() {
        const now = Date.now();
        this._clock.textContent = i18n.formatLocalTime(new Date(now));
        if (!this._channel) return;

        const { now: current, next } = dtvStore.getNowNext(this._channel, now);
        if (current) {
            this._badge.textContent = i18n.t('DtvNow');
            this._time.textContent = formatRange(current);
            this._title.textContent = programTitle(current);
            this._bar.style.transform = `scaleX(${programProgress(current, now)})`;
            this._progress.style.visibility = '';
        } else {
            this._badge.textContent = '';
            this._time.textContent = '';
            this._title.textContent = i18n.t('DtvNoProgramInfo');
            this._progress.style.visibility = 'hidden';
        }
        this._next.textContent = next
            ? `${i18n.t('DtvNext')} ${i18n.formatLocalTime(new Date(next.start))} ${programTitle(next)}`
            : '';

        const star = this._channelEl.querySelector('.dtv-zap-fav');
        if (star) {
            const isFavorite = dtvStore.isFavorite(this._channel);
            star.innerHTML = isFavorite ? starIcon(true) : '';
            star.style.display = isFavorite ? '' : 'none';
        }
    }

    destroy() {
        clearInterval(this._tickTimer);
        clearTimeout(this._hideTimer);
        clearTimeout(this._toastTimer);
    }

    // ========================================================================
    // Internals
    // ========================================================================

    _renderChannel() {
        const channel = this._channel;
        this._channelEl.innerHTML = `
            <span class="dtv-zap-number">${escapeHtml(channel.numberLabel)}</span>
            ${logoHtml(channel, 'dtv-zap-logo')}
            <div class="dtv-zap-names">
                <div class="dtv-zap-name">${escapeHtml(channel.name)}<span class="dtv-zap-fav"></span></div>
                <div class="dtv-zap-list">${escapeHtml(this._listName)}</div>
            </div>
        `;
        bindLogo(this._channelEl, channel);
    }

    _scheduleHide() {
        clearTimeout(this._hideTimer);
        if (this._sticky) return;
        this._hideTimer = setTimeout(() => this.hide(), AUTO_HIDE);
    }
}

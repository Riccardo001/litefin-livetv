/**
 * ============================================================================
 * Litefin Tizen - Dispatcharr Channel List
 * ============================================================================
 * Vertical, virtualized channel list: only the rows in view (plus a small
 * overscan) exist in the DOM, positioned absolutely inside a track that is
 * moved with translate3d. Each row has two focus targets: the row itself
 * (OK plays the channel) and a star button (OK toggles the favorite).
 *
 * Same windowing idea as VirtualCardRow, but vertical and with fixed row
 * geometry (VirtualCardRow is horizontal and sized by Home card settings).
 * ============================================================================
 */

import { focusManager } from '../../ui/FocusManager.js';
import { escapeHtml } from '../../utils/Utils.js';
import { i18n } from '../../utils/i18n.js';
import { dtvStore } from '../../livetv/DtvStore.js';
import { programProgress } from '../../livetv/DtvModel.js';
import { bindLogo, formatRange, logoHtml, programTitle, starIcon } from './DtvTemplates.js';

// Must match .dtv-row height in dtv.css
const ROW_HEIGHT = 104;
const OVERSCAN = 3;

export default class DtvChannelList {
    /**
     * @param {HTMLElement} container - Element the list fills
     * @param {Object} options
     * @param {string} options.sectionName - FocusManager section name
     * @param {string} [options.leaveUp] - Section reached by Up on the first row
     * @param {string} [options.leaveLeft] - Section reached by Left on a row
     * @param {function(Object): void} options.onPlay - OK on a row
     * @param {function(Object): void} [options.onFocusChannel] - Focus moved to a channel
     */
    constructor(container, options) {
        this.container = container;
        this.options = options;
        this._channels = [];
        this._rows = new Map(); // index -> row element
        this._scrollY = 0;
        this._viewHeight = 0;
        this._focusIndex = 0;
        this._focusColumn = 'main';

        this.container.innerHTML = `
            <div class="dtv-list">
                <div class="dtv-list-track"></div>
            </div>
        `;
        this._viewport = this.container.querySelector('.dtv-list');
        this._track = this.container.querySelector('.dtv-list-track');

        this._onClick = this._onClick.bind(this);
        this._track.addEventListener('click', this._onClick);

        this._onResize = () => this._measure();
        if (typeof ResizeObserver === 'function') {
            this._resizeObserver = new ResizeObserver(this._onResize);
            this._resizeObserver.observe(this._viewport);
        } else {
            window.addEventListener('resize', this._onResize);
        }

        focusManager.register(options.sectionName, this._viewport, {
            orientation: 'vertical',
            selector: '.dtv-row-main, .dtv-row-fav',
            leaveUp: options.leaveUp || null,
            leaveLeft: options.leaveLeft || null,
            onMove: (direction, current) => this._move(direction, current),
            onEnter: () => this._elementAt(this._focusIndex, this._focusColumn),
            onRestoreIndex: (index) => this._elementAt(index, 'main')
        });
    }

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * Replace the displayed channels.
     * @param {Array<Object>} channels
     * @param {number|null} [focusId] - Channel id to keep/put under focus
     */
    setChannels(channels, focusId) {
        const previousId = this.getFocusedChannelId();
        this._channels = channels || [];
        this._clearRows();
        this._track.style.height = `${this._channels.length * ROW_HEIGHT}px`;

        const wantedId = focusId != null ? focusId : previousId;
        const index = wantedId != null ? this._channels.findIndex((c) => c.id === wantedId) : -1;
        this._focusIndex = index >= 0 ? index : 0;
        this._focusColumn = 'main';

        this._measure();
        this._scrollTo(this._focusIndex, true);
        focusManager.invalidateCache(this.options.sectionName);
    }

    /** @returns {boolean} True when the list has no channels */
    get isEmpty() {
        return this._channels.length === 0;
    }

    /** @returns {number|null} Id of the channel under the list cursor */
    getFocusedChannelId() {
        const channel = this._channels[this._focusIndex];
        return channel ? channel.id : null;
    }

    /**
     * Move focus to a channel row (rendering it when needed).
     * @param {number} [channelId] - Defaults to the remembered cursor
     */
    focus(channelId) {
        if (channelId != null) {
            const index = this._channels.findIndex((c) => c.id === channelId);
            if (index >= 0) this._focusIndex = index;
        }
        const el = this._elementAt(this._focusIndex, 'main');
        if (el) this._focusElement(el, this._focusIndex, 'main');
    }

    /** Re-render program info of the rows in view (EPG arrived / clock tick). */
    refreshPrograms() {
        const now = Date.now();
        this._rows.forEach((row, index) => this._fillProgram(row, this._channels[index], now));
    }

    /** Re-render favorite stars of the rows in view. */
    refreshFavorites() {
        this._rows.forEach((row, index) => this._fillFavorite(row, this._channels[index]));
    }

    destroy() {
        this._track.removeEventListener('click', this._onClick);
        if (this._resizeObserver) this._resizeObserver.disconnect();
        else window.removeEventListener('resize', this._onResize);
        focusManager.unregister(this.options.sectionName);
        this._rows.clear();
        this.container.innerHTML = '';
    }

    // ========================================================================
    // Virtualization
    // ========================================================================

    _measure() {
        const height = this._viewport.clientHeight;
        if (height && height !== this._viewHeight) {
            this._viewHeight = height;
            this._renderWindow();
        }
    }

    _scrollTo(index, instant) {
        const maxScroll = Math.max(0, this._channels.length * ROW_HEIGHT - this._viewHeight);
        const top = index * ROW_HEIGHT;
        let target = this._scrollY;

        // Keep one row of context above and below the focused row
        if (top - ROW_HEIGHT < target) {
            target = top - ROW_HEIGHT;
        } else if (top + 2 * ROW_HEIGHT > target + this._viewHeight) {
            target = top + 2 * ROW_HEIGHT - this._viewHeight;
        }
        target = Math.max(0, Math.min(target, maxScroll));

        if (target !== this._scrollY || instant) {
            this._scrollY = target;
            this._track.classList.toggle('no-anim', !!instant);
            this._track.style.transform = `translate3d(0, ${-target}px, 0)`;
        }
        this._renderWindow();
    }

    _renderWindow() {
        const viewHeight = this._viewHeight || 800;
        const first = Math.max(0, Math.floor(this._scrollY / ROW_HEIGHT) - OVERSCAN);
        const last = Math.min(
            this._channels.length - 1,
            Math.ceil((this._scrollY + viewHeight) / ROW_HEIGHT) + OVERSCAN
        );

        this._rows.forEach((row, index) => {
            if (index < first || index > last) {
                if (row.parentNode) row.parentNode.removeChild(row);
                this._rows.delete(index);
            }
        });

        const now = Date.now();
        for (let i = first; i <= last; i++) {
            if (!this._rows.has(i)) this._renderRow(i, now);
        }
    }

    _clearRows() {
        this._rows.forEach((row) => {
            if (row.parentNode) row.parentNode.removeChild(row);
        });
        this._rows.clear();
    }

    _renderRow(index, now) {
        const channel = this._channels[index];
        if (!channel) return null;

        const row = document.createElement('div');
        row.className = 'dtv-row';
        row.style.top = `${index * ROW_HEIGHT}px`;
        row.innerHTML = `
            <div class="dtv-row-main" tabindex="0" data-index="${index}">
                <span class="dtv-row-number">${escapeHtml(channel.numberLabel)}</span>
                ${logoHtml(channel, 'dtv-row-logo')}
                <div class="dtv-row-info">
                    <div class="dtv-row-name">${escapeHtml(channel.name)}</div>
                    <div class="dtv-row-program">
                        <span class="dtv-row-time"></span>
                        <span class="dtv-row-title"></span>
                    </div>
                    <div class="dtv-progress"><div class="dtv-progress-bar"></div></div>
                </div>
                <div class="dtv-row-next"></div>
            </div>
            <div class="dtv-row-fav" tabindex="0" data-index="${index}"></div>
        `;
        row._main = row.querySelector('.dtv-row-main');
        row._fav = row.querySelector('.dtv-row-fav');
        row._time = row.querySelector('.dtv-row-time');
        row._title = row.querySelector('.dtv-row-title');
        row._bar = row.querySelector('.dtv-progress-bar');
        row._progress = row.querySelector('.dtv-progress');
        row._next = row.querySelector('.dtv-row-next');

        this._fillProgram(row, channel, now);
        this._fillFavorite(row, channel);
        bindLogo(row, channel);

        this._track.appendChild(row);
        this._rows.set(index, row);
        return row;
    }

    _fillProgram(row, channel, now) {
        if (!row || !channel) return;
        const { now: current, next } = dtvStore.getNowNext(channel, now);

        if (current) {
            row._time.textContent = formatRange(current);
            row._title.textContent = programTitle(current);
            row._bar.style.transform = `scaleX(${programProgress(current, now)})`;
            row._progress.style.visibility = '';
        } else {
            row._time.textContent = '';
            row._title.textContent = i18n.t('DtvNoProgramInfo');
            row._progress.style.visibility = 'hidden';
        }

        row._next.textContent = next
            ? `${i18n.t('DtvNext')} ${i18n.formatLocalTime(new Date(next.start))} ${programTitle(next)}`
            : '';
    }

    _fillFavorite(row, channel) {
        if (!row || !channel) return;
        const isFavorite = dtvStore.isFavorite(channel);
        row._fav.classList.toggle('is-favorite', isFavorite);
        row._fav.innerHTML = starIcon(isFavorite);
        row._main.classList.toggle('is-favorite', isFavorite);
    }

    // ========================================================================
    // Focus & Input
    // ========================================================================

    _elementAt(index, column) {
        if (!this._channels.length) return null;
        const safeIndex = Math.max(0, Math.min(index, this._channels.length - 1));
        this._scrollTo(safeIndex);
        let row = this._rows.get(safeIndex);
        if (!row) row = this._renderRow(safeIndex, Date.now());
        if (!row) return null;
        return column === 'fav' ? row._fav : row._main;
    }

    _focusElement(el, index, column) {
        this._focusIndex = index;
        this._focusColumn = column;
        focusManager.focusElement(el, { skipScroll: true });
        if (this.options.onFocusChannel) this.options.onFocusChannel(this._channels[index]);
    }

    _move(direction, current) {
        if (!current || current.dataset.index === undefined) return false;
        const index = parseInt(current.dataset.index, 10);
        const column = current.classList.contains('dtv-row-fav') ? 'fav' : 'main';

        if (direction === 'up' || direction === 'down') {
            const target = index + (direction === 'down' ? 1 : -1);
            if (target < 0) {
                if (this.options.leaveUp) focusManager.setActiveSection(this.options.leaveUp, true, current);
                return true;
            }
            if (target >= this._channels.length) return true;
            const el = this._elementAt(target, column);
            if (el) this._focusElement(el, target, column);
            return true;
        }

        if (direction === 'right') {
            if (column === 'main') this._focusElement(this._elementAt(index, 'fav'), index, 'fav');
            return true;
        }

        // Left
        if (column === 'fav') {
            this._focusElement(this._elementAt(index, 'main'), index, 'main');
        } else if (this.options.leaveLeft) {
            focusManager.setActiveSection(this.options.leaveLeft, true, current, { direction: 'left' });
        }
        return true;
    }

    _onClick(e) {
        const target = e.target.closest('.dtv-row-main, .dtv-row-fav');
        if (!target) return;
        const index = parseInt(target.dataset.index, 10);
        const channel = this._channels[index];
        if (!channel) return;

        if (target.classList.contains('dtv-row-fav')) {
            dtvStore.toggleFavorite(channel);
            this._fillFavorite(this._rows.get(index), channel);
            return;
        }
        this._focusIndex = index;
        this.options.onPlay(channel);
    }
}

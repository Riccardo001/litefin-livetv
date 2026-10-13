/**
 * ============================================================================
 * Litefin Tizen - Dispatcharr EPG Guide
 * ============================================================================
 * Virtualized program grid (channels vertically, time horizontally):
 *  - Vertical: only rows in view + overscan exist in the DOM.
 *  - Horizontal: each row renders only the cells overlapping the visible
 *    time window (+ margin) and re-renders when the view moves past it.
 *  - Scrolling is done exclusively with translate3d on the tracks, and the
 *    DOM is only touched when focus or data changes (no render loop).
 *
 * Every row is split into contiguous cells (programs + "no info" fillers,
 * see buildSegments) so the D-pad always has a target. Up/Down keep a
 * "focus time" so the cursor stays in the same time column across rows.
 * ============================================================================
 */

import { focusManager } from '../../ui/FocusManager.js';
import { escapeHtml } from '../../utils/Utils.js';
import { i18n } from '../../utils/i18n.js';
import { eventBus } from '../../core/EventBus.js';
import { dtvStore } from '../../livetv/DtvStore.js';
import { buildSegments, segmentIndexAt } from '../../livetv/DtvModel.js';
import { bindLogo, logoHtml, programTitle } from './DtvTemplates.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const SLOT = 30 * MINUTE;

// Geometry (must match dtv.css; the channel column is 300px wide there)
const ROW_HEIGHT = 84;
const PX_PER_MS = 8 / MINUTE; // 8 px per minute, 480 px per hour

// Timeline: 1 hour back, 24 hours ahead
const PAST_SPAN = HOUR;
const TOTAL_SPAN = 25 * HOUR;

const ROW_OVERSCAN = 2;
const CELL_MARGIN = 2 * HOUR;
const MIN_TITLE_WIDTH = 120;

function floorTo(time, step) {
    return Math.floor(time / step) * step;
}

export default class DtvGuide {
    /**
     * @param {HTMLElement} container
     * @param {Object} options
     * @param {string} options.sectionName - FocusManager section name
     * @param {string} [options.leaveUp]
     * @param {string} [options.leaveLeft]
     * @param {function(Object): void} options.onPlay - OK on a channel or cell
     * @param {function(Object, Object|null): void} [options.onFocusProgram] - (channel, program)
     */
    constructor(container, options) {
        this.container = container;
        this.options = options;
        this._channels = [];
        this._rows = new Map(); // index -> {channelEl, rowEl, from, to}
        this._segments = new Map(); // channel id -> segments
        this._scrollY = 0;
        this._viewWidth = 0;
        this._viewHeight = 0;

        const now = Date.now();
        this._timelineStart = floorTo(now, SLOT) - PAST_SPAN;
        this._timelineEnd = this._timelineStart + TOTAL_SPAN;
        this._viewStart = floorTo(now, SLOT);
        this._focusTime = now;
        this._focusIndex = 0;
        this._focusSeg = -1; // -1 = channel cell

        this._render();

        this._onClick = this._onClick.bind(this);
        this._root.addEventListener('click', this._onClick);

        this._onResize = () => this._measure();
        if (typeof ResizeObserver === 'function') {
            this._resizeObserver = new ResizeObserver(this._onResize);
            this._resizeObserver.observe(this._grid);
        } else {
            window.addEventListener('resize', this._onResize);
        }

        this._unsubscribePrograms = eventBus.on('dtv:programsUpdated', () => {
            this._segments.clear();
            this._rerenderRows();
            this._refocusIfDetached();
            this._notifyFocus();
        });

        // Keep "now" line and on-air highlight current
        this._clock = setInterval(() => this._tick(), 30000);

        focusManager.register(options.sectionName, this._root, {
            orientation: 'both',
            selector: '.dtv-guide-ch, .dtv-cell',
            leaveUp: options.leaveUp || null,
            leaveLeft: options.leaveLeft || null,
            onMove: (direction, current) => this._move(direction, current),
            onEnter: () => this._currentElement(),
            onRestoreIndex: () => this._currentElement()
        });
    }

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * Replace the displayed channels.
     * @param {Array<Object>} channels
     * @param {number|null} [focusId] - Channel id to put under the cursor
     */
    setChannels(channels, focusId) {
        const previousId = this.getFocusedChannelId();
        this._channels = channels || [];
        this._clearRows();
        this._segments.clear();

        const height = this._channels.length * ROW_HEIGHT;
        this._channelsTrack.style.height = `${height}px`;
        this._gridTrack.style.height = `${height}px`;

        const wantedId = focusId != null ? focusId : previousId;
        const index = wantedId != null ? this._channels.findIndex((c) => c.id === wantedId) : -1;
        this._focusIndex = index >= 0 ? index : 0;
        this._focusSeg = -1;

        this._measure();
        this._scrollToRow(this._focusIndex);
        focusManager.invalidateCache(this.options.sectionName);
        this._requestPrograms();
    }

    /** @returns {number|null} Channel id under the cursor */
    getFocusedChannelId() {
        const channel = this._channels[this._focusIndex];
        return channel ? channel.id : null;
    }

    /**
     * Focus a channel's cell at the current time (or its channel cell).
     * @param {number} [channelId]
     */
    focus(channelId) {
        if (channelId != null) {
            const index = this._channels.findIndex((c) => c.id === channelId);
            if (index >= 0) this._focusIndex = index;
        }
        const el = this._currentElement();
        if (el) this._focusEl(el);
    }

    destroy() {
        clearInterval(this._clock);
        clearTimeout(this._programsTimer);
        if (this._unsubscribePrograms) this._unsubscribePrograms();
        this._root.removeEventListener('click', this._onClick);
        if (this._resizeObserver) this._resizeObserver.disconnect();
        else window.removeEventListener('resize', this._onResize);
        focusManager.unregister(this.options.sectionName);
        this._rows.clear();
        this.container.innerHTML = '';
    }

    // ========================================================================
    // Structure
    // ========================================================================

    _render() {
        this.container.innerHTML = `
            <div class="dtv-guide">
                <div class="dtv-guide-head">
                    <div class="dtv-guide-corner"></div>
                    <div class="dtv-guide-timeline">
                        <div class="dtv-guide-timeline-track">${this._timelineHtml()}</div>
                    </div>
                </div>
                <div class="dtv-guide-body">
                    <div class="dtv-guide-channels"><div class="dtv-guide-channels-track"></div></div>
                    <div class="dtv-guide-grid">
                        <div class="dtv-guide-grid-track"></div>
                        <div class="dtv-guide-now"></div>
                    </div>
                </div>
            </div>
        `;
        this._root = this.container.querySelector('.dtv-guide');
        this._corner = this.container.querySelector('.dtv-guide-corner');
        this._timelineTrack = this.container.querySelector('.dtv-guide-timeline-track');
        this._channelsTrack = this.container.querySelector('.dtv-guide-channels-track');
        this._grid = this.container.querySelector('.dtv-guide-grid');
        this._gridTrack = this.container.querySelector('.dtv-guide-grid-track');
        this._nowLine = this.container.querySelector('.dtv-guide-now');
        this._gridTrack.style.width = `${TOTAL_SPAN * PX_PER_MS}px`;
    }

    _timelineHtml() {
        const parts = [];
        for (let t = this._timelineStart; t < this._timelineEnd; t += SLOT) {
            parts.push(
                `<div class="dtv-guide-slot" style="width:${SLOT * PX_PER_MS}px">${i18n.formatLocalTime(new Date(t))}</div>`
            );
        }
        return parts.join('');
    }

    _measure() {
        const width = this._grid.clientWidth;
        const height = this._grid.clientHeight;
        if (!width || !height) return;
        if (width !== this._viewWidth || height !== this._viewHeight) {
            this._viewWidth = width;
            this._viewHeight = height;
            this._setViewStart(this._viewStart);
            this._renderWindow();
            this._refocusIfDetached();
        }
    }

    get _viewSpan() {
        return (this._viewWidth || 1200) / PX_PER_MS;
    }

    _x(time) {
        return (time - this._timelineStart) * PX_PER_MS;
    }

    // ========================================================================
    // Scrolling
    // ========================================================================

    _setViewStart(time) {
        const maxStart = this._timelineEnd - this._viewSpan;
        const next = Math.max(this._timelineStart, Math.min(time, maxStart));
        const changed = next !== this._viewStart;
        this._viewStart = next;

        const x = -this._x(next);
        this._timelineTrack.style.transform = `translate3d(${x}px, 0, 0)`;
        this._gridTrack.style.transform = `translate3d(${x}px, ${-this._scrollY}px, 0)`;
        this._updateNowLine();
        this._updateCorner();

        if (changed) {
            this._rows.forEach((row, index) => this._ensureCells(row, index));
            this._updateStickyTitles();
            this._requestPrograms();
        }
    }

    _scrollToRow(index) {
        const maxScroll = Math.max(0, this._channels.length * ROW_HEIGHT - this._viewHeight);
        const top = index * ROW_HEIGHT;
        let target = this._scrollY;
        if (top - ROW_HEIGHT < target) {
            target = top - ROW_HEIGHT;
        } else if (top + 2 * ROW_HEIGHT > target + this._viewHeight) {
            target = top + 2 * ROW_HEIGHT - this._viewHeight;
        }
        target = Math.max(0, Math.min(target, maxScroll));

        if (target !== this._scrollY) {
            this._scrollY = target;
            this._channelsTrack.style.transform = `translate3d(0, ${-target}px, 0)`;
            this._gridTrack.style.transform = `translate3d(${-this._x(this._viewStart)}px, ${-target}px, 0)`;
        }
        this._renderWindow();
    }

    /** Scroll horizontally so that `segment` is comfortably visible. */
    _revealSegment(segment) {
        const span = this._viewSpan;
        let start = this._viewStart;
        if (segment.start < start) {
            start = floorTo(Math.max(segment.start, segment.end - span * 0.75), SLOT);
        } else if (segment.start > start + span - SLOT) {
            start = floorTo(segment.start - SLOT, SLOT);
        }
        if (start !== this._viewStart) this._setViewStart(start);
    }

    // ========================================================================
    // Rows & Cells
    // ========================================================================

    _renderWindow() {
        const viewHeight = this._viewHeight || 600;
        const first = Math.max(0, Math.floor(this._scrollY / ROW_HEIGHT) - ROW_OVERSCAN);
        const last = Math.min(
            this._channels.length - 1,
            Math.ceil((this._scrollY + viewHeight) / ROW_HEIGHT) + ROW_OVERSCAN
        );

        this._rows.forEach((row, index) => {
            if (index < first || index > last) {
                this._removeRow(row);
                this._rows.delete(index);
            }
        });
        for (let i = first; i <= last; i++) {
            if (!this._rows.has(i)) this._renderRow(i);
        }
        this._updateStickyTitles();
    }

    _renderRow(index) {
        const channel = this._channels[index];
        if (!channel) return null;
        const top = `${index * ROW_HEIGHT}px`;

        const channelEl = document.createElement('div');
        channelEl.className = 'dtv-guide-ch';
        channelEl.tabIndex = 0;
        channelEl.dataset.index = String(index);
        channelEl.style.top = top;
        channelEl.innerHTML = `
            <span class="dtv-guide-ch-number">${escapeHtml(channel.numberLabel)}</span>
            ${logoHtml(channel, 'dtv-guide-logo')}
            <span class="dtv-guide-ch-name">${escapeHtml(channel.name)}</span>
        `;
        bindLogo(channelEl, channel);
        this._channelsTrack.appendChild(channelEl);

        const rowEl = document.createElement('div');
        rowEl.className = 'dtv-guide-row';
        rowEl.style.top = top;
        this._gridTrack.appendChild(rowEl);

        const row = { channelEl, rowEl, from: 0, to: 0, cells: [] };
        this._rows.set(index, row);
        this._ensureCells(row, index, true);
        return row;
    }

    _removeRow(row) {
        if (row.channelEl.parentNode) row.channelEl.parentNode.removeChild(row.channelEl);
        if (row.rowEl.parentNode) row.rowEl.parentNode.removeChild(row.rowEl);
    }

    _clearRows() {
        this._rows.forEach((row) => this._removeRow(row));
        this._rows.clear();
    }

    _rerenderRows() {
        this._rows.forEach((row, index) => this._ensureCells(row, index, true));
        this._updateStickyTitles();
    }

    _segmentsFor(channel) {
        let segments = this._segments.get(channel.id);
        if (!segments) {
            segments = buildSegments(dtvStore.getPrograms(channel), this._timelineStart, this._timelineEnd);
            this._segments.set(channel.id, segments);
        }
        return segments;
    }

    /** (Re)render a row's cells when the visible window left its rendered range. */
    _ensureCells(row, index, force) {
        const viewEnd = this._viewStart + this._viewSpan;
        if (!force && this._viewStart >= row.from && viewEnd <= row.to) return;

        const from = this._viewStart - CELL_MARGIN;
        const to = viewEnd + CELL_MARGIN;
        const channel = this._channels[index];
        const segments = this._segmentsFor(channel);
        const now = Date.now();
        const parts = [];

        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            if (seg.end <= from || seg.start >= to) continue;
            parts.push(this._cellHtml(seg, i, index, now));
        }

        row.rowEl.innerHTML = parts.join('');
        row.from = from;
        row.to = to;
        row.cells = Array.prototype.slice.call(row.rowEl.children);
    }

    _cellHtml(seg, segIndex, rowIndex, now) {
        const left = this._x(seg.start);
        const width = Math.max(1, (seg.end - seg.start) * PX_PER_MS);
        let className = 'dtv-cell';
        if (!seg.program) className += ' is-empty';
        else if (seg.start <= now && now < seg.end) className += ' is-now';
        else if (seg.end <= now) className += ' is-past';

        const title = seg.program ? escapeHtml(programTitle(seg.program)) : escapeHtml(i18n.t('DtvNoProgramInfo'));
        const time = seg.program
            ? `<div class="dtv-cell-time">${i18n.formatLocalTime(new Date(seg.program.start))}</div>`
            : '';

        return `
            <div class="${className}" tabindex="0" data-index="${rowIndex}" data-seg="${segIndex}"
                 data-left="${left}" data-width="${width}" style="left:${left}px;width:${width}px">
                <div class="dtv-cell-content"><div class="dtv-cell-title">${title}</div>${time}</div>
            </div>`;
    }

    /** Keep titles readable when a cell starts left of the visible area. */
    _updateStickyTitles() {
        const viewX = this._x(this._viewStart);
        this._rows.forEach((row) => {
            for (let i = 0; i < row.cells.length; i++) {
                const cell = row.cells[i];
                const left = parseFloat(cell.dataset.left);
                const width = parseFloat(cell.dataset.width);
                const shift = Math.max(0, Math.min(viewX - left, width - MIN_TITLE_WIDTH));
                if (cell._shift !== shift) {
                    cell._shift = shift;
                    cell.firstElementChild.style.transform = shift > 0 ? `translate3d(${shift}px, 0, 0)` : '';
                }
            }
        });
    }

    _tick() {
        this._updateNowLine();
        const now = Date.now();
        this._rows.forEach((row) => {
            const channel = this._channels[parseInt(row.channelEl.dataset.index, 10)];
            if (!channel) return;
            const segments = this._segmentsFor(channel);
            row.cells.forEach((cell) => {
                const seg = segments[parseInt(cell.dataset.seg, 10)];
                if (!seg || !seg.program) return;
                cell.classList.toggle('is-now', seg.start <= now && now < seg.end);
                cell.classList.toggle('is-past', seg.end <= now);
            });
        });
    }

    _updateNowLine() {
        const x = this._x(Date.now()) - this._x(this._viewStart);
        const visible = x >= 0 && x <= (this._viewWidth || 0);
        this._nowLine.style.transform = `translate3d(${x}px, 0, 0)`;
        this._nowLine.style.opacity = visible ? '1' : '0';
    }

    _updateCorner() {
        const date = new Date(this._viewStart);
        const tomorrow = new Date(Date.now() + 24 * HOUR);
        if (date.toDateString() === new Date().toDateString()) {
            this._corner.textContent = i18n.t('Today');
        } else if (date.toDateString() === tomorrow.toDateString()) {
            this._corner.textContent = i18n.t('Tomorrow');
        } else {
            this._corner.textContent = date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
        }
    }

    // ========================================================================
    // EPG Loading
    // ========================================================================

    _requestPrograms() {
        clearTimeout(this._programsTimer);
        this._programsTimer = setTimeout(() => {
            const from = this._viewStart - HOUR;
            const to = this._viewStart + this._viewSpan + 3 * HOUR;
            dtvStore.ensurePrograms(from, to);
        }, 250);
    }

    // ========================================================================
    // Focus & Navigation
    // ========================================================================

    _rowAt(index) {
        this._scrollToRow(index);
        return this._rows.get(index) || this._renderRow(index);
    }

    /** Element for the remembered cursor (channel cell or time cell). */
    _currentElement() {
        if (!this._channels.length) return null;
        const index = Math.max(0, Math.min(this._focusIndex, this._channels.length - 1));
        const row = this._rowAt(index);
        if (!row) return null;
        if (this._focusSeg < 0) return row.channelEl;
        // The focus time is always inside the view: no horizontal scroll needed
        return this._cellFor(index, segmentIndexAt(this._segmentsFor(this._channels[index]), this._focusTime), false);
    }

    /**
     * Make sure a segment's cell exists in its row and return it.
     * @param {number} index - Row index
     * @param {number} segIndex - Segment index in the row
     * @param {boolean} [reveal=true] - Scroll horizontally to show the cell
     */
    _cellFor(index, segIndex, reveal = true) {
        const row = this._rowAt(index);
        const segments = this._segmentsFor(this._channels[index]);
        const seg = segments[segIndex];
        if (!row || !seg) return null;
        if (reveal) this._revealSegment(seg);
        this._ensureCells(row, index);
        const cells = row.cells;
        for (let i = 0; i < cells.length; i++) {
            if (parseInt(cells[i].dataset.seg, 10) === segIndex) return cells[i];
        }
        // Outside the rendered window: force a re-render around the new view
        this._ensureCells(row, index, true);
        return row.cells.filter((c) => parseInt(c.dataset.seg, 10) === segIndex)[0] || null;
    }

    /**
     * Cells are re-rendered when EPG data arrives or the view moves; if the
     * focused cell was one of them, put focus back on the cell now covering
     * the same channel and time (the D-pad cursor must never get lost).
     */
    _refocusIfDetached() {
        if (focusManager.getActiveSection() !== this.options.sectionName) return;
        const focused = focusManager.getFocused();
        if (focused && document.contains(focused)) return;
        const el = this._currentElement();
        if (el) focusManager.focusElement(el, { skipScroll: true });
    }

    _focusEl(el) {
        this._focusIndex = parseInt(el.dataset.index, 10);
        this._focusSeg = el.dataset.seg !== undefined ? parseInt(el.dataset.seg, 10) : -1;
        focusManager.focusElement(el, { skipScroll: true });
        this._notifyFocus();
    }

    _notifyFocus() {
        if (!this.options.onFocusProgram) return;
        const channel = this._channels[this._focusIndex];
        if (!channel) return;
        let program = null;
        if (this._focusSeg >= 0) {
            const seg = this._segmentsFor(channel)[this._focusSeg];
            program = seg ? seg.program : null;
        } else {
            program = dtvStore.getNowNext(channel).now;
        }
        this.options.onFocusProgram(channel, program);
    }

    _move(direction, current) {
        if (!current || current.dataset.index === undefined) return false;
        const index = parseInt(current.dataset.index, 10);
        const isChannel = current.classList.contains('dtv-guide-ch');

        if (direction === 'up' || direction === 'down') {
            const target = index + (direction === 'down' ? 1 : -1);
            if (target < 0) {
                if (this.options.leaveUp) focusManager.setActiveSection(this.options.leaveUp, true, current);
                return true;
            }
            if (target >= this._channels.length) return true;
            if (isChannel) {
                const row = this._rowAt(target);
                if (row) this._focusEl(row.channelEl);
            } else {
                const segIndex = segmentIndexAt(this._segmentsFor(this._channels[target]), this._focusTime);
                const cell = this._cellFor(target, segIndex);
                if (cell) this._focusEl(cell);
            }
            return true;
        }

        if (isChannel) {
            if (direction === 'right') {
                // Enter the grid at "now" (or the left edge when browsing ahead)
                this._focusTime = Math.max(Date.now(), this._viewStart);
                const segIndex = segmentIndexAt(this._segmentsFor(this._channels[index]), this._focusTime);
                const cell = this._cellFor(index, segIndex);
                if (cell) this._focusEl(cell);
            } else if (this.options.leaveLeft) {
                focusManager.setActiveSection(this.options.leaveLeft, true, current, { direction: 'left' });
            }
            return true;
        }

        const segIndex = parseInt(current.dataset.seg, 10);
        const segments = this._segmentsFor(this._channels[index]);
        const targetSeg = segIndex + (direction === 'right' ? 1 : -1);

        if (targetSeg < 0) {
            const row = this._rowAt(index);
            if (row) this._focusEl(row.channelEl);
            return true;
        }
        if (targetSeg >= segments.length) return true;

        const cell = this._cellFor(index, targetSeg);
        if (cell) {
            this._focusTime = Math.max(segments[targetSeg].start, this._viewStart);
            this._focusEl(cell);
        }
        return true;
    }

    _onClick(e) {
        const target = e.target.closest('.dtv-guide-ch, .dtv-cell');
        if (!target) return;
        const channel = this._channels[parseInt(target.dataset.index, 10)];
        if (channel) this.options.onPlay(channel);
    }
}

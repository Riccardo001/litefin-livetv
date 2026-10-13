/**
 * ============================================================================
 * Litefin Tizen - Dispatcharr Group Bar
 * ============================================================================
 * Horizontal row of list "chips": All channels, Favorites, then the
 * Dispatcharr groups in their order. Moving focus onto a chip selects it
 * after a short pause (so holding Left/Right does not rebuild the list at
 * every step); OK selects immediately. The track slides with translate3d.
 * ============================================================================
 */

import { focusManager } from '../../ui/FocusManager.js';
import { escapeHtml } from '../../utils/Utils.js';

const SELECT_DELAY = 400;
const EDGE_PADDING = 40;

export default class DtvGroupBar {
    /**
     * @param {HTMLElement} container
     * @param {Object} options
     * @param {string} options.sectionName - FocusManager section name
     * @param {string} [options.leaveLeft] - Section reached by Left on the first chip
     * @param {string} [options.leaveDown] - Section reached by Down
     * @param {function(string): void} options.onSelect - Called with the list id
     */
    constructor(container, options) {
        this.container = container;
        this.options = options;
        this._lists = [];
        this._activeId = null;
        this._offset = 0;
        this._selectTimer = null;

        this.container.innerHTML = '<div class="dtv-groupbar"><div class="dtv-groupbar-track"></div></div>';
        this._viewport = this.container.querySelector('.dtv-groupbar');
        this._track = this.container.querySelector('.dtv-groupbar-track');

        this._onClick = (e) => {
            const chip = e.target.closest('.dtv-chip');
            if (chip) this._select(chip.dataset.list, true);
        };
        this._track.addEventListener('click', this._onClick);

        focusManager.register(options.sectionName, this._viewport, {
            orientation: 'horizontal',
            selector: '.dtv-chip',
            leaveLeft: options.leaveLeft || null,
            leaveDown: options.leaveDown || null,
            onMove: (direction, current) => this._move(direction, current),
            onEnter: () => this._chipFor(this._activeId)
        });
    }

    /**
     * Render the chips.
     * @param {Array<{id: string, name: string, channelIds: Array}>} lists
     * @param {string} activeId
     */
    setLists(lists, activeId) {
        this._lists = lists || [];
        this._activeId = activeId;
        this._track.innerHTML = this._lists
            .map(
                (list) => `
                <div class="dtv-chip${list.id === activeId ? ' active' : ''}" tabindex="0" data-list="${escapeHtml(list.id)}">
                    <span class="dtv-chip-name">${escapeHtml(list.name)}</span>
                    <span class="dtv-chip-count">${list.channelIds.length}</span>
                </div>`
            )
            .join('');
        focusManager.invalidateCache(this.options.sectionName);
        this._reveal(this._chipFor(activeId));
    }

    /** Mark a chip as the selected list without firing onSelect. */
    setActive(id) {
        this._activeId = id;
        const chips = this._track.querySelectorAll('.dtv-chip');
        for (let i = 0; i < chips.length; i++) {
            chips[i].classList.toggle('active', chips[i].dataset.list === id);
        }
    }

    /** Focus the selected chip. */
    focusActive() {
        const chip = this._chipFor(this._activeId);
        if (chip) this._focus(chip);
    }

    destroy() {
        clearTimeout(this._selectTimer);
        this._track.removeEventListener('click', this._onClick);
        focusManager.unregister(this.options.sectionName);
        this.container.innerHTML = '';
    }

    // ========================================================================
    // Internals
    // ========================================================================

    _chipFor(id) {
        const chips = this._track.querySelectorAll('.dtv-chip');
        for (let i = 0; i < chips.length; i++) {
            if (chips[i].dataset.list === id) return chips[i];
        }
        return chips[0] || null;
    }

    _move(direction, current) {
        if (direction !== 'left' && direction !== 'right') return false;
        if (!current || !current.classList.contains('dtv-chip')) return false;

        const next = direction === 'right' ? current.nextElementSibling : current.previousElementSibling;
        if (next) {
            this._focus(next);
            this._scheduleSelect(next.dataset.list);
            return true;
        }
        if (direction === 'left' && this.options.leaveLeft) {
            focusManager.setActiveSection(this.options.leaveLeft, true, current, { direction: 'left' });
        }
        return true;
    }

    _focus(chip) {
        focusManager.focusElement(chip, { skipScroll: true });
        this._reveal(chip);
    }

    _reveal(chip) {
        if (!chip) return;
        const viewWidth = this._viewport.clientWidth;
        if (!viewWidth) return;
        const left = chip.offsetLeft;
        const right = left + chip.offsetWidth;
        let offset = this._offset;

        if (left - EDGE_PADDING < offset) {
            offset = left - EDGE_PADDING;
        } else if (right + EDGE_PADDING > offset + viewWidth) {
            offset = right + EDGE_PADDING - viewWidth;
        }
        const maxOffset = Math.max(0, this._track.scrollWidth - viewWidth);
        offset = Math.max(0, Math.min(offset, maxOffset));

        if (offset !== this._offset) {
            this._offset = offset;
            this._track.style.transform = `translate3d(${-offset}px, 0, 0)`;
        }
    }

    _scheduleSelect(id) {
        clearTimeout(this._selectTimer);
        this._selectTimer = setTimeout(() => this._select(id, false), SELECT_DELAY);
    }

    _select(id, immediate) {
        clearTimeout(this._selectTimer);
        if (!id) return;
        if (id === this._activeId && !immediate) return;
        this.setActive(id);
        this.options.onSelect(id, immediate);
    }
}

/**
 * ============================================================================
 * Litefin Tizen - Dispatcharr Live TV Page
 * ============================================================================
 * Entry point of the Dispatcharr-based Live TV section (route /tv):
 *  - View switch: channel list or EPG guide.
 *  - Group bar: All channels, Favorites, then Dispatcharr groups.
 *  - Content: virtualized channel list or guide for the selected list.
 *
 * The page is fully independent from Jellyfin Live TV (/livetv).
 * ============================================================================
 */

import Page from './Page.js';
import { focusManager } from '../ui/FocusManager.js';
import { router } from '../core/Router.js';
import { storage } from '../utils/StorageService.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';
import { escapeHtml } from '../utils/Utils.js';
import { dtvStore } from '../livetv/DtvStore.js';
import { DTV_KEYS, isConfigured } from '../livetv/DtvSettings.js';
import { LIST_ALL, LIST_FAVORITES } from '../livetv/DtvModel.js';
import DtvGroupBar from '../components/dtv/DtvGroupBar.js';
import DtvChannelList from '../components/dtv/DtvChannelList.js';
import DtvGuide from '../components/dtv/DtvGuide.js';
import { errorMessage, formatRange, programTitle } from '../components/dtv/DtvTemplates.js';

const log = logger.create('DtvPage');

const VIEW_LIST = 'list';
const VIEW_GUIDE = 'guide';

const SECTION_VIEWS = 'dtv-views';
const SECTION_GROUPS = 'dtv-groups';
const SECTION_LIST = 'dtv-list';
const SECTION_GUIDE = 'dtv-guide';
const SECTION_STATE = 'dtv-state';

const HOUR = 60 * 60 * 1000;

class DtvPage extends Page {
    constructor(options = {}) {
        super(options);
        this.title = i18n.t('DtvTitle');
        this._isAsyncPage = true;

        this._view = storage.getItem(DTV_KEYS.LAST_VIEW) === VIEW_GUIDE ? VIEW_GUIDE : VIEW_LIST;
        this._listId = storage.getItem(DTV_KEYS.LAST_LIST) || LIST_ALL;
        this._restoreChannelId = null;
        this._returnFromPlayer = false;
        this._launchedPlayer = false;
        this._hasFocusedContent = false;

        this._groupBar = null;
        this._content = null; // DtvChannelList or DtvGuide
        this._timers = [];
    }

    // ========================================================================
    // Navigation State
    // ========================================================================

    getNavigationState() {
        return {
            view: this._view,
            listId: this._listId,
            channelId: this._content ? this._content.getFocusedChannelId() : null,
            launchedPlayer: this._launchedPlayer
        };
    }

    setNavigationState(state) {
        if (!state) return;
        if (state.view === VIEW_GUIDE || state.view === VIEW_LIST) this._view = state.view;
        if (state.listId) this._listId = state.listId;
        this._restoreChannelId = state.channelId != null ? state.channelId : null;
        this._returnFromPlayer = !!state.launchedPlayer;
    }

    // ========================================================================
    // Rendering
    // ========================================================================

    render() {
        return `
            <div class="page dtv-page">
                <div class="dtv-toolbar">
                    <div class="dtv-views" id="dtv-views">
                        <div class="dtv-view-btn" tabindex="0" data-view="${VIEW_LIST}">${i18n.t('Channels')}</div>
                        <div class="dtv-view-btn" tabindex="0" data-view="${VIEW_GUIDE}">${i18n.t('Guide')}</div>
                    </div>
                    <div class="dtv-groups-host" id="dtv-groups-host"></div>
                </div>
                <div class="dtv-banner" id="dtv-banner"></div>
                <div class="dtv-details" id="dtv-details"></div>
                <div class="dtv-body" id="dtv-body">
                    <div class="dtv-content-host" id="dtv-content-host"></div>
                    <div class="dtv-state" id="dtv-state"></div>
                </div>
            </div>
        `;
    }

    async onInit() {
        // This page restores its own focus/scroll (virtualized content)
        this._pendingNavState = null;

        this._setupViewSwitch();
        this._groupBar = new DtvGroupBar(this.$('#dtv-groups-host'), {
            sectionName: SECTION_GROUPS,
            leaveLeft: SECTION_VIEWS,
            leaveDown: this._contentSection(),
            onSelect: (listId, immediate) => this._selectList(listId, immediate)
        });
        this._applyViewClasses();

        this.on('dtv:channelsUpdated', () => this._renderContent());
        this.on('dtv:favoritesChanged', () => this._onFavoritesChanged());
        this.on('dtv:programsUpdated', () => {
            if (this._content instanceof DtvChannelList) this._content.refreshPrograms();
            this._updateEpgBanner();
        });

        // Keep "now" info and progress bars fresh
        this._timers.push(
            setInterval(() => {
                if (this._content instanceof DtvChannelList) this._content.refreshPrograms();
                this._loadNowPrograms();
            }, 60000)
        );

        if (!isConfigured()) {
            this._showState({
                title: i18n.t('DtvNotConfiguredTitle'),
                text: i18n.t('DtvNotConfiguredText'),
                showRetry: false
            });
            this.markReady();
            return;
        }

        const hasCache = dtvStore.loadCachedChannels();
        if (hasCache) {
            this._renderContent();
        } else {
            this._showState({ title: i18n.t('DtvLoading'), loading: true });
        }
        this.markReady();

        await this._loadChannels(hasCache);
        this._loadNowPrograms();
    }

    destroy() {
        this._timers.forEach((id) => clearInterval(id));
        this._timers = [];
        if (this._content) this._content.destroy();
        if (this._groupBar) this._groupBar.destroy();
        this._content = null;
        this._groupBar = null;
        super.destroy();
    }

    // ========================================================================
    // Data Loading
    // ========================================================================

    async _loadChannels(hasCache) {
        try {
            // Refresh even when the cache was shown, but reuse fresh data
            await dtvStore.ensureChannels({ force: hasCache && dtvStore.isFromCache });
            this._setBanner('');
            if (!dtvStore.channels.length) {
                this._showState({ title: i18n.t('DtvNoChannels'), showRetry: true, showSettings: true });
            }
        } catch (err) {
            log.warn('Channel load failed:', err && err.message);
            if (dtvStore.channels.length) {
                this._setBanner(`${errorMessage(err)} ${i18n.t('DtvCachedBanner')}`);
            } else {
                this._showState({
                    title: i18n.t('DtvErrorTitle'),
                    text: errorMessage(err),
                    showRetry: true,
                    showSettings: true
                });
            }
        }
    }

    _loadNowPrograms() {
        if (!dtvStore.channels.length) return;
        const now = Date.now();
        dtvStore.ensurePrograms(now - HOUR, now + 4 * HOUR).then(() => this._updateEpgBanner());
    }

    _updateEpgBanner() {
        if (dtvStore.epgError && !dtvStore.isFromCache) {
            this._setBanner(i18n.t('DtvGuideUnavailable'));
        } else if (!dtvStore.isFromCache) {
            this._setBanner('');
        }
    }

    // ========================================================================
    // Content
    // ========================================================================

    _contentSection() {
        return this._view === VIEW_GUIDE ? SECTION_GUIDE : SECTION_LIST;
    }

    _renderContent() {
        if (!this._groupBar || !dtvStore.channels.length) return;

        const lists = dtvStore.getLists();
        if (!lists.some((l) => l.id === this._listId)) this._listId = LIST_ALL;

        // Do not rebuild the chips under the user's focus
        if (focusManager.getActiveSection() !== SECTION_GROUPS) {
            this._groupBar.setLists(lists, this._listId);
        } else {
            this._groupBar.setActive(this._listId);
        }

        this._showListChannels();
    }

    _showListChannels(focusId) {
        const ids = dtvStore.getListChannelIds(this._listId);
        const channels = ids.map((id) => dtvStore.getChannel(id)).filter(Boolean);

        if (!channels.length) {
            this._destroyContent();
            this._showState({
                title: this._listId === LIST_FAVORITES ? i18n.t('DtvEmptyFavorites') : i18n.t('DtvEmptyList'),
                showRetry: false
            });
            return;
        }
        this._hideState();

        if (!this._content) this._createContent();

        let target = focusId;
        if (target == null && !this._hasFocusedContent) {
            const last = this._returnFromPlayer ? dtvStore.getLastChannel() : null;
            target = last ? last.id : this._restoreChannelId;
            if (target == null) {
                const lastWatched = dtvStore.getLastChannel();
                target = lastWatched ? lastWatched.id : null;
            }
        }
        this._content.setChannels(channels, target);

        if (!this._hasFocusedContent) {
            this._hasFocusedContent = true;
            this._content.focus();
        }
    }

    _createContent() {
        const host = this.$('#dtv-content-host');
        const common = {
            leaveUp: SECTION_GROUPS,
            leaveLeft: 'sidebar',
            onPlay: (channel) => this._play(channel)
        };
        if (this._view === VIEW_GUIDE) {
            this._content = new DtvGuide(host, {
                ...common,
                sectionName: SECTION_GUIDE,
                onFocusProgram: (channel, program) => this._showDetails(channel, program)
            });
        } else {
            this._content = new DtvChannelList(host, { ...common, sectionName: SECTION_LIST });
        }
    }

    _destroyContent() {
        if (this._content) {
            this._content.destroy();
            this._content = null;
        }
    }

    _selectList(listId, immediate) {
        this._listId = listId;
        storage.setItem(DTV_KEYS.LAST_LIST, listId);
        this._showListChannels(null);
        // OK on a chip jumps straight into the list
        if (immediate && this._content) this._content.focus();
    }

    _onFavoritesChanged() {
        const lists = dtvStore.getLists();
        if (focusManager.getActiveSection() !== SECTION_GROUPS) {
            this._groupBar.setLists(lists, this._listId);
        }
        if (this._listId === LIST_FAVORITES && this._content) {
            const focusedId = this._content.getFocusedChannelId();
            const ids = dtvStore.getListChannelIds(LIST_FAVORITES);
            // Removing a favorite while viewing Favorites: keep the cursor nearby
            const keepId = ids.indexOf(focusedId) !== -1 ? focusedId : ids[0];
            this._showListChannels(keepId);
            if (this._content) this._content.focus(keepId);
            else this._groupBar.focusActive();
        } else if (this._content instanceof DtvChannelList) {
            this._content.refreshFavorites();
        }
    }

    // ========================================================================
    // View Switch
    // ========================================================================

    _setupViewSwitch() {
        const views = this.$('#dtv-views');
        views.addEventListener('click', (e) => {
            const btn = e.target.closest('.dtv-view-btn');
            if (btn) this._switchView(btn.dataset.view);
        });
        this.registerFocusSection(SECTION_VIEWS, views, {
            orientation: 'horizontal',
            selector: '.dtv-view-btn',
            leaveLeft: 'sidebar',
            leaveRight: SECTION_GROUPS,
            enterTo: 'active-element',
            onMove: (direction) => {
                if (direction === 'down' && this._content) {
                    focusManager.setActiveSection(this._contentSection());
                    return true;
                }
                return false;
            }
        });
    }

    _switchView(view) {
        if (view === this._view) {
            if (this._content) this._content.focus();
            return;
        }
        const focusedId = this._content ? this._content.getFocusedChannelId() : null;
        this._view = view;
        storage.setItem(DTV_KEYS.LAST_VIEW, view);
        this._destroyContent();
        this._applyViewClasses();

        // Group bar "Down" must now lead to the new content section
        const config = focusManager.getConfig(SECTION_GROUPS);
        if (config) config.leaveDown = this._contentSection();

        if (dtvStore.channels.length) {
            this._showListChannels(focusedId);
            if (this._content) this._content.focus(focusedId);
        }
    }

    _applyViewClasses() {
        const page = this.el;
        page.classList.toggle('dtv-view-guide', this._view === VIEW_GUIDE);
        const buttons = this.$$('.dtv-view-btn');
        for (let i = 0; i < buttons.length; i++) {
            buttons[i].classList.toggle('active', buttons[i].dataset.view === this._view);
        }
        if (this._view !== VIEW_GUIDE) this.$('#dtv-details').innerHTML = '';
    }

    // ========================================================================
    // Guide Details Panel
    // ========================================================================

    _showDetails(channel, program) {
        const panel = this.$('#dtv-details');
        if (!panel || this._view !== VIEW_GUIDE) return;
        const title = program ? programTitle(program) : i18n.t('DtvNoProgramInfo');
        panel.innerHTML = `
            <div class="dtv-details-channel">${escapeHtml(channel.numberLabel)} ${escapeHtml(channel.name)}</div>
            <div class="dtv-details-title">${escapeHtml(title)}</div>
            <div class="dtv-details-time">${program ? escapeHtml(formatRange(program)) : ''}</div>
            <div class="dtv-details-desc">${program ? escapeHtml(program.description) : ''}</div>
        `;
    }

    // ========================================================================
    // Banner & State Panel
    // ========================================================================

    _setBanner(text) {
        const banner = this.$('#dtv-banner');
        if (!banner) return;
        banner.textContent = text || '';
        banner.classList.toggle('visible', !!text);
    }

    /**
     * Full-area message (loading, empty list, error, not configured).
     * @param {Object} state - {title, text, loading, showRetry, showSettings}
     */
    _showState(state) {
        const el = this.$('#dtv-state');
        if (!el) return;
        const buttons = [];
        if (state.showRetry) {
            buttons.push(`<div class="dtv-state-btn" tabindex="0" data-action="retry">${i18n.t('Retry')}</div>`);
        }
        if (state.showSettings !== false && !state.loading && (state.showSettings || !isConfigured())) {
            buttons.push(
                `<div class="dtv-state-btn" tabindex="0" data-action="settings">${i18n.t('DtvOpenSettings')}</div>`
            );
        }

        el.innerHTML = `
            ${state.loading ? '<div class="loading-spinner"></div>' : ''}
            <div class="dtv-state-title">${escapeHtml(state.title || '')}</div>
            ${state.text ? `<div class="dtv-state-text">${escapeHtml(state.text)}</div>` : ''}
            ${buttons.length ? `<div class="dtv-state-actions">${buttons.join('')}</div>` : ''}
        `;
        el.classList.add('visible');

        if (!el._dtvBound) {
            el._dtvBound = true;
            el.addEventListener('click', (e) => {
                const btn = e.target.closest('.dtv-state-btn');
                if (!btn) return;
                if (btn.dataset.action === 'retry') this._retry();
                else router.navigate('/settings?tab=livetv');
            });
        }

        if (buttons.length) {
            this.unregisterFocusSection(SECTION_STATE);
            this.registerFocusSection(SECTION_STATE, el, {
                orientation: 'horizontal',
                selector: '.dtv-state-btn',
                leaveUp: SECTION_GROUPS,
                leaveLeft: 'sidebar'
            });
            focusManager.setActiveSection(SECTION_STATE);
        }
    }

    _hideState() {
        const el = this.$('#dtv-state');
        if (!el) return;
        el.classList.remove('visible');
        el.innerHTML = '';
        this.unregisterFocusSection(SECTION_STATE);
    }

    async _retry() {
        if (!isConfigured()) return;
        this._showState({ title: i18n.t('DtvLoading'), loading: true });
        await this._loadChannels(false);
        if (dtvStore.channels.length) {
            this._renderContent();
            this._loadNowPrograms();
        }
    }

    // ========================================================================
    // Playback
    // ========================================================================

    _play(channel) {
        this._launchedPlayer = true;
        storage.setItem(DTV_KEYS.LAST_LIST, this._listId);
        router.navigate(`/tv/play/${encodeURIComponent(channel.uuid)}?list=${encodeURIComponent(this._listId)}`);
    }
}

export default DtvPage;

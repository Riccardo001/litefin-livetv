/**
 * ============================================================================
 * Litefin Tizen - Dispatcharr Live Player Page
 * ============================================================================
 * Full-screen live playback for Dispatcharr channels (route /tv/play/:uuid).
 * Uses Litefin's playback engines through LiveStreamPlayer and owns all
 * remote keys while open (FocusManager is suspended, like PlayerPage):
 *
 *   Up / CH+        next channel in the list the user started from
 *   Down / CH-      previous channel (both wrap around)
 *   Left / PRE-CH   last watched channel
 *   Right           toggle favorite
 *   OK / Info       show or hide the info banner (OK retries after an error)
 *   Back            hide the banner, otherwise return to the guide
 *
 * Up/Down only move the banner selection; the stream switches after a short
 * pause (see DtvZapper) so fast zapping does not open a stream per press.
 * ============================================================================
 */

import Page from './Page.js';
import { focusManager } from '../ui/FocusManager.js';
import { globalClock } from '../ui/GlobalClock.js';
import { eventBus } from '../core/EventBus.js';
import { router } from '../core/Router.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';
import { platformInfo } from '../utils/PlatformInfo.js';
import { dtvStore } from '../livetv/DtvStore.js';
import { DtvZapper } from '../livetv/DtvZapper.js';
import { LiveStreamPlayer, LIVE_STATE } from '../livetv/LiveStreamPlayer.js';
import { LIST_ALL } from '../livetv/DtvModel.js';
import DtvZapOverlay from '../components/dtv/DtvZapOverlay.js';
import { errorMessage } from '../components/dtv/DtvTemplates.js';

const log = logger.create('DtvPlayerPage');

const HOUR = 60 * 60 * 1000;

// Remote keys only delivered to the app after registration on Tizen
const TIZEN_EXTRA_KEYS = ['ChannelUp', 'ChannelDown', 'PreviousChannel'];
const KEYCODE_PREVIOUS_CHANNEL = 10190;
// Browser keyboard: PageUp / PageDown act as CH+ / CH- (webOS already maps them)
const KEYCODE_PAGE_UP = 33;
const KEYCODE_PAGE_DOWN = 34;

class DtvPlayerPage extends Page {
    constructor(options = {}) {
        super(options);
        this.title = i18n.t('DtvTitle');
        this._player = null;
        this._overlay = null;
        this._zapper = null;
        this._channel = null;
        this._listId = LIST_ALL;
        this._listName = '';
        this._state = LIVE_STATE.IDLE;
        this._registeredKeys = [];
    }

    render() {
        return `
            <div class="page player-page dtv-player-page">
                <div class="player-container" id="dtv-player-container"></div>
            </div>
        `;
    }

    async onInit() {
        // Transparent page so Tizen's AVPlay hardware plane shows through
        document.body.classList.add('player-active');
        document.documentElement.classList.add('player-active');
        // The info banner has its own clock, shown only with the banner
        globalClock.setVisibility(false);
        focusManager.suspend();
        this._registerTizenKeys();

        this._overlay = new DtvZapOverlay(this.el);
        this._player = new LiveStreamPlayer({
            container: this.$('#dtv-player-container'),
            onState: (state, detail) => this._onPlayerState(state, detail)
        });
        this._bindKeys();

        this.on('app:hidden', () => this._onAppHidden());
        this.on('app:visible', () => this._onAppVisible());
        this.on('dtv:programsUpdated', () => {
            if (this._overlay.isVisible) this._overlay.refresh();
        });

        this.markReady();

        const uuid = this.params.id ? decodeURIComponent(this.params.id) : '';
        this._listId = this.params.list ? decodeURIComponent(this.params.list) : LIST_ALL;

        const channel = await this._resolveChannel(uuid);
        if (!channel) return;

        const lists = dtvStore.getLists();
        const list = lists.find((l) => l.id === this._listId) || lists[0];
        let ids = list ? list.channelIds : [];
        if (ids.indexOf(channel.id) === -1) {
            // Channel not in the requested list (e.g. removed from favorites)
            this._listId = LIST_ALL;
            ids = dtvStore.getListChannelIds(LIST_ALL);
        }
        this._listName = (lists.find((l) => l.id === this._listId) || {}).name || '';

        const previous = dtvStore.getLastChannel();
        this._zapper = new DtvZapper({
            ids,
            currentId: channel.id,
            previousId: previous && previous.id !== channel.id ? previous.id : null,
            onCommit: (id) => this._switchTo(dtvStore.getChannel(id))
        });

        dtvStore.rememberWatched(channel, previous && previous.id !== channel.id ? previous : null);
        this._startChannel(channel);
    }

    destroy() {
        if (this._zapper) this._zapper.destroy();
        if (this._overlay) this._overlay.destroy();
        if (this._player) {
            this._player.destroy().catch((err) => log.warn('Player destroy failed:', err && err.message));
        }
        this._unregisterTizenKeys();
        document.body.classList.remove('player-active');
        document.documentElement.classList.remove('player-active');
        globalClock.setVisibility(true);
        focusManager.resume();
        eventBus.emit('player:stopped');
        super.destroy();
    }

    // ========================================================================
    // Channel Resolution & Switching
    // ========================================================================

    async _resolveChannel(uuid) {
        dtvStore.loadCachedChannels();
        let channel = dtvStore.getChannelByUuid(uuid);
        if (channel) return channel;

        try {
            await dtvStore.ensureChannels();
        } catch (err) {
            this._overlay.setMessage(errorMessage(err), i18n.t('DtvPlayerBackHint'));
            return null;
        }
        channel = dtvStore.getChannelByUuid(uuid);
        if (!channel) this._overlay.setMessage(i18n.t('DtvChannelNotFound'), i18n.t('DtvPlayerBackHint'));
        return channel;
    }

    _startChannel(channel) {
        this._channel = channel;
        this._overlay.setMessage('');
        this._overlay.show(channel, { listName: this._listName, sticky: true });
        const now = Date.now();
        dtvStore.ensurePrograms(now - HOUR, now + 4 * HOUR);
        this._player.play(channel);
    }

    _switchTo(channel) {
        if (!channel) return;
        dtvStore.rememberWatched(channel, this._channel);
        this._startChannel(channel);
    }

    // ========================================================================
    // Player State
    // ========================================================================

    _onPlayerState(state, detail) {
        this._state = state;
        switch (state) {
            case LIVE_STATE.CONNECTING:
                this._overlay.setStatus(
                    detail && detail.attempt
                        ? `${i18n.t('DtvConnecting')} (${detail.attempt + 1})`
                        : i18n.t('DtvConnecting'),
                    true
                );
                break;
            case LIVE_STATE.RECONNECTING:
                this._overlay.setStatus(i18n.t('DtvReconnecting'), true);
                this._overlay.show(this._channel, { sticky: true });
                break;
            case LIVE_STATE.BUFFERING:
                this._overlay.setStatus(i18n.t('DtvBuffering'), false);
                break;
            case LIVE_STATE.PLAYING:
                this._overlay.setStatus('', false);
                this._overlay.setMessage('');
                eventBus.emit('player:playing');
                break;
            case LIVE_STATE.ERROR:
                this._overlay.setStatus('', true);
                this._overlay.show(this._channel, { sticky: true });
                this._overlay.setMessage(i18n.t('DtvChannelNotResponding'), i18n.t('DtvPlayerErrorHint'));
                eventBus.emit('player:paused');
                break;
            default:
                break;
        }
    }

    _onAppHidden() {
        // Release the provider slot and decoder while in background
        if (this._player) this._player.stop();
    }

    _onAppVisible() {
        if (this._player && this._channel) this._startChannel(this._channel);
    }

    // ========================================================================
    // Remote Keys
    // ========================================================================

    _bindKeys() {
        this.on('key:up', (e) => this._zap(1, e));
        this.on('key:down', (e) => this._zap(-1, e));
        this.on('key:channelUp', (e) => this._zap(1, e));
        this.on('key:channelDown', (e) => this._zap(-1, e));
        this.on('key:left', (e) => this._lastChannel(e));
        this.on('key:right', (e) => this._toggleFavorite(e));
        this.on('key:enter', (e) => this._onEnter(e));
        this.on('key:info', () => this._toggleOverlay());
        this.on('key:stop', () => router.back());
        this.on('key:any', (payload) => {
            const keyCode = payload && payload.keyCode;
            if (keyCode === KEYCODE_PREVIOUS_CHANNEL) this._lastChannel(payload.event);
            else if (!platformInfo.isWebOS && keyCode === KEYCODE_PAGE_UP) this._zap(1, payload.event);
            else if (!platformInfo.isWebOS && keyCode === KEYCODE_PAGE_DOWN) this._zap(-1, payload.event);
        });
    }

    onBack() {
        if (this._overlay && this._overlay.isVisible && this._state !== LIVE_STATE.ERROR) {
            this._overlay.hide();
            return true;
        }
        return false; // App falls back to router.back() → guide
    }

    _zap(step, e) {
        if (e && e.preventDefault) e.preventDefault();
        if (!this._zapper) return;
        const id = this._zapper.step(step);
        const channel = id != null ? dtvStore.getChannel(id) : null;
        if (channel) {
            this._overlay.setMessage('');
            this._overlay.show(channel, { sticky: false });
        }
    }

    _lastChannel(e) {
        if (e && e.preventDefault) e.preventDefault();
        if (!this._zapper) return;
        if (this._zapper.jumpToPrevious() == null) {
            this._overlay.show(this._channel);
        }
    }

    _toggleFavorite(e) {
        if (e && e.preventDefault) e.preventDefault();
        const channel = this._zapper ? dtvStore.getChannel(this._zapper.displayedId) : this._channel;
        if (!channel) return;
        const isFavorite = dtvStore.toggleFavorite(channel);
        this._overlay.toast(i18n.t(isFavorite ? 'DtvFavoriteAdded' : 'DtvFavoriteRemoved'));
        this._overlay.show(channel);
    }

    _onEnter(e) {
        if (e && e.preventDefault) e.preventDefault();
        if (this._zapper && this._zapper.isPending) {
            // OK confirms the channel shown in the banner right away
            this._zapper.commit();
            return;
        }
        if (this._state === LIVE_STATE.ERROR && this._channel) {
            this._startChannel(this._channel);
            return;
        }
        this._toggleOverlay();
    }

    _toggleOverlay() {
        if (!this._channel) return;
        if (this._overlay.isVisible) this._overlay.hide();
        else this._overlay.show(this._channel);
    }

    // ========================================================================
    // Tizen Key Registration
    // ========================================================================

    _registerTizenKeys() {
        if (!platformInfo.isTizen || typeof tizen === 'undefined' || !tizen.tvinputdevice) return;
        TIZEN_EXTRA_KEYS.forEach((key) => {
            try {
                tizen.tvinputdevice.registerKey(key);
                this._registeredKeys.push(key);
            } catch (e) {
                // Key not available on this remote/model
            }
        });
    }

    _unregisterTizenKeys() {
        if (!this._registeredKeys.length) return;
        this._registeredKeys.forEach((key) => {
            try {
                tizen.tvinputdevice.unregisterKey(key);
            } catch (e) {}
        });
        this._registeredKeys = [];
    }
}

export default DtvPlayerPage;

/**
 * ============================================================================
 * Litefin Tizen - Dispatcharr Live TV Store
 * ============================================================================
 * Single source of truth for the Dispatcharr Live TV section:
 *  - Channels and groups (stale-while-revalidate: the last list saved on the
 *    device is shown immediately and refreshed in the background).
 *  - EPG programs, fetched in fixed time blocks on demand and merged into a
 *    per-channel timeline.
 *  - Favorites and last/previous channel, stored on the device.
 *
 * Emits on the EventBus:
 *  - 'dtv:channelsUpdated'  after the channel list changes
 *  - 'dtv:programsUpdated'  ({from, to}) after new EPG data is merged
 *  - 'dtv:favoritesChanged' ({uuid, isFavorite})
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { storage } from '../utils/StorageService.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';
import { dispatcharrClient } from '../api/DispatcharrClient.js';
import {
    LIST_ALL,
    LIST_FAVORITES,
    buildGroups,
    createEpgKeyResolver,
    findNextProgram,
    findProgramAt,
    mergePrograms,
    normalizeChannels,
    prunePrograms
} from './DtvModel.js';
import { DTV_KEYS, DTV_SETTINGS_CHANGED, getBaseUrl, getStreamFormat, readJson, writeJson } from './DtvSettings.js';

const log = logger.create('DtvStore');

const HOUR = 60 * 60 * 1000;

// EPG is fetched in aligned blocks so overlapping views reuse the same data.
const EPG_BLOCK = 3 * HOUR;
// Re-fetch an EPG block when it is older than this.
const EPG_BLOCK_TTL = 60 * 60 * 1000;
// Keep this much past EPG in memory.
const EPG_KEEP_PAST = 2 * HOUR;
// Background refresh interval for the channel list.
const CHANNELS_TTL = 10 * 60 * 1000;

class DtvStore {
    constructor() {
        // Favorites survive server changes (they are keyed by channel uuid)
        this._favorites = null;
        this._reset();

        // Connection settings changed: drop everything tied to the old server
        eventBus.on(DTV_SETTINGS_CHANGED, () => {
            log.info('Settings changed, clearing Live TV data');
            this._reset();
            storage.removeItem(DTV_KEYS.CHANNEL_CACHE);
        });

        // Stream format changed: stream URLs must be rebuilt (the cache stays valid)
        eventBus.on(DTV_KEYS.STREAM_FORMAT, () => this._reset());
    }

    _reset() {
        this._channels = [];
        this._byId = new Map();
        this._byUuid = new Map();
        this._groups = [];
        this._channelsLoadedAt = 0;
        this._channelsPromise = null;
        this._fromCache = false;

        this._programs = new Map();
        this._blocks = new Map(); // block start (ms) -> fetchedAt (ms)
        this._pendingBlocks = new Map(); // block start (ms) -> Promise
        this._epgError = null;
    }

    // ========================================================================
    // Channels
    // ========================================================================

    /** @returns {Array<Object>} Ordered channels */
    get channels() {
        return this._channels;
    }

    /** @returns {Array<Object>} Ordered groups ({id, name, channelIds}) */
    get groups() {
        return this._groups;
    }

    /** True when the current list comes from the device cache only. */
    get isFromCache() {
        return this._fromCache;
    }

    /** Last EPG fetch error, if any. */
    get epgError() {
        return this._epgError;
    }

    getChannel(id) {
        return this._byId.get(id) || null;
    }

    getChannelByUuid(uuid) {
        return this._byUuid.get(uuid) || null;
    }

    /**
     * Restore the channel list saved on the device (instant start).
     * @returns {boolean} True when a usable cache was found
     */
    loadCachedChannels() {
        if (this._channels.length) return true;
        const cache = readJson(DTV_KEYS.CHANNEL_CACHE, null);
        if (!cache || cache.baseUrl !== getBaseUrl() || !Array.isArray(cache.summary)) return false;

        const keyByChannel = cache.epgKeys || {};
        this._applyChannels(cache.summary, cache.groups || [], (row) => keyByChannel[row.id] || String(row.uuid));
        this._fromCache = true;
        log.info(`Restored ${this._channels.length} channels from device cache`);
        return true;
    }

    /**
     * Load channels if they are missing or stale.
     * @param {Object} [options]
     * @param {boolean} [options.force] - Ignore the freshness window
     * @returns {Promise<Array>} Channels
     */
    ensureChannels(options = {}) {
        const fresh = this._channelsLoadedAt && Date.now() - this._channelsLoadedAt < CHANNELS_TTL;
        if (fresh && !options.force) return Promise.resolve(this._channels);
        if (this._channelsPromise) return this._channelsPromise;

        this._channelsPromise = this._fetchChannels().then(
            (channels) => {
                this._channelsPromise = null;
                return channels;
            },
            (err) => {
                this._channelsPromise = null;
                throw err;
            }
        );
        return this._channelsPromise;
    }

    async _fetchChannels() {
        const baseUrl = getBaseUrl();
        // EPG mapping is optional: without it every channel falls back to its
        // uuid key (dummy programs still match), so it must not block the list.
        const [summary, groups, epgData, sources] = await Promise.all([
            dispatcharrClient.getChannels(),
            dispatcharrClient.getGroups().catch((err) => {
                log.warn('Groups unavailable:', err.message);
                return [];
            }),
            dispatcharrClient.getEpgData().catch((err) => {
                log.warn('EPG data unavailable:', err.message);
                return [];
            }),
            dispatcharrClient.getEpgSources().catch((err) => {
                log.warn('EPG sources unavailable:', err.message);
                return [];
            })
        ]);

        if (!Array.isArray(summary)) throw new Error('Unexpected channel list');
        if (baseUrl !== getBaseUrl()) return this._channels; // Settings changed meanwhile

        const resolveEpgKey = createEpgKeyResolver(epgData, sources);
        const epgKeys = {};
        summary.forEach((row) => {
            if (row && row.id !== undefined) epgKeys[row.id] = resolveEpgKey(row);
        });

        this._applyChannels(summary, groups, (row) => epgKeys[row.id]);
        this._fromCache = false;
        this._channelsLoadedAt = Date.now();

        // Save only what is needed to rebuild the list offline (no EPG table)
        writeJson(DTV_KEYS.CHANNEL_CACHE, {
            baseUrl,
            savedAt: Date.now(),
            summary,
            groups: (Array.isArray(groups) ? groups : []).map((g) => ({ id: g.id, name: g.name })),
            epgKeys
        });

        log.info(`Loaded ${this._channels.length} channels in ${this._groups.length} groups`);
        return this._channels;
    }

    _applyChannels(summary, groups, resolveEpgKey) {
        const previousKeys = this._channels.map((c) => `${c.id}:${c.epgKey}`).join('|');

        this._channels = normalizeChannels(summary, {
            baseUrl: getBaseUrl(),
            streamFormat: getStreamFormat(),
            resolveEpgKey
        });
        this._byId = new Map(this._channels.map((c) => [c.id, c]));
        this._byUuid = new Map(this._channels.map((c) => [c.uuid, c]));
        this._groups = buildGroups(this._channels, Array.isArray(groups) ? groups : [], i18n.t('DtvOtherGroup'));

        // EPG keys can change when Dispatcharr's EPG mapping changes
        if (previousKeys && previousKeys !== this._channels.map((c) => `${c.id}:${c.epgKey}`).join('|')) {
            this._programs = new Map();
            this._blocks = new Map();
        }

        eventBus.emit('dtv:channelsUpdated');
    }

    // ========================================================================
    // Channel Lists (All, Favorites, Groups)
    // ========================================================================

    /**
     * Lists shown in the group bar, in display order.
     * @returns {Array<{id: string, name: string, channelIds: Array<number>}>}
     */
    getLists() {
        const lists = [
            { id: LIST_ALL, name: i18n.t('DtvAllChannels'), channelIds: this._channels.map((c) => c.id) },
            { id: LIST_FAVORITES, name: i18n.t('Favorites'), channelIds: this.getFavoriteIds() }
        ];
        this._groups.forEach((g) => lists.push({ id: String(g.id), name: g.name, channelIds: g.channelIds }));
        return lists;
    }

    /**
     * Ordered channel ids for a list id.
     * @param {string} listId
     * @returns {Array<number>}
     */
    getListChannelIds(listId) {
        if (listId === LIST_FAVORITES) return this.getFavoriteIds();
        if (listId && listId !== LIST_ALL) {
            const group = this._groups.find((g) => String(g.id) === String(listId));
            if (group) return group.channelIds;
        }
        return this._channels.map((c) => c.id);
    }

    // ========================================================================
    // EPG
    // ========================================================================

    /**
     * Make sure programs covering [from, to) are loaded.
     * Missing blocks are fetched in a single request per contiguous run.
     * @param {number} from - Epoch ms
     * @param {number} to - Epoch ms
     * @returns {Promise<void>}
     */
    ensurePrograms(from, to) {
        const now = Date.now();
        const first = Math.floor(from / EPG_BLOCK) * EPG_BLOCK;
        const waits = [];
        let runStart = null;
        let runEnd = null;

        const flushRun = () => {
            if (runStart === null) return;
            waits.push(this._fetchBlocks(runStart, runEnd));
            runStart = null;
        };

        for (let block = first; block < to; block += EPG_BLOCK) {
            const pending = this._pendingBlocks.get(block);
            const fetchedAt = this._blocks.get(block);
            if (pending) {
                flushRun();
                waits.push(pending);
            } else if (!fetchedAt || now - fetchedAt > EPG_BLOCK_TTL) {
                if (runStart === null) runStart = block;
                runEnd = block + EPG_BLOCK;
            } else {
                flushRun();
            }
        }
        flushRun();

        return Promise.all(waits).then(() => undefined);
    }

    _fetchBlocks(from, to) {
        const baseUrl = getBaseUrl();
        const promise = dispatcharrClient
            .getGrid(from, to)
            .then((rawPrograms) => {
                if (baseUrl !== getBaseUrl()) return;
                mergePrograms(this._programs, rawPrograms);
                prunePrograms(this._programs, Date.now() - EPG_KEEP_PAST);
                const fetchedAt = Date.now();
                for (let block = from; block < to; block += EPG_BLOCK) {
                    this._blocks.set(block, fetchedAt);
                }
                this._epgError = null;
                eventBus.emit('dtv:programsUpdated', { from, to });
            })
            .catch((err) => {
                this._epgError = err;
                log.warn(`EPG fetch failed for ${new Date(from).toISOString()}:`, err.message);
            })
            .then(() => {
                for (let block = from; block < to; block += EPG_BLOCK) {
                    this._pendingBlocks.delete(block);
                }
            });

        for (let block = from; block < to; block += EPG_BLOCK) {
            this._pendingBlocks.set(block, promise);
        }
        return promise;
    }

    /**
     * Program timeline of a channel (sorted, may be empty).
     * @param {Object} channel
     * @returns {Array}
     */
    getPrograms(channel) {
        return (channel && this._programs.get(channel.epgKey)) || [];
    }

    /**
     * Airing and next program of a channel.
     * @param {Object} channel
     * @param {number} [time] - Epoch ms (default now)
     * @returns {{now: Object|null, next: Object|null}}
     */
    getNowNext(channel, time) {
        const at = time || Date.now();
        const list = this.getPrograms(channel);
        return { now: findProgramAt(list, at), next: findNextProgram(list, at) };
    }

    // ========================================================================
    // Favorites (device-local, keyed by channel uuid)
    // ========================================================================

    _favoriteSet() {
        if (!this._favorites) {
            const list = readJson(DTV_KEYS.FAVORITES, []);
            this._favorites = new Set(Array.isArray(list) ? list : []);
        }
        return this._favorites;
    }

    /**
     * Favorite channel ids in channel order.
     * @returns {Array<number>}
     */
    getFavoriteIds() {
        const uuids = this._favoriteSet();
        return this._channels.filter((c) => uuids.has(c.uuid)).map((c) => c.id);
    }

    isFavorite(channel) {
        return !!channel && this._favoriteSet().has(channel.uuid);
    }

    /**
     * Add or remove a channel from favorites.
     * @param {Object} channel
     * @returns {boolean} New favorite state
     */
    toggleFavorite(channel) {
        if (!channel) return false;
        const uuids = this._favoriteSet();
        const isFavorite = !uuids.has(channel.uuid);
        if (isFavorite) uuids.add(channel.uuid);
        else uuids.delete(channel.uuid);
        writeJson(DTV_KEYS.FAVORITES, Array.from(uuids));
        storage.flush();
        eventBus.emit('dtv:favoritesChanged', { uuid: channel.uuid, isFavorite });
        return isFavorite;
    }

    // ========================================================================
    // Last / Previous Channel
    // ========================================================================

    /**
     * Remember the channel being watched and the one before it.
     * @param {Object} channel - Channel now playing
     * @param {Object|null} previous - Channel watched before it
     */
    rememberWatched(channel, previous) {
        if (channel) storage.setItem(DTV_KEYS.LAST_CHANNEL, channel.uuid);
        if (previous) storage.setItem(DTV_KEYS.PREVIOUS_CHANNEL, previous.uuid);
    }

    /** @returns {Object|null} Last watched channel */
    getLastChannel() {
        return this.getChannelByUuid(storage.getItem(DTV_KEYS.LAST_CHANNEL) || '');
    }

    /** @returns {Object|null} Channel watched before the last one */
    getPreviousChannel() {
        return this.getChannelByUuid(storage.getItem(DTV_KEYS.PREVIOUS_CHANNEL) || '');
    }
}

export const dtvStore = new DtvStore();
export default dtvStore;

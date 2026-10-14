/**
 * ============================================================================
 * Litefin Tizen - Dispatcharr Live TV Settings
 * ============================================================================
 * Storage keys and accessors for the Dispatcharr Live TV section.
 *
 * Every key uses the `dispatcharr:` prefix. StorageService treats the prefix
 * as device-global (not isolated per Jellyfin user) and the settings backup
 * skips it, so the Dispatcharr address and API key never leave the TV.
 * ============================================================================
 */

import { storage } from '../utils/StorageService.js';
import { platformInfo } from '../utils/PlatformInfo.js';
import { normalizeBaseUrl, STREAM_FORMAT_FMP4, STREAM_FORMAT_TS } from './DtvModel.js';

export const DTV_KEY_PREFIX = 'dispatcharr:';

export const DTV_KEYS = {
    URL: 'dispatcharr:url',
    API_KEY: 'dispatcharr:apiKey',
    STREAM_FORMAT: 'dispatcharr:streamFormat',
    SWITCH_DELAY: 'dispatcharr:switchDelay',
    FAVORITES: 'dispatcharr:favorites',
    LAST_CHANNEL: 'dispatcharr:lastChannel',
    PREVIOUS_CHANNEL: 'dispatcharr:previousChannel',
    LAST_LIST: 'dispatcharr:lastList',
    LAST_VIEW: 'dispatcharr:lastView',
    CHANNEL_CACHE: 'dispatcharr:channelCache'
};

/** Stream format setting values ('auto' resolves per platform). */
export const STREAM_FORMAT_AUTO = 'auto';

/** Allowed pauses (ms) between closing a channel and opening the next one. */
export const SWITCH_DELAY_OPTIONS = [500, 1000, 2000, 3000];
export const DEFAULT_SWITCH_DELAY = 1000;

/** Event emitted when the connection settings change. */
export const DTV_SETTINGS_CHANGED = 'dtv:settingsChanged';

/**
 * Saved Dispatcharr base URL (normalized), or ''.
 * @returns {string}
 */
export function getBaseUrl() {
    return normalizeBaseUrl(storage.getItem(DTV_KEYS.URL) || '');
}

/**
 * Saved API key, or ''.
 * @returns {string}
 */
export function getApiKey() {
    return (storage.getItem(DTV_KEYS.API_KEY) || '').trim();
}

/**
 * True when both the address and the API key are set.
 * @returns {boolean}
 */
export function isConfigured() {
    return !!(getBaseUrl() && getApiKey());
}

/**
 * Raw stream format preference ('auto', 'ts' or 'fmp4').
 * @returns {string}
 */
export function getStreamFormatSetting() {
    const value = storage.getItem(DTV_KEYS.STREAM_FORMAT);
    return value === STREAM_FORMAT_TS || value === STREAM_FORMAT_FMP4 ? value : STREAM_FORMAT_AUTO;
}

/**
 * Effective stream format for this device.
 * TVs play Dispatcharr's raw MPEG-TS natively (AVPlay / webOS media
 * pipeline); desktop browsers cannot demux TS in a <video> element, so
 * 'auto' asks Dispatcharr for fragmented MP4 there.
 * @returns {string} STREAM_FORMAT_TS or STREAM_FORMAT_FMP4
 */
export function getStreamFormat() {
    const setting = getStreamFormatSetting();
    if (setting !== STREAM_FORMAT_AUTO) return setting;
    return platformInfo.isTizen || platformInfo.isWebOS ? STREAM_FORMAT_TS : STREAM_FORMAT_FMP4;
}

/**
 * Pause between closing a channel and opening the next one, so Dispatcharr
 * can free the provider slot (IPTV accounts limited to one connection).
 * @returns {number} Milliseconds
 */
export function getSwitchDelay() {
    const value = parseInt(storage.getItem(DTV_KEYS.SWITCH_DELAY), 10);
    return SWITCH_DELAY_OPTIONS.indexOf(value) !== -1 ? value : DEFAULT_SWITCH_DELAY;
}

/**
 * Read a JSON value stored under a Dispatcharr key.
 * @param {string} key
 * @param {*} fallback
 * @returns {*}
 */
export function readJson(key, fallback) {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    try {
        return JSON.parse(raw);
    } catch (e) {
        return fallback;
    }
}

/**
 * Store a JSON value under a Dispatcharr key.
 * @param {string} key
 * @param {*} value
 */
export function writeJson(key, value) {
    storage.setItem(key, JSON.stringify(value));
}

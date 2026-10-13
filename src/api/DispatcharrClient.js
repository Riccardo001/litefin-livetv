/**
 * ============================================================================
 * Litefin Tizen - Dispatcharr REST Client
 * ============================================================================
 * Minimal read-only client for the Dispatcharr REST API used by the Live TV
 * section. Authenticates with a per-user API key.
 *
 * The key is sent as `Authorization: ApiKey <key>` rather than `X-API-Key`:
 * Dispatcharr's CORS layer (django-cors-headers defaults) allows the
 * Authorization header in preflight requests but not X-API-Key, so the latter
 * fails from a browser or from the TV's file:// origin.
 * ============================================================================
 */

import { logger } from '../utils/Logger.js';
import { getApiKey, getBaseUrl } from '../livetv/DtvSettings.js';
import { normalizeBaseUrl } from '../livetv/DtvModel.js';

const log = logger.create('DispatcharrClient');

// Metadata requests are small; the EPG grid can be a few MB on slow TVs.
const REQUEST_TIMEOUT = 15000;
const GRID_TIMEOUT = 30000;

/**
 * Error kinds surfaced to the UI so it can show a specific message.
 */
export const DTV_ERROR = {
    NOT_CONFIGURED: 'not-configured',
    UNAUTHORIZED: 'unauthorized',
    FORBIDDEN: 'forbidden',
    NOT_FOUND: 'not-found',
    NETWORK: 'network',
    TIMEOUT: 'timeout',
    SERVER: 'server',
    BAD_RESPONSE: 'bad-response'
};

/**
 * Error raised by every DispatcharrClient request.
 */
export class DispatcharrError extends Error {
    /**
     * @param {string} kind - One of DTV_ERROR
     * @param {string} message
     * @param {number} [status] - HTTP status when available
     */
    constructor(kind, message, status) {
        super(message);
        this.name = 'DispatcharrError';
        this.kind = kind;
        this.status = status || 0;
    }
}

export class DispatcharrClient {
    // ========================================================================
    // Request Methods
    // ========================================================================

    /**
     * GET a JSON resource from Dispatcharr.
     * @param {string} path - API path starting with '/api/'
     * @param {Object} [options]
     * @param {Object} [options.params] - Query string parameters
     * @param {number} [options.timeout] - Timeout in ms
     * @param {string} [options.baseUrl] - Override the saved address (connection test)
     * @param {string} [options.apiKey] - Override the saved key (connection test)
     * @returns {Promise<*>} Parsed JSON
     */
    async get(path, options = {}) {
        const baseUrl = options.baseUrl !== undefined ? normalizeBaseUrl(options.baseUrl) : getBaseUrl();
        const apiKey = options.apiKey !== undefined ? String(options.apiKey).trim() : getApiKey();
        if (!baseUrl || !apiKey) {
            throw new DispatcharrError(DTV_ERROR.NOT_CONFIGURED, 'Dispatcharr is not configured');
        }

        const url = baseUrl + path + this._buildQuery(options.params);
        const timeout = options.timeout || REQUEST_TIMEOUT;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        let timedOut = false;
        const timeoutId = setTimeout(() => {
            timedOut = true;
            if (controller) controller.abort();
        }, timeout);

        let response;
        try {
            response = await fetch(url, {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    Authorization: `ApiKey ${apiKey}`
                },
                signal: controller ? controller.signal : undefined
            });
        } catch (err) {
            clearTimeout(timeoutId);
            if (timedOut) {
                throw new DispatcharrError(DTV_ERROR.TIMEOUT, `Timeout after ${timeout} ms: ${path}`);
            }
            log.warn(`Network error on ${path}:`, err && err.message);
            throw new DispatcharrError(DTV_ERROR.NETWORK, (err && err.message) || 'Network error');
        }

        try {
            if (!response.ok) {
                throw this._httpError(response.status, path);
            }
            return await response.json();
        } catch (err) {
            if (err instanceof DispatcharrError) throw err;
            if (timedOut) {
                throw new DispatcharrError(DTV_ERROR.TIMEOUT, `Timeout after ${timeout} ms: ${path}`);
            }
            throw new DispatcharrError(DTV_ERROR.BAD_RESPONSE, `Invalid JSON from ${path}`);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    // ========================================================================
    // Endpoints
    // ========================================================================

    /**
     * Channels visible to the API key's user, ordered by channel number.
     * Values are override-aware (Dispatcharr applies user edits).
     * @param {Object} [options] - Request overrides (see get())
     * @returns {Promise<Array>} [{id, uuid, name, logo_id, channel_number, epg_data_id, channel_group_id}]
     */
    getChannels(options = {}) {
        return this.get('/api/channels/channels/summary/', {
            ...options,
            params: { ordering: 'channel_number' }
        });
    }

    /**
     * Channel groups visible to the user.
     * @returns {Promise<Array>} [{id, name, channel_count, ...}]
     */
    getGroups() {
        return this.get('/api/channels/groups/');
    }

    /**
     * EPG entries, used to map a channel's epg_data_id to the programs' tvg_id.
     * @returns {Promise<Array>} [{id, tvg_id, name, icon_url, epg_source}]
     */
    getEpgData() {
        return this.get('/api/epg/epgdata/', { timeout: GRID_TIMEOUT });
    }

    /**
     * EPG sources, used to recognise dummy EPG sources.
     * @returns {Promise<Array>} [{id, source_type, ...}]
     */
    getEpgSources() {
        return this.get('/api/epg/sources/');
    }

    /**
     * Programs overlapping [start, end) for every visible channel.
     * @param {number} start - Epoch ms
     * @param {number} end - Epoch ms
     * @returns {Promise<Array>} Raw program rows
     */
    async getGrid(start, end) {
        const result = await this.get('/api/epg/grid/', {
            timeout: GRID_TIMEOUT,
            params: {
                // "Z" suffix: an unencoded "+00:00" would arrive as a space
                start: new Date(start).toISOString(),
                end: new Date(end).toISOString()
            }
        });
        return result && Array.isArray(result.data) ? result.data : [];
    }

    /**
     * Validate an address/key pair before saving it.
     * @param {string} baseUrl
     * @param {string} apiKey
     * @returns {Promise<{channelCount: number}>}
     */
    async testConnection(baseUrl, apiKey) {
        const channels = await this.getChannels({ baseUrl, apiKey });
        if (!Array.isArray(channels)) {
            throw new DispatcharrError(DTV_ERROR.BAD_RESPONSE, 'Unexpected channel list');
        }
        return { channelCount: channels.length };
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    _buildQuery(params) {
        if (!params) return '';
        const parts = Object.keys(params)
            .filter((key) => params[key] !== undefined && params[key] !== null)
            .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`);
        return parts.length ? `?${parts.join('&')}` : '';
    }

    _httpError(status, path) {
        if (status === 401) return new DispatcharrError(DTV_ERROR.UNAUTHORIZED, 'Invalid API key', status);
        if (status === 403) return new DispatcharrError(DTV_ERROR.FORBIDDEN, 'Access denied', status);
        if (status === 404) return new DispatcharrError(DTV_ERROR.NOT_FOUND, `Not found: ${path}`, status);
        return new DispatcharrError(DTV_ERROR.SERVER, `HTTP ${status} on ${path}`, status);
    }
}

export const dispatcharrClient = new DispatcharrClient();
export default dispatcharrClient;

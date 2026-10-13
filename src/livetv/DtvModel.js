/**
 * ============================================================================
 * Litefin Tizen - Dispatcharr Live TV Data Model
 * ============================================================================
 * Pure functions that turn raw Dispatcharr REST payloads into the compact
 * structures used by the Live TV pages: ordered channels, ordered groups and
 * per-channel program timelines. No DOM, storage or network access here, so
 * the module can be unit tested directly with `node --test`.
 * ============================================================================
 */

// ========================================================================
// Constants
// ========================================================================

/** Group id used for channels that have no Dispatcharr group. */
export const NO_GROUP_ID = -1;

/** Virtual list ids shown before the real groups. */
export const LIST_ALL = 'all';
export const LIST_FAVORITES = 'fav';

/** Dispatcharr stream output formats supported by the client. */
export const STREAM_FORMAT_TS = 'ts';
export const STREAM_FORMAT_FMP4 = 'fmp4';

// ========================================================================
// URL Helpers
// ========================================================================

/**
 * Normalize a user-entered Dispatcharr address.
 * Adds `http://` when the scheme is missing and strips trailing slashes.
 * @param {string} raw - Address typed by the user (e.g. "192.168.1.10:9191/")
 * @returns {string} Normalized base URL, or '' when the value is unusable
 */
export function normalizeBaseUrl(raw) {
    if (typeof raw !== 'string') return '';
    let value = raw.trim();
    if (!value) return '';
    if (!/^https?:\/\//i.test(value)) {
        value = `http://${value}`;
    }
    value = value.replace(/\/+$/, '');
    // Reject anything that still has no host part
    const match = /^https?:\/\/([^/?#]+)/i.exec(value);
    if (!match || !match[1]) return '';
    return value;
}

/**
 * Build the live stream URL for a channel.
 * The proxy endpoint needs no credentials: Dispatcharr only applies its
 * network allow-list, so the API key is never placed in the URL.
 * @param {string} baseUrl - Normalized Dispatcharr base URL
 * @param {string} uuid - Channel UUID
 * @param {string} [format] - STREAM_FORMAT_TS (default) or STREAM_FORMAT_FMP4
 * @returns {string}
 */
export function buildStreamUrl(baseUrl, uuid, format) {
    const url = `${baseUrl}/proxy/ts/stream/${encodeURIComponent(uuid)}`;
    return format === STREAM_FORMAT_FMP4 ? `${url}?output_format=fmp4` : url;
}

/**
 * Build the cached logo URL for a logo id (public endpoint, original image).
 * The trailing slash matters: the slash-less redirect has no CORS headers.
 * @param {string} baseUrl
 * @param {number|null} logoId
 * @returns {string} URL, or '' when the channel has no logo
 */
export function buildLogoUrl(baseUrl, logoId) {
    if (logoId === null || logoId === undefined || logoId === '') return '';
    return `${baseUrl}/api/channels/logos/${encodeURIComponent(logoId)}/cache/`;
}

// ========================================================================
// Channels
// ========================================================================

/**
 * Format a Dispatcharr channel number (a float) for display.
 * @param {number|null} number
 * @returns {string} "5", "5.1" or '' when missing
 */
export function formatChannelNumber(number) {
    if (number === null || number === undefined || number === '' || isNaN(number)) return '';
    const value = Number(number);
    if (Math.floor(value) === value) return String(value);
    // Drop float noise such as 5.1000000001
    return String(Math.round(value * 1000) / 1000);
}

/**
 * Sort comparator: by channel number ascending, channels without a number
 * last, then by name.
 */
export function compareChannels(a, b) {
    const aHas = typeof a.number === 'number';
    const bHas = typeof b.number === 'number';
    if (aHas && bHas && a.number !== b.number) return a.number - b.number;
    if (aHas !== bHas) return aHas ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
}

/**
 * Build a resolver that maps a channel to the key used by its EPG programs.
 * Mirrors Dispatcharr's own web guide (frontend/src/utils/guideUtils.js):
 * programs carry the EPG entry's `tvg_id`, while channels without EPG or
 * with a dummy EPG source get generated programs keyed by the channel UUID.
 * @param {Array} epgData - `/api/epg/epgdata/` rows ({id, tvg_id, epg_source})
 * @param {Array} sources - `/api/epg/sources/` rows ({id, source_type})
 * @returns {function(Object): string} (rawChannel) => epg key
 */
export function createEpgKeyResolver(epgData, sources) {
    const dataById = new Map();
    (epgData || []).forEach((row) => {
        if (row && row.id !== undefined) dataById.set(row.id, row);
    });
    const dummySources = new Set();
    (sources || []).forEach((src) => {
        if (src && src.source_type === 'dummy') dummySources.add(src.id);
    });

    return (channel) => {
        const record = channel.epg_data_id != null ? dataById.get(channel.epg_data_id) : null;
        if (!record || record.epg_source == null) return String(channel.uuid);
        if (dummySources.has(record.epg_source)) return String(channel.uuid);
        const tvgId = record.tvg_id;
        return tvgId !== null && tvgId !== undefined && tvgId !== '' ? String(tvgId) : String(channel.uuid);
    };
}

/**
 * Convert `/api/channels/channels/summary/` rows into client channels.
 * @param {Array} summary - Raw summary rows
 * @param {Object} options
 * @param {string} options.baseUrl - Normalized Dispatcharr base URL
 * @param {string} [options.streamFormat] - Stream output format
 * @param {function(Object): string} [options.resolveEpgKey] - From createEpgKeyResolver
 * @returns {Array<Object>} Channels sorted with compareChannels
 */
export function normalizeChannels(summary, options) {
    const { baseUrl, streamFormat } = options;
    const resolveEpgKey = options.resolveEpgKey || ((c) => String(c.uuid));
    const channels = [];

    (summary || []).forEach((row) => {
        if (!row || row.id === undefined || !row.uuid) return;
        const number = typeof row.channel_number === 'number' ? row.channel_number : null;
        channels.push({
            id: row.id,
            uuid: String(row.uuid),
            name: row.name ? String(row.name) : '',
            number,
            numberLabel: formatChannelNumber(number),
            groupId: row.channel_group_id != null ? row.channel_group_id : NO_GROUP_ID,
            logoId: row.logo_id != null ? row.logo_id : null,
            logoUrl: buildLogoUrl(baseUrl, row.logo_id),
            epgKey: resolveEpgKey(row),
            streamUrl: buildStreamUrl(baseUrl, row.uuid, streamFormat)
        });
    });

    channels.sort(compareChannels);
    return channels;
}

// ========================================================================
// Groups
// ========================================================================

/**
 * Build ordered groups from the channels that are actually visible.
 * Dispatcharr groups have no order field, so they are ordered by their lowest
 * channel number (the same rule Dispatcharr's Xtream Codes API uses), then
 * by name. Channels without a group go into a trailing "other" group.
 * @param {Array<Object>} channels - Output of normalizeChannels (already sorted)
 * @param {Array} rawGroups - `/api/channels/groups/` rows ({id, name})
 * @param {string} otherLabel - Display name for channels without a group
 * @returns {Array<{id: number, name: string, channelIds: Array<number>}>}
 */
export function buildGroups(channels, rawGroups, otherLabel) {
    const names = new Map();
    (rawGroups || []).forEach((g) => {
        if (g && g.id !== undefined) names.set(g.id, g.name ? String(g.name) : '');
    });

    // Channels arrive sorted by number, so the order in which groups are first
    // seen is already "lowest channel number first".
    const byId = new Map();
    const ordered = [];
    channels.forEach((channel) => {
        // Unknown group ids (e.g. hidden groups) are merged into the "other" bucket
        const id = names.has(channel.groupId) ? channel.groupId : NO_GROUP_ID;
        let group = byId.get(id);
        if (!group) {
            group = { id, name: id === NO_GROUP_ID ? otherLabel : names.get(id), channelIds: [] };
            byId.set(id, group);
            ordered.push(group);
        }
        group.channelIds.push(channel.id);
    });

    const other = byId.get(NO_GROUP_ID);
    const groups = ordered.filter((g) => g !== other);
    if (other) groups.push(other);
    return groups;
}

// ========================================================================
// Programs
// ========================================================================

/**
 * Parse an ISO 8601 date into epoch milliseconds (NaN when invalid).
 * Accepts both "Z" and "+00:00" suffixes (dummy programs use the latter).
 * @param {string} value
 * @returns {number}
 */
export function parseTime(value) {
    if (!value) return NaN;
    return Date.parse(value);
}

/**
 * Convert a raw grid program into the compact client shape.
 * @param {Object} raw - `/api/epg/grid/` program
 * @returns {Object|null}
 */
export function normalizeProgram(raw) {
    if (!raw) return null;
    const start = parseTime(raw.start_time);
    const end = parseTime(raw.end_time);
    if (isNaN(start) || isNaN(end) || end <= start) return null;
    return {
        id: String(raw.id),
        key: String(raw.tvg_id),
        start,
        end,
        title: raw.title ? String(raw.title) : '',
        subTitle: raw.sub_title ? String(raw.sub_title) : '',
        description: raw.description ? String(raw.description) : '',
        isLive: !!raw.is_live,
        isNew: !!raw.is_new
    };
}

/**
 * Merge grid programs into a per-key timeline map.
 * Duplicates (same id, or same start on the same key) are dropped so that
 * overlapping fetch windows can be merged safely. Each list stays sorted.
 * @param {Map<string, Array>} target - Existing map (mutated and returned)
 * @param {Array} rawPrograms - Raw `/api/epg/grid/` programs
 * @returns {Map<string, Array>}
 */
export function mergePrograms(target, rawPrograms) {
    const touched = new Set();
    (rawPrograms || []).forEach((raw) => {
        const program = normalizeProgram(raw);
        if (!program) return;
        let list = target.get(program.key);
        if (!list) {
            list = [];
            target.set(program.key, list);
        }
        list.push(program);
        touched.add(program.key);
    });

    touched.forEach((key) => {
        const list = target.get(key);
        list.sort((a, b) => a.start - b.start || a.end - b.end);
        const unique = [];
        const seenIds = new Set();
        let lastStart = -1;
        list.forEach((p) => {
            if (seenIds.has(p.id) || p.start === lastStart) return;
            seenIds.add(p.id);
            lastStart = p.start;
            unique.push(p);
        });
        target.set(key, unique);
    });

    return target;
}

/**
 * Drop programs that ended before `cutoff` to bound memory use.
 * @param {Map<string, Array>} target
 * @param {number} cutoff - Epoch ms
 */
export function prunePrograms(target, cutoff) {
    target.forEach((list, key) => {
        let first = 0;
        while (first < list.length && list[first].end <= cutoff) first++;
        if (first > 0) target.set(key, list.slice(first));
    });
}

/**
 * Index of the first program whose end is after `time` (binary search).
 * @param {Array} list - Sorted program list
 * @param {number} time - Epoch ms
 * @returns {number} Index in [0, list.length]
 */
export function firstEndingAfter(list, time) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].end <= time) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/**
 * Program airing at `time`, or null.
 * @param {Array} list - Sorted program list
 * @param {number} time - Epoch ms
 * @returns {Object|null}
 */
export function findProgramAt(list, time) {
    if (!list || !list.length) return null;
    const idx = firstEndingAfter(list, time);
    const program = list[idx];
    return program && program.start <= time ? program : null;
}

/**
 * First program starting at or after `time`, or null.
 * @param {Array} list - Sorted program list
 * @param {number} time - Epoch ms
 * @returns {Object|null}
 */
export function findNextProgram(list, time) {
    if (!list || !list.length) return null;
    let idx = firstEndingAfter(list, time);
    while (idx < list.length && list[idx].start < time) idx++;
    return list[idx] || null;
}

/**
 * Programs overlapping [from, to).
 * @param {Array} list - Sorted program list
 * @param {number} from - Epoch ms
 * @param {number} to - Epoch ms
 * @returns {Array}
 */
export function programsInRange(list, from, to) {
    if (!list || !list.length) return [];
    const result = [];
    for (let i = firstEndingAfter(list, from); i < list.length && list[i].start < to; i++) {
        result.push(list[i]);
    }
    return result;
}

/**
 * Elapsed fraction of a program at `time`, clamped to [0, 1].
 * @param {Object} program
 * @param {number} time - Epoch ms
 * @returns {number}
 */
export function programProgress(program, time) {
    if (!program) return 0;
    const span = program.end - program.start;
    if (span <= 0) return 0;
    return Math.max(0, Math.min(1, (time - program.start) / span));
}

/**
 * Split [from, to) into consecutive guide cells: one per program overlapping
 * the range, plus filler cells (program: null) for gaps. Every instant in
 * the range belongs to exactly one cell, which keeps D-pad navigation
 * predictable even on channels with incomplete EPG.
 * @param {Array} list - Sorted program list
 * @param {number} from - Epoch ms
 * @param {number} to - Epoch ms
 * @returns {Array<{start: number, end: number, program: Object|null}>}
 */
export function buildSegments(list, from, to) {
    const segments = [];
    let cursor = from;
    programsInRange(list, from, to).forEach((program) => {
        const start = Math.max(program.start, from);
        const end = Math.min(program.end, to);
        if (end <= cursor) return; // Overlapping/duplicate program
        if (start > cursor) segments.push({ start: cursor, end: start, program: null });
        segments.push({ start: Math.max(start, cursor), end, program });
        cursor = end;
    });
    if (cursor < to) segments.push({ start: cursor, end: to, program: null });
    return segments;
}

/**
 * Index of the segment containing `time` (clamped to the first/last one).
 * @param {Array} segments - Output of buildSegments
 * @param {number} time - Epoch ms
 * @returns {number} Index, or -1 when there are no segments
 */
export function segmentIndexAt(segments, time) {
    if (!segments.length) return -1;
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (segments[mid].end <= time) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// ========================================================================
// Zapping Lists
// ========================================================================

/**
 * Channel id `step` positions away from `currentId` in `ids`, wrapping at
 * both ends. Falls back to the first channel when `currentId` is not listed.
 * @param {Array<number>} ids - Ordered channel ids of the active list
 * @param {number} currentId
 * @param {number} step - +1 (next) or -1 (previous)
 * @returns {number|null}
 */
export function stepChannel(ids, currentId, step) {
    if (!ids || !ids.length) return null;
    const idx = ids.indexOf(currentId);
    if (idx === -1) return ids[0];
    const len = ids.length;
    return ids[(((idx + step) % len) + len) % len];
}

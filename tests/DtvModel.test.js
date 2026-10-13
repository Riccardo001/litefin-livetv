import assert from 'node:assert/strict';
import test from 'node:test';

import {
    NO_GROUP_ID,
    STREAM_FORMAT_FMP4,
    buildGroups,
    buildLogoUrl,
    buildSegments,
    buildStreamUrl,
    createEpgKeyResolver,
    findNextProgram,
    findProgramAt,
    formatChannelNumber,
    mergePrograms,
    normalizeBaseUrl,
    normalizeChannels,
    programProgress,
    programsInRange,
    segmentIndexAt,
    prunePrograms,
    stepChannel
} from '../src/livetv/DtvModel.js';

/**
 * ============================================================================
 * Dispatcharr Live TV Data Model Test Suite
 * ============================================================================
 * Covers the pure transformations between Dispatcharr REST payloads and the
 * client model: URL handling, channel ordering, group ordering, EPG key
 * resolution (real vs dummy EPG) and program timeline lookups.
 * ============================================================================
 */

const BASE = 'http://192.168.1.10:9191';
const HOUR = 60 * 60 * 1000;

test('normalizeBaseUrl adds the scheme and strips trailing slashes', () => {
    assert.equal(normalizeBaseUrl(' 192.168.1.10:9191/ '), 'http://192.168.1.10:9191');
    assert.equal(normalizeBaseUrl('https://tv.example.org//'), 'https://tv.example.org');
    assert.equal(normalizeBaseUrl('HTTP://host:9191'), 'HTTP://host:9191');
    assert.equal(normalizeBaseUrl(''), '');
    assert.equal(normalizeBaseUrl('http://'), '');
    assert.equal(normalizeBaseUrl(null), '');
});

test('stream and logo URLs never contain credentials', () => {
    assert.equal(buildStreamUrl(BASE, 'abc-123'), `${BASE}/proxy/ts/stream/abc-123`);
    assert.equal(
        buildStreamUrl(BASE, 'abc-123', STREAM_FORMAT_FMP4),
        `${BASE}/proxy/ts/stream/abc-123?output_format=fmp4`
    );
    assert.equal(buildLogoUrl(BASE, 42), `${BASE}/api/channels/logos/42/cache/`);
    assert.equal(buildLogoUrl(BASE, null), '');
});

test('formatChannelNumber keeps decimals and hides missing numbers', () => {
    assert.equal(formatChannelNumber(5), '5');
    assert.equal(formatChannelNumber(5.0), '5');
    assert.equal(formatChannelNumber(5.1), '5.1');
    assert.equal(formatChannelNumber(5.1000000001), '5.1');
    assert.equal(formatChannelNumber(null), '');
});

test('normalizeChannels sorts by number with unnumbered channels last', () => {
    const channels = normalizeChannels(
        [
            { id: 3, uuid: 'u3', name: 'Zeta', channel_number: null, channel_group_id: 1, logo_id: null, epg_data_id: null },
            { id: 1, uuid: 'u1', name: 'Rai 1', channel_number: 1, channel_group_id: 1, logo_id: 7, epg_data_id: null },
            { id: 2, uuid: 'u2', name: 'Alpha', channel_number: null, channel_group_id: 2, logo_id: null, epg_data_id: null },
            { id: 4, uuid: 'u4', name: 'Rai 1 HD', channel_number: 1.1, channel_group_id: 1, logo_id: null, epg_data_id: null },
            { id: 5, uuid: '', name: 'Broken', channel_number: 3 }
        ],
        { baseUrl: BASE }
    );

    assert.deepEqual(
        channels.map((c) => c.id),
        [1, 4, 2, 3]
    );
    assert.equal(channels[0].numberLabel, '1');
    assert.equal(channels[0].logoUrl, `${BASE}/api/channels/logos/7/cache/`);
    assert.equal(channels[1].numberLabel, '1.1');
    assert.equal(channels[2].numberLabel, '');
    assert.equal(channels[0].streamUrl, `${BASE}/proxy/ts/stream/u1`);
});

test('EPG keys follow Dispatcharr guide rules (tvg_id, dummy and missing EPG)', () => {
    const resolve = createEpgKeyResolver(
        [
            { id: 10, tvg_id: 'rai1.it', epg_source: 1 },
            { id: 11, tvg_id: 'dummy-x', epg_source: 2 },
            { id: 12, tvg_id: '', epg_source: 1 }
        ],
        [
            { id: 1, source_type: 'xmltv' },
            { id: 2, source_type: 'dummy' }
        ]
    );

    assert.equal(resolve({ uuid: 'a', epg_data_id: 10 }), 'rai1.it');
    assert.equal(resolve({ uuid: 'b', epg_data_id: 11 }), 'b', 'dummy source uses channel uuid');
    assert.equal(resolve({ uuid: 'c', epg_data_id: null }), 'c', 'no EPG uses channel uuid');
    assert.equal(resolve({ uuid: 'd', epg_data_id: 99 }), 'd', 'unknown EPG row uses channel uuid');
    assert.equal(resolve({ uuid: 'e', epg_data_id: 12 }), 'e', 'empty tvg_id uses channel uuid');
});

test('buildGroups orders groups by lowest channel number and puts ungrouped last', () => {
    const channels = normalizeChannels(
        [
            { id: 1, uuid: 'u1', name: 'Sport 1', channel_number: 20, channel_group_id: 30 },
            { id: 2, uuid: 'u2', name: 'Rai 1', channel_number: 1, channel_group_id: 10 },
            { id: 3, uuid: 'u3', name: 'Loose', channel_number: 2, channel_group_id: null },
            { id: 4, uuid: 'u4', name: 'Rai 2', channel_number: 2.5, channel_group_id: 10 },
            { id: 5, uuid: 'u5', name: 'Ghost', channel_number: 3, channel_group_id: 999 },
            { id: 6, uuid: 'u6', name: 'News', channel_number: 5, channel_group_id: 20 }
        ],
        { baseUrl: BASE }
    );
    const groups = buildGroups(
        channels,
        [
            { id: 10, name: 'Generalisti' },
            { id: 20, name: 'News' },
            { id: 30, name: 'Sport' },
            { id: 40, name: 'Empty group' }
        ],
        'Other'
    );

    assert.deepEqual(
        groups.map((g) => g.name),
        ['Generalisti', 'News', 'Sport', 'Other']
    );
    assert.deepEqual(groups[0].channelIds, [2, 4]);
    assert.equal(groups[3].id, NO_GROUP_ID);
    assert.deepEqual(groups[3].channelIds, [3, 5], 'null and unknown groups end up in Other');
});

test('mergePrograms indexes by key, sorts and de-duplicates overlapping windows', () => {
    const t0 = Date.UTC(2026, 9, 13, 18, 0, 0);
    const iso = (ms) => new Date(ms).toISOString();
    const map = new Map();

    mergePrograms(map, [
        { id: 2, tvg_id: 'rai1.it', start_time: iso(t0 + HOUR), end_time: iso(t0 + 2 * HOUR), title: 'B' },
        { id: 1, tvg_id: 'rai1.it', start_time: iso(t0), end_time: iso(t0 + HOUR), title: 'A' },
        { id: 'bad', tvg_id: 'rai1.it', start_time: 'nope', end_time: iso(t0) }
    ]);
    // Second window overlaps: program 2 again plus a dummy program with +00:00 offset
    mergePrograms(map, [
        { id: 2, tvg_id: 'rai1.it', start_time: iso(t0 + HOUR), end_time: iso(t0 + 2 * HOUR), title: 'B' },
        {
            id: 'dummy-standard-9-20261013T180000',
            tvg_id: 'uuid-9',
            start_time: '2026-10-13T18:00:00+00:00',
            end_time: '2026-10-13T22:00:00+00:00',
            title: 'Channel 9'
        }
    ]);

    assert.deepEqual(
        map.get('rai1.it').map((p) => p.title),
        ['A', 'B']
    );
    assert.equal(map.get('uuid-9')[0].start, t0);

    prunePrograms(map, t0 + HOUR);
    assert.deepEqual(
        map.get('rai1.it').map((p) => p.title),
        ['B'],
        'programs ended before the cutoff are dropped'
    );
});

test('program lookups find the airing and next program with binary search', () => {
    const t0 = 1_000_000;
    const list = [
        { id: 'a', start: t0, end: t0 + 100 },
        { id: 'b', start: t0 + 100, end: t0 + 200 },
        // Gap between 200 and 300
        { id: 'c', start: t0 + 300, end: t0 + 400 }
    ];

    assert.equal(findProgramAt(list, t0 - 1), null);
    assert.equal(findProgramAt(list, t0).id, 'a');
    assert.equal(findProgramAt(list, t0 + 100).id, 'b', 'end is exclusive');
    assert.equal(findProgramAt(list, t0 + 250), null, 'gaps have no program');
    assert.equal(findNextProgram(list, t0 + 50).id, 'b');
    assert.equal(findNextProgram(list, t0 + 250).id, 'c');
    assert.equal(findNextProgram(list, t0 + 350), null);
    assert.deepEqual(
        programsInRange(list, t0 + 150, t0 + 350).map((p) => p.id),
        ['b', 'c']
    );
    assert.equal(programProgress(list[0], t0 + 25), 0.25);
    assert.equal(programProgress(list[0], t0 + 500), 1);
});

test('buildSegments covers the whole range with programs and gap fillers', () => {
    const list = [
        { id: 'a', start: 50, end: 150 }, // Starts before the range
        { id: 'b', start: 150, end: 200 },
        { id: 'dup', start: 160, end: 190 }, // Overlaps b, must be skipped
        { id: 'c', start: 250, end: 400 } // Ends after the range
    ];
    const segments = buildSegments(list, 100, 300);

    assert.deepEqual(
        segments.map((s) => [s.start, s.end, s.program ? s.program.id : null]),
        [
            [100, 150, 'a'],
            [150, 200, 'b'],
            [200, 250, null],
            [250, 300, 'c']
        ]
    );
    assert.deepEqual(
        buildSegments([], 0, 10).map((s) => [s.start, s.end, s.program]),
        [[0, 10, null]],
        'a channel without EPG gets a single filler cell'
    );
    assert.equal(segmentIndexAt(segments, 100), 0);
    assert.equal(segmentIndexAt(segments, 199), 1);
    assert.equal(segmentIndexAt(segments, 220), 2);
    assert.equal(segmentIndexAt(segments, 999), 3, 'clamped to the last cell');
    assert.equal(segmentIndexAt([], 5), -1);
});

test('stepChannel wraps around both ends of the list', () => {
    const ids = [10, 20, 30];
    assert.equal(stepChannel(ids, 10, 1), 20);
    assert.equal(stepChannel(ids, 30, 1), 10);
    assert.equal(stepChannel(ids, 10, -1), 30);
    assert.equal(stepChannel(ids, 99, 1), 10, 'unknown current falls back to first');
    assert.equal(stepChannel([], 10, 1), null);
});

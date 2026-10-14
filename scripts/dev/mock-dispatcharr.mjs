#!/usr/bin/env node
/**
 * ============================================================================
 * Litefin - Mock Dispatcharr server (development only)
 * ============================================================================
 * Emulates the subset of the Dispatcharr 0.32 API used by the Live TV
 * section, so the UI can be developed in a desktop browser without a real
 * Dispatcharr instance. Zero dependencies; live video needs ffmpeg in PATH.
 *
 * Usage:
 *   npm run mock:dispatcharr            # http://localhost:9191, API key "dev-key"
 *   MOCK_PORT=9292 MOCK_API_KEY=abc node scripts/dev/mock-dispatcharr.mjs
 *   MOCK_MAX_STREAMS=1 npm run mock:dispatcharr   # IPTV account with one connection
 *
 * In Litefin: Settings > Live TV (IPTV) > address http://localhost:9191, key dev-key.
 *
 * Endpoints (same shapes as Dispatcharr):
 *   GET /api/channels/channels/summary/   (ApiKey auth, ?ordering=channel_number)
 *   GET /api/channels/groups/             (ApiKey auth)
 *   GET /api/epg/epgdata/                 (ApiKey auth)
 *   GET /api/epg/sources/                 (ApiKey auth)
 *   GET /api/epg/grid/?start=&end=        (ApiKey auth, {"data": [...]})
 *   GET /api/channels/logos/<id>/cache/   (public, SVG)
 *   GET /proxy/ts/stream/<uuid>           (public, MPEG-TS or ?output_format=fmp4)
 *
 * Provider connection limit (MOCK_MAX_STREAMS, default unlimited): like
 * Dispatcharr with an M3U account limited to N streams, a stream request
 * waits up to 3 s for a free slot, then answers 503. A slot is released
 * MOCK_RELEASE_MS (default 800) after the client disconnects. Two client
 * connections open at the same time are logged as "OVERLAP".
 *
 * Special channels to exercise error handling:
 *   "Slow Start"  - waits 6 s before sending the first byte
 *   "Busy 503"    - every other request answers 503 + Retry-After: 1
 *   "Drops 20s"   - stream ends after 20 seconds
 *   "Dead Air"    - accepts the connection but never sends data
 * ============================================================================
 */

import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

const PORT = Number(process.env.MOCK_PORT) || 9191;
const API_KEY = process.env.MOCK_API_KEY || 'dev-key';
const API_LATENCY_MS = Number(process.env.MOCK_LATENCY) || 250;
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

const MAX_STREAMS = Number(process.env.MOCK_MAX_STREAMS) || 0;
const RELEASE_MS = process.env.MOCK_RELEASE_MS !== undefined ? Number(process.env.MOCK_RELEASE_MS) : 800;
const SLOT_WAIT_MS = 3000;

// ============================================================================
// Fixture Data
// ============================================================================

const GROUPS = [
    { id: 10, name: 'Generalisti' },
    { id: 20, name: 'News' },
    { id: 30, name: 'Sport' },
    { id: 40, name: 'Cinema' },
    { id: 50, name: 'Bambini' },
    { id: 60, name: 'Musica' },
    { id: 70, name: 'Test' },
    // Group with no visible channels: the client must not show it
    { id: 80, name: 'Gruppo vuoto' }
];

const EPG_SOURCES = [
    { id: 1, name: 'XMLTV Italia', source_type: 'xmltv' },
    { id: 2, name: 'Dummy', source_type: 'dummy' }
];

const CHANNEL_NAMES = {
    10: ['Rai 1', 'Rai 2', 'Rai 3', 'Rete 4', 'Canale 5', 'Italia 1', 'La7', 'TV8', 'Nove', 'Rai 4'],
    20: ['Rai News 24', 'Sky TG24', 'TGCom 24', 'Euronews', 'BBC World', 'CNN International'],
    30: ['Sport 1', 'Sport 2', 'Sport 3', 'Calcio HD', 'Tennis Live', 'Motori', 'Basket TV', 'Eurosport'],
    40: ['Cinema 1', 'Cinema 2', 'Cinema Classics', 'Action', 'Comedy', 'Drama', 'Family'],
    50: ['Cartoon', 'Kids', 'Junior', 'Toons'],
    60: ['Music Hits', 'Rock TV', 'Classica', 'Jazz Lounge']
};

const PROGRAM_TITLES = [
    'Telegiornale',
    'Meteo',
    'Il film della sera',
    'Documentario: Oceani',
    'Quiz show',
    'Calcio: Serie A',
    'Talk show',
    'Serie TV: Episodio',
    'Cartoni animati',
    'Notiziario regionale',
    'Concerto dal vivo',
    'Viaggio in Italia',
    'Cucina facile',
    'Tennis: ATP Finals',
    'Rassegna stampa'
];

const DURATIONS = [30, 30, 45, 60, 60, 60, 90, 120];

function hash(n) {
    const x = Math.imul(n, 2654435761) >>> 0;
    // Keep the result unsigned: plain "^=" would yield a negative int32
    return (x ^ (x >>> 15)) >>> 0;
}

function uuidFor(id) {
    const hex = id.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${hex}`;
}

function buildChannels() {
    const channels = [];
    const epgData = [];
    let id = 1;

    Object.keys(CHANNEL_NAMES).forEach((groupKey, groupIndex) => {
        const groupId = Number(groupKey);
        // Groups start at 1, 21, 41, ... like a typical IPTV numbering plan
        const base = groupIndex * 20 + 1;
        CHANNEL_NAMES[groupId].forEach((name, i) => {
            const channelId = id++;
            const epgId = 1000 + channelId;
            // Every 7th channel has no EPG, every 5th uses the dummy source
            let epgDataId = epgId;
            if (channelId % 7 === 0) {
                epgDataId = null;
            } else {
                epgData.push({
                    id: epgId,
                    tvg_id: channelId % 5 === 0 ? `dummy-${channelId}` : `ch${channelId}.mock`,
                    name,
                    icon_url: null,
                    epg_source: channelId % 5 === 0 ? 2 : 1
                });
            }
            channels.push({
                id: channelId,
                uuid: uuidFor(channelId),
                name,
                channel_number: base + i,
                channel_group_id: groupId,
                // Every 9th channel has no logo, every 11th points to a missing logo
                logo_id: channelId % 9 === 0 ? null : channelId,
                epg_data_id: epgDataId
            });
        });
    });

    // Decimal channel number, a "HD" variant right after Rai 1
    channels.push({ id: id, uuid: uuidFor(id), name: 'Rai 1 HD', channel_number: 1.1, channel_group_id: 10, logo_id: 1, epg_data_id: 1001 });
    id++;

    // Channels without number / without group
    channels.push({ id: id, uuid: uuidFor(id), name: 'Senza numero', channel_number: null, channel_group_id: 10, logo_id: id, epg_data_id: null });
    id++;
    channels.push({ id: id, uuid: uuidFor(id), name: 'Senza gruppo', channel_number: 95, channel_group_id: null, logo_id: id, epg_data_id: null });
    id++;

    // Error-handling test channels
    ['Slow Start', 'Busy 503', 'Drops 20s', 'Dead Air'].forEach((name, i) => {
        channels.push({
            id: id,
            uuid: uuidFor(id),
            name,
            channel_number: 900 + i,
            channel_group_id: 70,
            logo_id: id,
            epg_data_id: null,
            _special: name
        });
        id++;
    });

    return { channels, epgData };
}

const { channels: CHANNELS, epgData: EPG_DATA } = buildChannels();
const CHANNEL_BY_UUID = new Map(CHANNELS.map((c) => [c.uuid, c]));

// ============================================================================
// EPG Generation
// ============================================================================

function realPrograms(channel, tvgId, from, to) {
    // Deterministic schedule anchored at UTC midnight two days ago
    const anchor = new Date();
    anchor.setUTCHours(0, 0, 0, 0);
    let t = anchor.getTime() - 48 * HOUR;
    let i = 0;
    const programs = [];
    while (t < to) {
        const h = hash(channel.id * 1000 + i);
        const duration = DURATIONS[h % DURATIONS.length] * MINUTE;
        const end = t + duration;
        if (end > from) {
            const title = PROGRAM_TITLES[(h >>> 3) % PROGRAM_TITLES.length];
            programs.push({
                id: channel.id * 100000 + i,
                start_time: new Date(t).toISOString().replace('.000Z', 'Z'),
                end_time: new Date(end).toISOString().replace('.000Z', 'Z'),
                title,
                sub_title: h % 3 === 0 ? `Puntata ${(h % 40) + 1}` : '',
                description: `${title} su ${channel.name}. Descrizione di prova generata dal mock di Dispatcharr per verificare il pannello dettagli della guida.`,
                tvg_id: tvgId,
                season: null,
                episode: null,
                is_new: h % 4 === 0,
                is_live: h % 6 === 0,
                is_premiere: false,
                is_finale: false
            });
        }
        t = end;
        i++;
    }
    return programs;
}

function dummyPrograms(channel, from, to) {
    // Dispatcharr dummy EPG: 4-hour blocks named after the channel, keyed by uuid
    const programs = [];
    let t = Math.floor(from / (4 * HOUR)) * 4 * HOUR;
    while (t < to) {
        const start = new Date(t);
        const stamp = start.toISOString().replace(/[-:]/g, '').slice(0, 15);
        programs.push({
            id: `dummy-standard-${channel.id}-${stamp}`,
            start_time: start.toISOString().replace('.000Z', '+00:00'),
            end_time: new Date(t + 4 * HOUR).toISOString().replace('.000Z', '+00:00'),
            title: channel.name,
            sub_title: '',
            description: '',
            tvg_id: channel.uuid,
            season: null,
            episode: null,
            is_new: false,
            is_live: false,
            is_premiere: false,
            is_finale: false,
            custom_properties: null
        });
        t += 4 * HOUR;
    }
    return programs;
}

function gridPrograms(from, to) {
    const data = [];
    CHANNELS.forEach((channel) => {
        const epg = channel.epg_data_id ? EPG_DATA.find((e) => e.id === channel.epg_data_id) : null;
        if (epg && epg.epg_source === 1) {
            data.push(...realPrograms(channel, epg.tvg_id, from, to));
        } else {
            data.push(...dummyPrograms(channel, from, to));
        }
    });
    return data;
}

// ============================================================================
// Logos
// ============================================================================

function logoSvg(channel) {
    const hue = (channel.id * 47) % 360;
    const wide = channel.id % 2 === 0;
    const w = wide ? 400 : 200;
    const h = wide ? 120 : 200;
    const label = channel.name.replace(/[<>&"]/g, '');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
        `<rect width="${w}" height="${h}" rx="18" fill="hsl(${hue},65%,42%)"/>` +
        `<text x="50%" y="56%" font-family="Arial, sans-serif" font-size="${wide ? 44 : 36}" font-weight="700" ` +
        `fill="#fff" text-anchor="middle" dominant-baseline="middle">${label}</text></svg>`;
}

// ============================================================================
// Streams
// ============================================================================

const busyToggle = new Map();

// ============================================================================
// Provider Slots
// ============================================================================

let slotsInUse = 0;
let openClients = 0;

/**
 * Reserve a provider slot like Dispatcharr does for a limited M3U account:
 * wait up to SLOT_WAIT_MS for one to free up, then give up.
 * @returns {Promise<boolean>}
 */
async function acquireSlot(req, channel) {
    if (!MAX_STREAMS) return true;
    const start = Date.now();
    let warned = false;
    while (slotsInUse >= MAX_STREAMS) {
        if (req.socket.destroyed) return false;
        if (Date.now() - start >= SLOT_WAIT_MS) {
            log(`REJECTED ${channel.name}: no free provider slot after ${SLOT_WAIT_MS} ms (${slotsInUse}/${MAX_STREAMS})`);
            return false;
        }
        if (!warned) {
            log(`waiting for a provider slot for ${channel.name} (${slotsInUse}/${MAX_STREAMS} in use)`);
            warned = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    slotsInUse++;
    log(`slot taken by ${channel.name} (${slotsInUse}/${MAX_STREAMS})`);
    return true;
}

function releaseSlot(channel) {
    if (!MAX_STREAMS) return;
    setTimeout(() => {
        slotsInUse--;
        log(`slot released by ${channel.name} (${slotsInUse}/${MAX_STREAMS})`);
    }, RELEASE_MS);
}

async function streamChannel(req, res, channel, format) {
    openClients++;
    if (openClients > 1) log(`OVERLAP: ${openClients} client connections open (new: ${channel.name})`);
    let closed = false;
    req.on('close', () => {
        closed = true;
        openClients--;
        log(`client disconnected from ${channel.name}`);
    });

    if (channel._special !== 'Busy 503') {
        if (!(await acquireSlot(req, channel))) {
            if (!closed) sendJson(res, 503, { error: 'No streams available, retry shortly' }, { 'Retry-After': '1' });
            return;
        }
        if (closed) {
            releaseSlot(channel);
            return;
        }
        req.on('close', () => releaseSlot(channel));
    }
    serveStream(req, res, channel, format);
}

function serveStream(req, res, channel, format) {
    const special = channel._special;

    if (special === 'Busy 503') {
        const busy = !busyToggle.get(channel.id);
        busyToggle.set(channel.id, busy);
        if (busy) {
            sendJson(res, 503, { error: 'Channel is stopping, retry shortly' }, { 'Retry-After': '1' });
            return;
        }
    }

    if (special === 'Dead Air') {
        res.writeHead(200, cors({ 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-cache' }));
        // Never write anything; the client watchdog must give up
        return;
    }

    if (!HAS_FFMPEG) {
        sendJson(res, 503, { error: 'ffmpeg not installed on the mock host' });
        return;
    }

    const start = () => {
        if (res.writableEnded || req.socket.destroyed) return;
        const isMp4 = format === 'fmp4';
        const hue = (channel.id * 47) % 360;
        const args = [
            '-hide_banner',
            '-loglevel',
            'error',
            '-re',
            '-f',
            'lavfi',
            '-i',
            `testsrc2=size=960x540:rate=25,hue=h=${hue}`,
            '-f',
            'lavfi',
            '-i',
            `sine=frequency=${220 + (channel.id % 12) * 40}:sample_rate=48000`
        ];
        if (special === 'Drops 20s') args.push('-t', '20');
        args.push(
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-tune',
            'zerolatency',
            '-pix_fmt',
            'yuv420p',
            '-g',
            '50',
            '-c:a',
            'aac',
            '-b:a',
            '96k'
        );
        if (isMp4) {
            args.push('-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1');
        } else {
            args.push('-f', 'mpegts', 'pipe:1');
        }

        const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'inherit'] });
        res.writeHead(200, cors({ 'Content-Type': isMp4 ? 'video/mp4' : 'video/mp2t', 'Cache-Control': 'no-cache' }));
        ff.stdout.pipe(res);
        ff.on('close', () => res.end());
        const stop = () => ff.kill('SIGKILL');
        req.on('close', stop);
        log(`stream start ${channel.name} (${isMp4 ? 'fmp4' : 'ts'})`);
    };

    if (special === 'Slow Start') {
        setTimeout(start, 6000);
    } else {
        start();
    }
}

// ============================================================================
// HTTP Plumbing
// ============================================================================

function log(...args) {
    console.log(`[mock-dispatcharr ${new Date().toISOString().slice(11, 19)}]`, ...args);
}

function cors(headers = {}) {
    // Mirrors django-cors-headers defaults used by Dispatcharr (no x-api-key)
    return {
        'Access-Control-Allow-Origin': '*',
        ...headers
    };
}

function sendJson(res, status, body, headers = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, cors({ 'Content-Type': 'application/json', ...headers }));
    res.end(payload);
}

function isAuthorized(req) {
    const auth = req.headers.authorization || '';
    const parts = auth.split(' ');
    return parts.length === 2 && parts[0].toLowerCase() === 'apikey' && parts[1] === API_KEY;
}

function handleApi(req, res, url) {
    const path = url.pathname;

    if (!isAuthorized(req)) {
        sendJson(res, 401, { detail: 'Invalid API key' });
        return;
    }

    if (path === '/api/channels/channels/summary/') {
        const list = CHANNELS.map((c) => ({
            id: c.id,
            uuid: c.uuid,
            name: c.name,
            logo_id: c.logo_id,
            channel_number: c.channel_number,
            epg_data_id: c.epg_data_id,
            channel_group_id: c.channel_group_id
        }));
        // Dispatcharr's default ordering is "-channel_number"
        const asc = url.searchParams.get('ordering') === 'channel_number';
        list.sort((a, b) => {
            const an = a.channel_number == null ? Infinity : a.channel_number;
            const bn = b.channel_number == null ? Infinity : b.channel_number;
            return asc ? an - bn : bn - an;
        });
        sendJson(res, 200, list);
        return;
    }

    if (path === '/api/channels/groups/') {
        sendJson(
            res,
            200,
            GROUPS.map((g) => ({
                id: g.id,
                name: g.name,
                channel_count: CHANNELS.filter((c) => c.channel_group_id === g.id).length,
                m3u_account_count: 0,
                m3u_accounts: []
            }))
        );
        return;
    }

    if (path === '/api/epg/epgdata/') {
        sendJson(res, 200, EPG_DATA);
        return;
    }

    if (path === '/api/epg/sources/') {
        sendJson(res, 200, EPG_SOURCES);
        return;
    }

    if (path === '/api/epg/grid/') {
        const now = Date.now();
        const from = url.searchParams.get('start') ? Date.parse(url.searchParams.get('start')) : now - HOUR;
        const to = url.searchParams.get('end') ? Date.parse(url.searchParams.get('end')) : from + 25 * HOUR;
        if (isNaN(from) || isNaN(to) || to <= from) {
            sendJson(res, 400, { error: 'Invalid window' });
            return;
        }
        sendJson(res, 200, { data: gridPrograms(from, to) });
        return;
    }

    sendJson(res, 404, { detail: 'Not found.' });
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'accept, authorization, content-type, user-agent, x-csrftoken, x-requested-with',
            'Access-Control-Max-Age': '86400'
        });
        res.end();
        return;
    }

    const logoMatch = /^\/api\/channels\/logos\/(\d+)\/cache\/$/.exec(url.pathname);
    if (logoMatch) {
        const channel = CHANNELS.find((c) => c.logo_id === Number(logoMatch[1]));
        if (!channel || channel.id % 11 === 0) {
            sendJson(res, 404, { detail: 'Logo not found' });
            return;
        }
        res.writeHead(200, cors({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=14400' }));
        res.end(logoSvg(channel));
        return;
    }

    const streamMatch = /^\/proxy\/ts\/stream\/([^/]+)$/.exec(url.pathname);
    if (streamMatch) {
        const channel = CHANNEL_BY_UUID.get(decodeURIComponent(streamMatch[1]));
        if (!channel) {
            sendJson(res, 404, { error: 'Channel not found' });
            return;
        }
        const format = url.searchParams.get('output_format') || url.searchParams.get('output');
        streamChannel(req, res, channel, format === 'fmp4' || format === 'mp4' ? 'fmp4' : 'ts');
        return;
    }

    if (url.pathname.startsWith('/api/')) {
        setTimeout(() => handleApi(req, res, url), API_LATENCY_MS);
        return;
    }

    sendJson(res, 404, { detail: 'Not found.' });
});

server.listen(PORT, () => {
    log(`listening on http://localhost:${PORT}  (API key: ${API_KEY})`);
    log(`${CHANNELS.length} channels, ${GROUPS.length} groups, ffmpeg ${HAS_FFMPEG ? 'available' : 'MISSING (streams disabled)'}`);
    if (MAX_STREAMS) log(`provider limited to ${MAX_STREAMS} stream(s), slot released ${RELEASE_MS} ms after disconnect`);
});

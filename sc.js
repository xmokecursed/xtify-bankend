const axios = require('axios');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/141.0.0.0 Safari/537.36';
const WEB_HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: 'https://soundcloud.com',
  Referer: 'https://soundcloud.com/',
};

const PLAY_HEADERS = {
  Origin: WEB_HEADERS.Origin,
  Referer: WEB_HEADERS.Referer,
  'User-Agent': UA,
};

const API = 'https://api-v2.soundcloud.com';
const CLIENT_ID_RE = /client_id\s*[:=]\s*"([A-Za-z0-9]{32})"/;
const CLIENT_ID_TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT = 15000;

const http = (url, opts = {}) =>
  axios.get(url, { timeout: TIMEOUT, responseType: 'text', transformResponse: (d) => d, ...opts });

let clientIdCache = null;
let clientIdPending = null;

async function scrapeClientId() {
  const page = (await http('https://soundcloud.com', {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
  })).data;
  let m = CLIENT_ID_RE.exec(page);
  if (m) return m[1];
  const urls = [...new Set(page.match(/https:\/\/[A-Za-z0-9.\-]*sndcdn\.com\/assets\/[^"'\s<>]+\.js/g) || [])];
  for (const u of urls.slice(-8).reverse()) {
    const js = (await http(u, { headers: { 'User-Agent': UA } })).data;
    m = CLIENT_ID_RE.exec(js);
    if (m) return m[1];
  }
  throw new Error('no SoundCloud client_id found');
}

async function getClientId(force = false) {
  if (!force && clientIdCache && Date.now() - clientIdCache.at < CLIENT_ID_TTL_MS) {
    return clientIdCache.id;
  }
  if (!clientIdPending) {
    clientIdPending = scrapeClientId()
      .then((id) => {
        clientIdCache = { id, at: Date.now() };
        return id;
      })
      .finally(() => { clientIdPending = null; });
  }
  return clientIdPending;
}

async function apiJson(url, params) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const client_id = await getClientId(attempt > 0);
    try {
      const r = await http(url, { params: { ...params, client_id }, headers: WEB_HEADERS });
      return JSON.parse(r.data);
    } catch (e) {
      const code = e.response?.status;
      if (attempt === 0 && (code === 401 || code === 403)) continue;
      throw e;
    }
  }
}

function labelOf(t) {
  const tcs = t.media?.transcodings || [];
  if (t.policy === 'BLOCK') return 'blocked';
  if (t.policy === 'SNIP' || (tcs.length && tcs.every((c) => c.snipped))) return 'preview';
  if (t.streamable === false) return 'not_streamable';
  return 'playable';
}

const bigArt = (url) => (url ? url.replace('-large.', '-t500x500.') : undefined);

function shape(t) {
  return {
    id: String(t.id),
    title: t.title,
    artist: t.user?.username || '',
    duration: Math.round((t.full_duration || t.duration || 0) / 1000),
    thumb: bigArt(t.artwork_url || t.user?.avatar_url),
    status: labelOf(t),
    url: t.permalink_url,
  };
}

async function searchSoundCloud(q, limit = 15) {
  const data = await apiJson(`${API}/search/tracks`, { q, limit, app_locale: 'en' });
  return (data.collection || [])
    .filter((t) => t && t.id && t.media?.transcodings?.length)
    .map(shape);
}


const rank = (c) => {
  if (c.format?.protocol === 'progressive') return 0;
  const HLS_PRESETS = { aac_160k: 1, abr_sq: 2, aac_96k: 3 };
  return HLS_PRESETS[c.preset] || 4;
};

async function resolveStream(id) {
  const t = await apiJson(`${API}/tracks/${encodeURIComponent(id)}`, {});
  const status = labelOf(t);
  if (status !== 'playable') {
    const err = new Error(`track is ${status}`);
    err.status = status;
    err.code = 403;
    throw err;
  }
  
  const tcs = (t.media?.transcodings || []).filter(
    (c) => !c.snipped && c.format?.protocol === 'progressive'
  );

  if (!tcs.length) {
    const err = new Error('No direct progressive stream available for this track (HLS/DASH is restricted).');
    err.code = 404;
    throw err;
  }

  const params = {};
  if (t.track_authorization) params.track_authorization = t.track_authorization;

  try {
    const r = await apiJson(tcs[0].url, params);
    if (r.url) {
      return {
        ...shape(t),
        stream: {
          url: r.url,
          preset: tcs[0].preset,
          protocol: tcs[0].format?.protocol,
          mime: tcs[0].format?.mime_type,
          headers: PLAY_HEADERS,
        },
      };
    }
  } catch (e) {
    throw new Error(`Failed to fetch stream URL: ${e.message}`);
  }

  const err = new Error('no stream address was given');
  err.code = 502;
  throw err;
}

async function resolveHls(id) {
  const t = await apiJson(`${API}/tracks/${encodeURIComponent(id)}`, {});
  const status = labelOf(t);
  if (status !== 'playable') {
    const err = new Error(`track is ${status}`);
    err.status = status;
    err.code = 403;
    throw err;
  }

  const order = { aac_160k: 0, aac_96k: 1, abr_sq: 2 };
  const tcs = (t.media?.transcodings || [])
    .filter((c) => !c.snipped && c.format?.protocol === 'hls')
    .sort((a, b) => (order[a.preset] ?? 9) - (order[b.preset] ?? 9));

  const params = t.track_authorization ? { track_authorization: t.track_authorization } : {};

  for (const c of tcs) {
    try {
      const r = await apiJson(c.url, params);
      if (r.url) return { ...shape(t), url: r.url, preset: c.preset, mime: c.format?.mime_type || '' };
    } catch (_) {}
  }

  const err = new Error('no HLS stream address was given');
  err.code = 502;
  throw err;
}

axios.defaults.httpsAgent = new (require('https').Agent)({ keepAlive: true, maxSockets: 32 });

async function fetchBuf(url, tries = 3) {
  let last;
  for (let n = 0; n < tries; n++) {
    try {
      const r = await axios.get(url, { headers: WEB_HEADERS, responseType: 'arraybuffer', timeout: TIMEOUT });
      return Buffer.from(r.data);
    } catch (e) {
      last = e;
      const code = e.response?.status;
      if (code && code < 500 && code !== 429) break;
      await new Promise((r) => setTimeout(r, 300 * (n + 1)));
    }
  }
  const where = url.split('?')[0].split('/').slice(-2).join('/');
  last.message = `segment ${where}: ${last.response?.status ? 'HTTP ' + last.response.status : last.message}`;
  throw last;
}

async function playlistParts(playlistUrl) {
  const text = (await http(playlistUrl, { headers: WEB_HEADERS })).data;
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.some((l) => l.startsWith('#EXT-X-KEY') && !l.includes('METHOD=NONE'))) {
    const err = new Error('stream is encrypted');
    err.code = 403;
    throw err;
  }
  const abs = (u) => new URL(u, playlistUrl).href;
  const map = lines.find((l) => l.startsWith('#EXT-X-MAP'));
  const mapUri = map && /URI="([^"]+)"/.exec(map)?.[1];
  const segments = lines.filter((l) => !l.startsWith('#')).map(abs);
  if (!segments.length) {
    const err = new Error('playlist has no segments');
    err.code = 502;
    throw err;
  }
  return { init: mapUri ? abs(mapUri) : null, segments };
}

const HLS_TTL_MS = 10 * 60 * 1000;
const hlsCache = new Map();

function getHlsParts(id) {
  const hit = hlsCache.get(id);
  if (hit && Date.now() - hit.at < HLS_TTL_MS) return hit.promise;
  const promise = resolveHls(id).then(async (s) => ({ ...(await playlistParts(s.url)), mime: s.mime }));
  hlsCache.set(id, { at: Date.now(), promise });
  promise.catch(() => hlsCache.delete(id));
  if (hlsCache.size > 200) hlsCache.delete(hlsCache.keys().next().value);
  return promise;
}

const waitDrain = (res) =>
  new Promise((resolve) => {
    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
    res.once('drain', done);
    res.once('close', done);
  });

const PREFETCH = 4;

async function streamTrack(res, id) {
  const { init, segments, mime } = await getHlsParts(id);
  const urls = init ? [init, ...segments] : segments;
  const type = init || /mp4/i.test(mime) ? 'audio/mp4' : /mpeg/i.test(mime) ? 'audio/mpeg' : 'audio/aac';

  let aborted = false;
  res.on('close', () => { aborted = true; });

  const queue = [];
  let nextIdx = 0;
  const fill = () => {
    while (queue.length < PREFETCH && nextIdx < urls.length) {
      const p = fetchBuf(urls[nextIdx++]);
      p.catch(() => {});
      queue.push(p);
    }
  };

  fill();
  while (queue.length) {
    const buf = await queue.shift();
    fill();
    if (aborted) return;
    if (!res.headersSent) res.set({ 'Content-Type': type, 'Cache-Control': 'no-store' });
    if (!res.write(buf)) await waitDrain(res);
    if (aborted) return;
  }
  res.end();
}

module.exports = { searchSoundCloud, resolveStream, resolveHls, streamTrack, labelOf, WEB_HEADERS };

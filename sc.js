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
  
  const tcs = (t.media?.transcodings || []).filter((c) => !c.snipped).sort((a, b) => rank(a) - rank(b));
  const params = {};
  if (t.track_authorization) params.track_authorization = t.track_authorization;

  const errors = [];
  for (const c of tcs.slice(0, 3)) {
    try {
      const r = await apiJson(c.url, params);
      if (r.url) {
        return {
          ...shape(t),
          stream: {
            url: r.url,
            preset: c.preset,
            protocol: c.format?.protocol,
            mime: c.format?.mime_type,
            headers: PLAY_HEADERS,
          },
        };
      }
    } catch (e) {
      errors.push(`${c.preset}: ${e.response ? 'HTTP ' + e.response.status : e.message}`);
    }
  }
  const err = new Error('no stream address was given' + (errors.length ? ` (${errors.join(', ')})` : ''));
  err.code = 502;
  throw err;
}

module.exports = { searchSoundCloud, resolveStream, labelOf };

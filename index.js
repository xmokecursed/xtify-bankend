// This backend is not the *best* but works. 
// I coded it in a way that support doesn't cause memory overload on my poor server.
// Theres leftover youtube cookies code because initially i thought to add my own dummy account 
// for all fetching but youtube constantly blocks my server so it was moved to the app (built-in)

const express = require('express');
const ytDlpExec = require('yt-dlp-exec');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const YTMusic = require('ytmusic-api');
const { similarSongs, artistSongs } = require('./ytm');
const { searchSoundCloud, resolveStream } = require('./sc');
const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const LASTFM_API_KEY = process.env.LASTFM_API_KEY
// cost LASTFM_API_KEY = process.env.LASTFM_API_KEY || 'fallback api code'; // use this one if .env doesn't work
const LASTFM_API_URL = 'http://ws.audioscrobbler.com/2.0/';

const toArray = x => (x == null ? [] : Array.isArray(x) ? x : [x]);

let YOUTUBE_COOKIES_PATH = process.env.YOUTUBE_COOKIES_PATH;
if (!YOUTUBE_COOKIES_PATH) {
  const secretPath = path.join('/etc/secrets', 'youtube_cookies.txt');
  if (fs.existsSync(secretPath)) YOUTUBE_COOKIES_PATH = secretPath;
}

async function searchWithYtDlp(q, limit = 25, target = `ytsearch${limit}:${q}`) {
  const opts = {
    playlistEnd: limit,
    dumpSingleJson: true,
    noWarnings: true,
    flatPlaylist: true,
    skipDownload: true,
  };

  let tmpPath = null;
  if (YOUTUBE_COOKIES_PATH) {
    tmpPath = `/tmp/youtube_cookies_${Date.now()}_${Math.floor(Math.random() * 10000)}.txt`;
    try {
      fs.copyFileSync(YOUTUBE_COOKIES_PATH, tmpPath);
      opts.cookies = tmpPath;
    } catch (e) {
      tmpPath = null;
    }
  }
  try {
    const info = await ytDlpExec(target, opts);
    return (info.entries || [])
      .filter(v => v && v.id)
      .map(v => ({
        id: v.id,
        title: v.title,
        thumb: v.thumbnails?.[0]?.url,
        duration: v.duration,
      }));
  } finally {
    if (tmpPath) fs.unlink(tmpPath, () => {});
  }
}


const DEFAULT_INSTANCES = [
  'https://pipedapi.ducks.party',
  'https://api.piped.private.coffee',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi-libre.kavin.rocks',
];
const PIPED_INSTANCES = (process.env.PIPED_INSTANCES
  ? process.env.PIPED_INSTANCES.split(',')
  : DEFAULT_INSTANCES
).map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);

const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;

async function searchWithPiped(q, limit = 25) {
  const errors = [];
  const order = PIPED_INSTANCES.map(x => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map(p => p[1]);
  for (const base of order.slice(0, 4)) {
    try {
      const r = await axios.get(base + '/search', { params: { q, filter: 'videos' }, timeout: 8000 });
      if (!r.data || !Array.isArray(r.data.items)) throw new Error('bad response');
      return r.data.items
        .filter(i => i.type === 'stream' && i.url)
        .map(v => ({
          id: (v.url.split('v=')[1] || '').split('&')[0],
          title: v.title,
          thumb: v.thumbnail,
          duration: v.duration,
        }))
        .filter(v => VIDEO_ID.test(v.id))
        .slice(0, limit);
    } catch (e) {
      errors.push(`${base}: ${e.response ? 'HTTP ' + e.response.status : e.message}`);
    }
  }
  throw new Error(errors.join(' | '));
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 400;
const searchCache = new Map();
const inflightSearches = new Map();

const MAX_YTDLP = parseInt(process.env.MAX_YTDLP || '1');
const MEM_LIMIT_MB = parseInt(process.env.MEM_LIMIT_MB || '380');
let ytDlpRunning = 0;
function ytDlpAvailable() {
  const rssMb = process.memoryUsage().rss / 1048576;
  return ytDlpRunning < MAX_YTDLP && rssMb < MEM_LIMIT_MB;
}

const HEDGE_MS = 2000;

async function searchHedged(q, limit = 25) {
  const started = Date.now();
  let done = false;
  const nonEmpty = (source) => (results) => {
    if (!results.length) throw new Error('no results');
    return { source, results };
  };
  let wake;
  const hedge = new Promise(resolve => {
    const timer = setTimeout(resolve, HEDGE_MS);
    wake = () => { clearTimeout(timer); resolve(); };
  });
  if (!ytDlpAvailable()) {
    const results = await searchWithPiped(q, limit);
    if (!results.length) throw new Error('no results');
    console.log(`search "${q}" via piped (yt-dlp busy) in ${Date.now() - started}ms`);
    return results;
  }
  ytDlpRunning++;
  const ytAttempt = searchWithYtDlp(q, limit)
    .then(nonEmpty('yt-dlp'))
    .finally(() => { ytDlpRunning--; });
  ytAttempt.catch(() => wake()); 
  const pipedAttempt = hedge.then(() => {
    if (done) throw new Error('skipped (yt-dlp answered first)');
    return searchWithPiped(q, limit);
  }).then(nonEmpty('piped'));
  const attempts = [ytAttempt, pipedAttempt];
  try {
    const winner = await Promise.any(attempts);
    done = true;
    console.log(`search "${q}" via ${winner.source} in ${Date.now() - started}ms`);
    return winner.results;
  } catch (e) {
    done = true;
    const [ytErr, pipedErr] = e.errors || [];
    console.log(`search "${q}" failed in ${Date.now() - started}ms`);
    const err = new Error('Search failed');
    err.details = {
      ytDlp: (ytErr?.message || '').slice(0, 300),
      piped: (pipedErr?.message || '').slice(0, 500),
    };
    throw err;
  }
}

app.get('/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.status(400).send({ error: 'Query required' });
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 5), 50);

  const key = `${q.toLowerCase()}|${limit}`;
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return res.send(hit.results);

  try {
    let pending = inflightSearches.get(key);
    if (!pending) {
      pending = searchHedged(q, limit).finally(() => inflightSearches.delete(key));
      inflightSearches.set(key, pending);
    }
    const results = await pending;
    if (searchCache.size >= CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
    searchCache.set(key, { at: Date.now(), results });
    res.send(results);
  } catch (e) {
    res.status(502).send({ error: e.message, ...(e.details || {}) });
  }
});

app.get('/similar/:artist', async (req, res) => {
  try {
    const { artist } = req.params;
    const response = await axios.get(LASTFM_API_URL, {
      params: {
        method: 'artist.getsimilar',
        artist,
        api_key: LASTFM_API_KEY,
        format: 'json',
        limit: 10,
      },
    });
    if (!response.data.similarartists || !response.data.similarartists.artist) {
      return res.send([]);
    }
    const artists = response.data.similarartists.artist.map(a => ({
      name: a.name,
      url: a.url,
      image: a.image.find(i => i.size === 'large')?.['#text'],
    }));
    res.send(artists);
  } catch (e) {
    res.status(500).send({ error: e.message });
  }
});

app.get('/radio/:artist', async (req, res) => {
  try {
    const { artist } = req.params;
    const response = await axios.get(LASTFM_API_URL, {
      params: {
        method: 'artist.gettoptracks',
        artist,
        api_key: LASTFM_API_KEY,
        format: 'json',
        limit: 10,
      },
    });
    if (!response.data.toptracks || !response.data.toptracks.track) {
      return res.send([]);
    }
    const tracks = response.data.toptracks.track.map(t => ({
      name: t.name,
      artist: t.artist.name,
      url: t.url,
      duration: t.duration,
    }));
    res.send(tracks);
  } catch (e) {
    res.status(500).send({ error: e.message });
  }
});

app.get('/similar-tracks/:artist/:track', async (req, res) => {
  try {
    const { artist, track } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 30, 50);
    const response = await axios.get(LASTFM_API_URL, {
      params: {
        method: 'track.getsimilar',
        artist,
        track,
        autocorrect: 1,
        api_key: LASTFM_API_KEY,
        format: 'json',
        limit,
      },
    });
    const similar = toArray(response.data.similartracks?.track);
    res.send(
      similar
        .map(t => ({
          name: t.name,
          artist: t.artist?.name,
          match: parseFloat(t.match) || 0,
        }))
        .filter(t => t.name && t.artist),
    );
  } catch (e) {
    res.status(500).send({ error: e.message });
  }
});

const trendingCache = new Map();
const TRENDING_TTL_MS = 60 * 60 * 1000;

app.get('/trending', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 24, 1), 50);
    const country = (req.query.country || '').toString().trim();
    const key = `${country.toLowerCase()}|${limit}`;
    const hit = trendingCache.get(key);
    if (hit && Date.now() - hit.at < TRENDING_TTL_MS) return res.send(hit.data);

    const response = await axios.get(LASTFM_API_URL, {
      params: {
        method: country ? 'geo.gettoptracks' : 'chart.gettoptracks',
        ...(country ? { country } : {}),
        api_key: LASTFM_API_KEY,
        format: 'json',
        limit,
      },
    });
    const data = toArray(response.data.tracks?.track)
      .map(t => ({ name: t.name, artist: t.artist?.name }))
      .filter(t => t.name && t.artist);
    trendingCache.set(key, { at: Date.now(), data });
    res.send(data);
  } catch (e) {
    res.status(500).send({ error: e.message });
  }
});


const relatedCache = new Map();
app.get('/related/:id', async (req, res) => {
  const id = req.params.id;
  if (!VIDEO_ID.test(id)) return res.status(400).send({ error: 'bad video id' });
  const hit = relatedCache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return res.send(hit.data);
  if (!ytDlpAvailable()) return res.status(503).send({ error: 'busy' }); // app falls back to Last.fm
  ytDlpRunning++;
  try {
    const all = await searchWithYtDlp(id, 30, `https://www.youtube.com/watch?v=${id}&list=RD${id}`);
    const data = all.filter(v => v.id !== id);
    if (data.length) {
      if (relatedCache.size >= 300) relatedCache.delete(relatedCache.keys().next().value);
      relatedCache.set(id, { at: Date.now(), data });
    }
    res.send(data);
  } catch (e) {
    res.status(502).send({ error: e.message });
  } finally {
    ytDlpRunning--;
  }
});

let ytmReady = null;
function ytm() {
  if (!ytmReady) {
    const client = new YTMusic();
    ytmReady = client.initialize().then(() => client).catch(e => { ytmReady = null; throw e; });
  }
  return ytmReady;
}
const ytmCache = new Map();

app.get('/ytm/similar/:id', async (req, res) => {
  const id = req.params.id;
  if (!VIDEO_ID.test(id)) return res.status(400).send({ error: 'bad video id' });
  const hit = ytmCache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return res.send(hit.data);
  try {
    const data = await similarSongs(await ytm(), id, (req.query.q || '').toString().trim(), (req.query.artist || '').toString().trim());
    if (data.length) {
      if (ytmCache.size >= 300) ytmCache.delete(ytmCache.keys().next().value);
      ytmCache.set(id, { at: Date.now(), data });
    }
    res.send(data);
  } catch (e) {
    res.status(502).send({ error: e.message });
  }
});

const ytmArtistCache = new Map();

app.get('/ytm/artist/:name', async (req, res) => {
  const name = (req.params.name || '').trim();
  if (!name || name.length > 100) return res.status(400).send({ error: 'bad artist name' });
  const key = name.toLowerCase();
  const hit = ytmArtistCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return res.send(hit.data);
  try {
    const data = await artistSongs(await ytm(), name);
    if (data.length) {
      if (ytmArtistCache.size >= 200) ytmArtistCache.delete(ytmArtistCache.keys().next().value);
      ytmArtistCache.set(key, { at: Date.now(), data });
    }
    res.send(data);
  } catch (e) {
    res.status(502).send({ error: e.message });
  }
});

const SC_SEARCH_TTL_MS = 60 * 60 * 1000;
const scSearchCache = new Map();

app.get('/sc/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q || q.length > 200) return res.status(400).send({ error: 'Query required' });
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 15, 1), 30);
  const onlyPlayable = ['1', 'true'].includes((req.query.playable || '').toString());

  const key = `${q.toLowerCase()}|${limit}`;
  let results;
  const hit = scSearchCache.get(key);
  if (hit && Date.now() - hit.at < SC_SEARCH_TTL_MS) {
    results = hit.results;
  } else {
    try {
      results = await searchSoundCloud(q, limit);
    } catch (e) {
      return res.status(502).send({ error: e.response ? `SoundCloud HTTP ${e.response.status}` : e.message });
    }
    if (results.length) {
      if (scSearchCache.size >= 200) scSearchCache.delete(scSearchCache.keys().next().value);
      scSearchCache.set(key, { at: Date.now(), results });
    }
  }
  res.send(onlyPlayable ? results.filter(r => r.status === 'playable') : results);
});

app.get('/sc/stream/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^\d{1,20}$/.test(id)) return res.status(400).send({ error: 'bad track id' });
  try {
    res.send(await resolveStream(id));
  } catch (e) {
    if (e.status) return res.status(403).send({ error: e.message, status: e.status });
    const upstream = e.response?.status;
    if (upstream === 404) return res.status(404).send({ error: 'track not found' });
    res.status(502).send({ error: upstream ? `SoundCloud HTTP ${upstream}` : e.message });
  }
});

app.get('/test', (req, res) => {
  res.send('OK');
});

app.get('/album/:artist/:album', async (req, res) => {
  try {
    const { artist, album } = req.params;
    const response = await axios.get(LASTFM_API_URL, {
      params: {
        method: 'album.getinfo',
        artist,
        album,
        api_key: LASTFM_API_KEY,
        format: 'json',
      },
    });

    if (!response.data.album) {
      return res.status(404).send({ error: 'Album not found' });
    }

    const albumData = response.data.album;
    const formattedAlbum = {
      name: albumData.name,
      artist: albumData.artist,
      mbid: albumData.mbid,
      url: albumData.url,
      image: toArray(albumData.image).reduce((acc, img) => {
        if (img['#text']) {
          acc[img.size] = img['#text'];
        }
        return acc;
      }, {}),
      listeners: parseInt(albumData.listeners) || 0,
      playcount: parseInt(albumData.playcount) || 0,
      tags: toArray(albumData.tags?.tag).map(tag => tag.name),
      tracks: toArray(albumData.tracks?.track).map(track => ({
        name: track.name,
        duration: parseInt(track.duration) || 0,
        url: track.url,
        streamable: track.streamable?.fulltrack === '1',
        artist: {
          name: track.artist?.name,
          mbid: track.artist?.mbid,
          url: track.artist?.url,
        },
      })),
    };

    res.send(formattedAlbum);
  } catch (e) {
    console.error('Error fetching album info:', e.message);
    res.status(500).send({ error: 'Failed to fetch album information' });
  }
});

app.get('/track/search', async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;
    if (!q) {
      return res.status(400).send({ error: 'Query parameter "q" is required' });
    }

    const response = await axios.get(LASTFM_API_URL, {
      params: {
        method: 'track.search',
        track: q,
        api_key: LASTFM_API_KEY,
        format: 'json',
        limit: Math.min(parseInt(limit) || 10, 50), // Cap at 50
      },
    });

    const matches = toArray(response.data.results?.trackmatches?.track);
    if (!matches.length) {
      return res.send([]);
    }

    const tracks = matches.map(track => ({
      name: track.name,
      artist: track.artist,
      url: track.url,
      streamable: track.streamable === '1',
      listeners: parseInt(track.listeners) || 0,
      mbid: track.mbid,
      image: toArray(track.image).reduce((acc, img) => {
        if (img['#text']) {
          acc[img.size] = img['#text'];
        }
        return acc;
      }, {}),
    }));

    res.send(tracks);
  } catch (e) {
    console.error('Error searching tracks:', e.message);
    res.status(500).send({ error: 'Failed to search tracks' });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

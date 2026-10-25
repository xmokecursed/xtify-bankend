const norm = (s) =>
  String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const artistOf = (x) => {
  const pick = (v) => {
    if (Array.isArray(v)) return pick(v.find((e) => pick(e)));
    if (typeof v === 'string') return v.trim();
    return v && typeof v.name === 'string' ? v.name.trim() : '';
  };
  return pick(x?.artists) || pick(x?.artist) || '';
};

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

async function fillArtists(ytm, rows, max = 12) {
  const missing = rows.filter((r) => r.videoId && !r.artist).slice(0, max);
  await Promise.all(
    missing.map(async (r) => {
      try {
        r.artist = artistOf(await withTimeout(ytm.getSong(r.videoId), 5000));
      } catch (e) { /* stays empty: the app skips songs without an artist */ }
    })
  );
}

const nameInQuery = (name, q) => {
  const n = norm(name);
  return n.length >= 2 && norm(q).includes(n);
};

function pickAnchor(results, q) {
  const nq = norm(q);
  let best = null;
  let bestScore = 0;
  for (const s of results || []) {
    const t = norm(s.name);
    if (!s.videoId || t.length < 3 || !nq.includes(t)) continue;
    const hasArtist = nameInQuery(s.artist?.name, q);
    if (!hasArtist && t.length * 2 < nq.length) continue;
    const score = t.length + (hasArtist ? 100 : 0);
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

const sameArtist = (a, b) =>
  a.artist?.artistId && b.artist?.artistId
    ? a.artist.artistId === b.artist.artistId
    : norm(a.artist?.name) === norm(b.artist?.name);

async function similarSongs(ytm, id, q, artist = '', limit = 25) {
  const out = [];
  const seen = new Set([id]);
  const add = (videoId, title, artist, duration) => {
    if (!videoId || !title || seen.has(videoId)) return;
    seen.add(videoId);
    out.push({
      id: videoId,
      title,
      artist: artist || '',
      duration, // seconds, same as /search
      thumb: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    });
  };

  let query = q;
  if (!query) {
    try {
      const s = await ytm.getSong(id);
      query = `${s.artist?.name || ''} ${s.name}`.trim();
    } catch (e) { /* no title available */ }
  }

  let results = [];
  if (query) {
    try {
      results = await ytm.searchSongs(query);
    } catch (e) {
      console.log(`ytm search failed for "${query}": ${e.message}`);
    }
  }
  const anchor = pickAnchor(results, query);
  if (anchor) seen.add(anchor.videoId);

  try {
    const radio = (await ytm.getUpNexts(anchor ? anchor.videoId : id)).map((s) => ({
      videoId: s.videoId,
      title: s.title,
      artist: artistOf(s),
      duration: s.duration,
    }));
    await fillArtists(ytm, radio);
    for (const r of radio) add(r.videoId, r.title, r.artist, r.duration);
  } catch (e) {
    console.log(`ytm radio failed for ${anchor ? anchor.videoId : id}: ${e.message}`);
  }

  let artistId = anchor?.artist?.artistId;
  if (!anchor && artist && out.length < 10) {
    try {
      const hits = await ytm.searchArtists(artist);
      artistId = hits.find((h) => norm(h.name) === norm(artist))?.artistId;
    } catch (e) {
      console.log(`ytm artist search failed for "${artist}": ${e.message}`);
    }
  }

  if (out.length < 10 && artistId) {
    try {
      for (const s of await ytm.getArtistSongs(artistId)) {
        if (s.artist?.artistId && s.artist.artistId !== artistId) continue;
        add(s.videoId, s.name, artistOf(s) || anchor?.artist?.name || artist, s.duration);
      }
    } catch (e) {
      console.log(`ytm artist songs failed for ${artistId}: ${e.message}`);
    }
  }

  if (out.length < 5) {
    for (const s of results) {
      const same = anchor ? sameArtist(s, anchor) : nameInQuery(s.artist?.name, query);
      if (same) add(s.videoId, s.name, artistOf(s), s.duration);
    }
  }
  return out.slice(0, limit);
}

async function artistSongs(ytm, name, limit = 25) {
  let hits = null;
  try { hits = await ytm.searchArtists(name); } catch { /* name mode below */ }
  let found = null;
  if (hits) {
    found = hits.find((h) => norm(h.name) === norm(name));
    if (!found?.artistId) return [];
  }
  const out = [];
  const seen = new Set();
  const add = (rows, fromSearch) => {
    for (const s of rows || []) {
      if (!s.videoId || !s.name || seen.has(s.videoId)) continue;
      if (found) {
        if (s.artist?.artistId ? s.artist.artistId !== found.artistId : fromSearch) continue;
      } else if (norm(s.artist?.name) !== norm(name)) {
        continue;
      }
      seen.add(s.videoId);
      out.push({
        id: s.videoId,
        title: s.name,
        artist: artistOf(s) || found?.name || name,
        duration: s.duration, // seconds, same as /search
        thumb: `https://i.ytimg.com/vi/${s.videoId}/mqdefault.jpg`,
      });
    }
  };
  if (found) {
    try { add(await ytm.getArtistSongs(found.artistId), false); } catch { /* try search */ }
  }
  if (out.length < 10) {
    try { add(await ytm.searchSongs(name), true); } catch { /* keep what we have */ }
  }
  return out.slice(0, limit);
}

module.exports = { similarSongs, pickAnchor, artistSongs };

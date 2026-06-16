#!/usr/bin/env node
// Spotify playlist -> music-data.js ingester.
//
// Pulls every track from a Spotify playlist via the Client Credentials flow,
// matches each one to a Deezer track (by ISRC) so the runtime 30s preview works,
// pulls genre from Spotify, derives mood/vibe tags, optionally looks up artist
// nationality via MusicBrainz, dedupes against what is already in music-data.js,
// and appends the new songs with n continuing from the current max.
//
// The Spotify secret lives ONLY in tools/.spotify-creds.json (gitignored) or env.
// Descriptions are left empty here (the page hides an empty blurb); use
// tools/enrich-descriptions.mjs later to backfill blurbs for any subset.
//
// Usage:
//   node tools/spotify-ingest.mjs <playlistUrlOrId> [--no-nationality] [--dry]
//
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..');
const DATA = path.join(ROOT, 'music-data.js');
const CACHE_DIR = path.join(__dir, '.cache');
const DZ_CACHE = path.join(CACHE_DIR, 'deezer.json');
const MB_CACHE = path.join(CACHE_DIR, 'nationality.json');

// ---------- args ----------
const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const input = args.find(a => !a.startsWith('--'));
const DRY = flags.has('--dry');
const DO_NATIONALITY = !flags.has('--no-nationality');
if (!input) { console.error('usage: node tools/spotify-ingest.mjs <playlistUrlOrId> [--no-nationality] [--dry]'); process.exit(1); }

// ---------- helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJSON = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const writeJSON = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 1)); };
const titleCase = s => s.replace(/\b\w/g, c => c.toUpperCase());

function getCreds() {
  if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET)
    return { clientId: process.env.SPOTIFY_CLIENT_ID, clientSecret: process.env.SPOTIFY_CLIENT_SECRET };
  const c = readJSON(path.join(__dir, '.spotify-creds.json'), null);
  if (!c) { console.error('missing creds: set SPOTIFY_CLIENT_ID/SECRET env or tools/.spotify-creds.json'); process.exit(1); }
  return c;
}

function parsePlaylistId(s) {
  let m = s.match(/playlist[/:]([A-Za-z0-9]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9]+$/.test(s)) return s;
  console.error('could not parse a playlist id from:', s); process.exit(1);
}

// ---------- spotify ----------
async function spotifyToken({ clientId, clientSecret }) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) { console.error('token error', res.status, await res.text()); process.exit(1); }
  return (await res.json()).access_token;
}

async function spGet(url, token) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) { await sleep((Number(res.headers.get('retry-after')) || 2) * 1000); continue; }
    if (!res.ok) throw new Error(`spotify ${res.status} ${url} ${await res.text()}`);
    return res.json();
  }
  throw new Error('spotify rate-limited repeatedly: ' + url);
}

async function fetchPlaylist(id, token) {
  const meta = await spGet(`https://api.spotify.com/v1/playlists/${id}?fields=name,tracks(total)`, token);
  const tracks = [];
  let url = `https://api.spotify.com/v1/playlists/${id}/tracks?limit=100&fields=next,items(track(id,name,duration_ms,external_ids,external_urls,is_local,artists(id,name),album(name,images)))`;
  while (url) {
    const page = await spGet(url, token);
    for (const it of page.items) {
      const t = it.track;
      if (!t || t.is_local || !t.id) continue;
      tracks.push(t);
    }
    url = page.next;
  }
  return { name: meta.name, tracks };
}

async function fetchArtistGenres(ids, token) {
  const genres = {};
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const data = await spGet(`https://api.spotify.com/v1/artists?ids=${batch.join(',')}`, token);
    for (const a of data.artists) if (a) genres[a.id] = a.genres || [];
  }
  return genres;
}

// ---------- deezer (preview matching by ISRC, with retry + search fallback) ----------
const dzCache = readJSON(DZ_CACHE, {});
// Deezer rate-limits hard (~50 req / 5s). Codes 4 (quota) and 700 (busy) mean
// "back off and retry", NOT "no result", so we must not cache those as a miss.
async function dzFetch(url) {
  for (let a = 0; a < 7; a++) {
    try {
      const r = await fetch(url);
      if (r.status === 429) { await sleep(1500 * (a + 1)); continue; }
      const d = await r.json();
      if (d && d.error && (d.error.code === 4 || d.error.code === 700)) { await sleep(1500 * (a + 1)); continue; }
      return d;
    } catch { await sleep(800 * (a + 1)); }
  }
  return null;
}
async function deezerMatch(row) {
  const key = row.isrc || ('q:' + row.title + '|' + row.artist);
  if (key in dzCache) return dzCache[key];
  let out = null;
  if (row.isrc) {
    const d = await dzFetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(row.isrc)}`);
    if (d && d.id && !d.error) out = { id: d.id, md5: d.md5_image || (d.album && d.album.md5_image) || null };
  }
  if (!out) { // ISRC missing/mismatched -> fall back to title + primary artist search
    const q = encodeURIComponent(`track:"${row.title}" artist:"${row.artist.split(',')[0].trim()}"`);
    const d = await dzFetch(`https://api.deezer.com/search?limit=1&q=${q}`);
    if (d && d.data && d.data[0]) { const t = d.data[0]; out = { id: t.id, md5: t.album && t.album.md5_image }; }
  }
  dzCache[key] = out;
  await sleep(80); // gentle pacing
  return out;
}

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// ---------- nationality (MusicBrainz, per unique artist, cached, 1 req/sec) ----------
const COUNTRY = { US:'American', GB:'British', CA:'Canadian', AU:'Australian', JP:'Japanese',
  FR:'French', DE:'German', SE:'Swedish', NO:'Norwegian', IE:'Irish', NL:'Dutch', NZ:'New Zealander',
  IS:'Icelandic', KR:'Korean', JM:'Jamaican', BR:'Brazilian', MX:'Mexican', ES:'Spanish', IT:'Italian',
  NG:'Nigerian', ZA:'South African', IN:'Indian', DK:'Danish', BE:'Belgian', PR:'Puerto Rican' };
const mbCache = readJSON(MB_CACHE, {});
async function nationalityFor(artist) {
  if (artist in mbCache) return mbCache[artist];
  let nat = '';
  try {
    const url = `https://musicbrainz.org/ws/2/artist?query=${encodeURIComponent('artist:"' + artist + '"')}&fmt=json&limit=1`;
    const r = await fetch(url, { headers: { 'User-Agent': 'armaanjhajj.com-music/1.0 (personal site)' } });
    if (r.ok) {
      const d = await r.json();
      const c = d.artists && d.artists[0] && (d.artists[0].country || (d.artists[0].area && d.artists[0]['begin-area']));
      const code = d.artists && d.artists[0] && d.artists[0].country;
      if (code) nat = COUNTRY[code] || '';
    }
  } catch {}
  mbCache[artist] = nat;
  await sleep(1100); // be polite to MusicBrainz
  return nat;
}

// ---------- mood / vibe heuristics from genre text ----------
function tagsFromGenres(genreList) {
  const g = genreList.join(' ').toLowerCase();
  const has = (...ks) => ks.some(k => g.includes(k));
  if (has('shoegaze', 'dream pop', 'dreampop')) return { mood: ['dreamy', 'hazy', 'ethereal'], vibe: ['washed-out', 'reverb-soaked', 'floating'] };
  if (has('ambient')) return { mood: ['serene', 'contemplative', 'spacious'], vibe: ['atmospheric', 'floating', 'late-night'] };
  if (has('rage', 'plugg')) return { mood: ['hard', 'spacey', 'hypnotic'], vibe: ['hype', 'underground', 'trap'] };
  if (has('trap', 'drill')) return { mood: ['hard', 'cold', 'moody'], vibe: ['nocturnal', 'flexing', 'hype'] };
  if (has('rap', 'hip hop', 'hip-hop')) return { mood: ['confident', 'nocturnal', 'reflective'], vibe: ['late-night', 'bars', 'driving'] };
  if (has('r&b', 'rnb', 'soul', 'neo soul')) return { mood: ['smooth', 'sensual', 'tender'], vibe: ['late-night', 'slow-burn', 'intimate'] };
  if (has('psych')) return { mood: ['dreamy', 'hypnotic', 'warm'], vibe: ['kaleidoscopic', 'sunset', 'floaty'] };
  if (has('indie pop', 'bedroom pop', 'jangle')) return { mood: ['bittersweet', 'wistful', 'bright'], vibe: ['lo-fi', 'feel-good', 'nostalgic'] };
  if (has('indie rock', 'garage', 'alternative rock', 'permanent wave', 'britpop')) return { mood: ['restless', 'yearning', 'swaggering'], vibe: ['windows-down', 'driving', 'anthemic'] };
  if (has('house', 'techno', 'edm', 'electronic', 'dance')) return { mood: ['euphoric', 'propulsive', 'hypnotic'], vibe: ['dancefloor', 'pulsing', 'late-night'] };
  if (has('rock', 'metal', 'punk')) return { mood: ['raw', 'driving', 'defiant'], vibe: ['loud', 'anthemic', 'restless'] };
  if (has('folk', 'singer-songwriter', 'acoustic')) return { mood: ['tender', 'wistful', 'intimate'], vibe: ['acoustic', 'rainy-day', 'hushed'] };
  if (has('jazz', 'lounge', 'bossa', 'city pop')) return { mood: ['smooth', 'warm', 'nostalgic'], vibe: ['lush', 'late-night', 'cocktail'] };
  if (has('pop')) return { mood: ['bright', 'catchy', 'warm'], vibe: ['feel-good', 'radio', 'sunny'] };
  return { mood: ['eclectic', 'moody', 'warm'], vibe: ['late-night', 'mixtape', 'discovery'] };
}

function pickCovers(images) {
  if (!images || !images.length) return { big: '', small: '' };
  const sorted = [...images].sort((a, b) => (b.width || 0) - (a.width || 0));
  const big = sorted[0].url;
  const small = (sorted.find(i => i.width && i.width <= 320) || sorted[sorted.length - 1]).url;
  return { big, small };
}

// ---------- main ----------
(async () => {
  const creds = getCreds();
  const token = await spotifyToken(creds);
  const id = parsePlaylistId(input);
  console.log('fetching playlist', id, '...');
  const { name, tracks } = await fetchPlaylist(id, token);
  console.log(`playlist "${name}" -> ${tracks.length} tracks`);

  // genres
  const artistIds = [...new Set(tracks.flatMap(t => t.artists.map(a => a.id)).filter(Boolean))];
  console.log(`fetching genres for ${artistIds.length} artists ...`);
  const genreMap = await fetchArtistGenres(artistIds, token);

  // existing data
  const src = fs.readFileSync(DATA, 'utf8');
  const header = src.slice(0, src.indexOf('['));
  const SONGS = eval(src.slice(src.indexOf('['), src.lastIndexOf(']') + 1));
  const seenKey = new Set(SONGS.map(s => (s.title + '|' + s.artist).toLowerCase()));
  const seenISRC = new Set(SONGS.map(s => s.isrc).filter(Boolean));
  let n = Math.max(0, ...SONGS.map(s => s.n));

  // build candidate rows, dedupe
  const rows = [];
  for (const t of tracks) {
    const artist = t.artists.map(a => a.name).join(', ');
    const isrc = t.external_ids && t.external_ids.isrc;
    const key = (t.name + '|' + artist).toLowerCase();
    if (isrc && seenISRC.has(isrc)) continue;
    if (seenKey.has(key)) continue;
    seenKey.add(key); if (isrc) seenISRC.add(isrc);
    rows.push({ t, artist, isrc });
  }
  console.log(`${rows.length} new after dedupe (skipped ${tracks.length - rows.length} already-present/duplicate)`);

  // deezer preview match (parallel)
  console.log('matching previews on Deezer (by ISRC, with fallback) ...');
  const dz = await mapPool(rows, 4, r => deezerMatch(r));
  writeJSON(DZ_CACHE, dzCache);
  const matched = dz.filter(Boolean).length;
  console.log(`deezer preview matched: ${matched}/${rows.length}`);

  // nationality (per unique artist)
  let natMap = {};
  if (DO_NATIONALITY) {
    const uniqArtists = [...new Set(rows.map(r => r.t.artists[0] && r.t.artists[0].name).filter(Boolean))];
    console.log(`looking up nationality for ${uniqArtists.length} artists via MusicBrainz (~1/sec) ...`);
    for (const a of uniqArtists) natMap[a] = await nationalityFor(a);
    writeJSON(MB_CACHE, mbCache);
  }

  // assemble
  const enc = encodeURIComponent;
  rows.forEach((r, i) => {
    const t = r.t;
    const primaryArtistId = t.artists[0] && t.artists[0].id;
    const genres = (genreMap[primaryArtistId] || []);
    const genre = genres.length ? titleCase(genres[0]) : '';
    const { mood, vibe } = tagsFromGenres(genres);
    const covers = pickCovers(t.album.images);
    const d = dz[i];
    const q = enc(`${t.name} ${r.artist}`);
    n++;
    SONGS.push({
      n, title: t.name, artist: r.artist, album: t.album.name,
      cover: covers.big, coverSmall: covers.small,
      deezerId: d ? d.id : null,
      deezerLink: d ? `https://www.deezer.com/track/${d.id}` : '',
      duration: Math.round(t.duration_ms / 1000),
      genre, nationality: DO_NATIONALITY ? (natMap[t.artists[0] && t.artists[0].name] || '') : '',
      mood, vibe, description: '',
      isrc: r.isrc || '',
      spotify: (t.external_urls && t.external_urls.spotify) || `https://open.spotify.com/search/${q}`,
      apple: `https://music.apple.com/us/search?term=${q}`,
    });
  });

  console.log(`\nwould add ${rows.length} songs -> new total ${SONGS.length}`);
  if (DRY) { console.log('(dry run, not writing)'); return; }
  fs.writeFileSync(DATA, header + JSON.stringify(SONGS, null, 2) + ';\n');
  console.log('wrote music-data.js');
})().catch(e => { console.error(e); process.exit(1); });

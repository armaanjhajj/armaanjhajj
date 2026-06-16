# music ingest tooling

Local, offline scripts that build `music-data.js` from Spotify playlists. The
Spotify secret stays in `tools/.spotify-creds.json` (gitignored) and is never
committed or shipped to the static site.

## Setup
`tools/.spotify-creds.json` (already gitignored):
```json
{ "clientId": "...", "clientSecret": "..." }
```
Get these from https://developer.spotify.com/dashboard. Rotate the secret if it
ever leaks. Env vars `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` override the file.

## Ingest a playlist
```
node tools/spotify-ingest.mjs <playlistUrlOrId> [--no-nationality] [--dry]
```
- Pulls every track (paged), dedupes against what is already in `music-data.js`
  by ISRC and by title+artist, and appends new songs with `n` continuing.
- Fills: title, artist, album, cover (Spotify), duration, real Spotify link,
  Apple Music search link, genre (Spotify artist genre), mood/vibe (derived from
  genre), and the Deezer track id (matched by ISRC) so the 30s preview works.
- `--no-nationality` skips the MusicBrainz lookup (it runs ~1 request/sec per
  unique artist, the slow part). Results are cached in `tools/.cache/`.
- `--dry` fetches and reports without writing.
- Descriptions are left empty (the page hides an empty blurb). Backfill later.

## Notes
- Editorial / algorithmic Spotify playlists (ids starting `37i9`) are blocked for
  API apps. Use your own playlists or any public user playlist.
- Re-running the same playlist adds nothing (dedupe), so it is safe to re-run.

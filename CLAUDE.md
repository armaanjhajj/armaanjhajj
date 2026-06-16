# armaanjhajj.github.io — house rules

Static personal site (plain HTML/CSS/JS, no build step). Served via GitHub Pages / Vercel (`vercel.json` has `cleanUrls: true`, so internal links use `/page` not `/page.html`).

## Writing & punctuation — STRICT, no exceptions

These apply to ALL user-facing copy: page text, titles, song descriptions, form messages, alt text, placeholders, comments that ship — everything.

- **NO em dashes (—). Ever.** Do not use them anywhere. Rewrite the sentence instead: split into two sentences with a period, or use a comma or colon. Do not "compromise" with an em dash.
- **NO oxford comma.** In a list of three or more, do not put a comma before the final `and`/`or`. Write "a, b and c", never "a, b, and c".
- En dashes (–) are currently used only as the separator in `<title>` tags ("page – armaan jhajj"). Keep titles consistent with that. Do not introduce en dashes into body copy.

## Visual style — STRICT

- **NO rounded corners. Everything is sharp.** Never use `border-radius` (no rounded buttons, cards, inputs, chips, pills, tags, modals, or circular icons/avatars). All corners are square, including elements that are conventionally round (play buttons, badges, etc.).
- **Black and white only.** No accent colors in the UI. Text/borders/active states are black, grey or white.
  - The single exception: on `music.html`, the song-count number uses the purple `--count` (`#4b2ca0`). Nothing else gets color.
- Font is Playfair Display (serif) across the site. Background white, text `#111`.

## When adding or editing anything

- Check copy for em dashes and oxford commas before saving.
- Check CSS for `border-radius` before saving.
- Match the existing minimal aesthetic of the other pages.

## music.html / music-data.js

- `music-data.js` holds the `SONGS` array (the source of truth, version controlled). Cover art + metadata come from Spotify/Deezer; `genre`, `nationality`, `mood`, `vibe` are filled by the ingest tool or by hand.
- `n` is the song's position/number; the list renders in `n` order by default and the number is shown only inside the modal (hidden on cards).
- Preview audio is fetched fresh at runtime via the Deezer JSONP API by `deezerId` (the baked preview URLs would expire, so they are never stored).
- There are NO descriptions on the page anymore. Each song instead has a public "thoughts" guestbook (name + thought) backed by Supabase table `public.song_thoughts`, keyed by a slug of title+artist (`songKey()` in music.html). Schema/RLS live in `tools/song_thoughts.sql`. Reuses the same Supabase project + publishable key as the commissions form.
- Bulk imports: `tools/spotify-ingest.mjs <playlist>` pulls a Spotify playlist, matches Deezer previews by ISRC, dedupes, and appends. Spotify creds live in gitignored `tools/.spotify-creds.json`. See `tools/README.md`.
- Reordering: change `n` values so the array stays numbered 1..N. The `song_key` for thoughts is title+artist based, so it survives renumbering.

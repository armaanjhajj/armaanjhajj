-- Run this once in the Supabase SQL editor (Dashboard > SQL Editor > New query).
-- Creates the public "thoughts" guestbook for the music page and lets anyone
-- (anon publishable key) read and post, with light length validation.

create table if not exists public.song_thoughts (
  id          bigint generated always as identity primary key,
  song_key    text        not null,
  name        text        not null,
  thought     text        not null,
  created_at  timestamptz not null default now()
);

alter table public.song_thoughts enable row level security;

-- anyone can read all thoughts
create policy "public read thoughts"
  on public.song_thoughts for select
  to anon, authenticated
  using (true);

-- anyone can add a thought (basic length guards server-side)
create policy "public insert thoughts"
  on public.song_thoughts for insert
  to anon, authenticated
  with check (
    char_length(name) between 1 and 80
    and char_length(thought) between 1 and 2000
  );

create index if not exists song_thoughts_key_idx
  on public.song_thoughts (song_key, created_at desc);

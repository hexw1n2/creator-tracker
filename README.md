# Creator Tracker

A small installable phone app for tracking TikTok creator campaigns: paste video links, review them, pay per video or per batch, and see totals per campaign. Data is stored in Supabase and protected by row level security, so only the owner's login can read or change anything.

Hosted with GitHub Pages. The Supabase publishable key in `index.html` is meant to be public.

## Working on it

- `AGENTS.md` explains how everything fits together and the rules for AI helpers.
- `docs/local-ai-setup.md` sets up a free AI helper on your own computer.
- `supabase/` holds copies of the server functions and the database layout (reference only).

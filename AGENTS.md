# Creator Tracker: guide for AI helpers

Read this whole file before changing anything. The owner is not a programmer. Explain what you plan to do in plain words, make small changes, and ask before anything risky.

## What the app does

The owner pays TikTok creators to post videos for campaigns. The app is an installable phone web app (PWA):

1. **Add:** paste a TikTok link. The server reads the creator and post date from it and files the video under the current campaign.
2. **Review:** new videos are `Submitted`. The owner marks them `Approved` or `Rejected`.
3. **Pay:** inside a creator, tick videos and record a payment. Videos become `Paid`. Paying an already-paid video needs an extra "Yes, pay again" tick.
4. **Campaigns:** each campaign has a color. The whole app turns that color while it's the current campaign. The Campaigns tab shows spent and owed.
5. **Stats:** views and likes refresh every morning (7am Pacific) from TikTok's public pages.

Pay for one video = flat rate + views ÷ 1000 × CPM + the highest bonus tier reached, capped at a max. Creator values override the defaults in Settings. `amount_override` on a video replaces the formula.

## Where things live

| Part | Where | How it updates |
|---|---|---|
| Phone app | `index.html` (all HTML, CSS and JS in one file), `sw.js`, `manifest.webmanifest`, icons | Push to `main` on GitHub. GitHub Pages serves it at https://hexw1n2.github.io/creator-tracker/ within about a minute |
| Supabase client library | `vendor/supabase-2.117.3.js` | Don't edit |
| Database | Supabase project `kitugmudlzqltsajqipt` (free plan). Layout copy in `supabase/schema.sql` | Only through the Supabase dashboard SQL editor, by the owner |
| Server code | `supabase/functions/add-links`, `supabase/functions/refresh-stats` (Deno, TypeScript) | Copies of what's deployed. Deploying is done in Supabase (see below) |

The app talks to Supabase directly with the **publishable key** in `index.html`. That key is meant to be public. Security comes from row level security: every table only answers the owner's login (`is_owner()` checks the user id in `app_owners`).

## Rules (must follow)

1. **Never put secrets in this repo.** It is public. No service-role or secret keys, no passwords, no API tokens, no personal emails. The publishable key (`sb_publishable_...`) is the only key allowed.
2. **Never touch payment history.** Don't write code that deletes or edits `payouts` or `payout_items`, or changes a `Paid` video back. Paid records are the owner's money trail.
3. **Don't weaken security.** Keep row level security, `is_owner()`, the Content-Security-Policy meta tag, the `esc()` and `js()` escaping in `index.html`, and the TikTok-only checks in the server code.
4. **Database and server changes are proposals.** You can't change the live database or server from here. Write the SQL or code into a file, explain it, and let the owner review it and apply it in Supabase.
5. **Small steps.** One change at a time. Test it locally (below) before suggesting a push.
6. **Ask first** before deleting files, renaming things, or changing more than one area at once.

## Testing a change on this computer

1. In VS Code, install the **Live Server** extension, right-click `index.html` and choose **Open with Live Server**. It opens http://127.0.0.1:5500.
2. Sign in with the owner's normal login. This uses the **real data**, so test with care. The server functions accept requests from `127.0.0.1:5500` and `localhost:5500`.
3. Check the browser console (F12) for errors.
4. When it works, commit and push to `main`. The live app updates in about a minute. On the phone, close and reopen the app to get the new version.

When you change `index.html`, also bump `CACHE` in `sw.js` (for example `tracker-v2` → `tracker-v3`) so phones pick up the update.

## Code conventions (index.html)

- Plain JavaScript, no build step, no frameworks. Keep it that way.
- State lives in the `S` object. `loadAll()` reloads everything and calls `render()`.
- Views are template strings: `viewAdd`, `viewVideos`, `viewCreators`, `viewPayouts`, `viewCampaigns`. Pop-up panels use `sheet(html)` and `closeSheet()`.
- **Escaping:** wrap any data shown as text or attributes in `esc()`. Pass values to inline handlers with `js()`, e.g. `onclick="openVideo(${js(v.id)})"`, never `'${v.id}'`.
- Data calls go through `q(sb.from(...))`, which shows errors as a toast.
- Colors come from the `COLORS` map. The current campaign's color is set on `--accent`.

## Database cheat sheet

Tables: `settings` (one row, id 1), `campaigns`, `creators` (handle is the key, lowercase), `videos` (TikTok id is the key), `payouts`, `payout_items`, `video_stats`. Views: `videos_v` (adds `owed`, `paid_total`, `payout_codes`) and `campaign_totals` (adds `videos_count`, `total_spent`, `still_owed`). Function `create_payout(...)` records payments. Full details in `supabase/schema.sql`.

## Deploying server code (owner does this)

In Supabase: **Edge Functions** → pick the function → **Code** → paste the new `index.ts` → **Deploy**. Keep "Verify JWT" **off** for both functions, because they check the login themselves and the daily job has no login.

## Free plan limits to keep in mind

500 MB database, 5 GB data transfer a month, 500,000 function calls a month. The project pauses after a week of no use (Restore it in the dashboard). Avoid features that download large amounts of data on every app open.

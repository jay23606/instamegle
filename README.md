# Peek

A tiny Instagram-style app with a twist: **your full-resolution photos never touch a server.**
Text, likes, comments and a tiny blurred preview live in Supabase; the real photo
stays in your browser and streams **peer-to-peer** to whoever is looking at it while
you're online.

Plain JS, a few tiny helpers, no framework, no build step. The whole app is a single
`index.html` plus a PWA manifest, service worker and icon — hostable on GitHub Pages.

Sibling project to [slumegle](https://github.com/jay23606/slumegle) (same single-file,
no-build, P2P spirit — Supabase here instead of Firebase, and an Instagram skin).

## Features

- **Accounts** — real, persistent identity via Supabase Auth (email + password).
- **Feed** — Instagram-style cards: avatar, username, photo, like, comment, caption, timestamp.
- **Create post** — pick one **or several** photos (swipeable carousel), add a caption, share.
  A ~32px blurred preview per image is generated in-browser and stored; the full images are kept locally.
- **Likes & comments** — optimistic likes, a **liked-by** list, inline commenting with **delete-your-own**, "View all N comments".
- **Notifications** — an Activity feed (likes / comments / follows / follow-requests) with a live unread badge.
- **Profiles** — post grid, follower/following counts, follow / unfollow, **private accounts** with follow-requests, plus Message & Call buttons.
- **Infinite scroll** — the feed pages in as you scroll.
- **Find people** — a search + suggestions view (🔍) with an "Online now" list, so you can discover users before anyone has posted.
- **Direct messages (P2P)** — live 1:1 chat over a WebRTC data channel with typing indicators, unread cues, and device-only local history. Send **photos, videos, files, and voice clips** too — all chunked peer-to-peer (up to 20 MB), never stored on a server.
- **Group chats + group video** — persistent named groups; group text rides ephemeral, **member-only** Supabase Realtime Broadcast (private channels enforced by RLS), and the **group video call is a full P2P mesh** (every member connects to every other — great for small groups). Add someone to a DM with ＋ to spin up a group.
- **Video calls (P2P)** — call any online user; incoming calls show an accept/decline banner; fullscreen call view with mute / camera / hang-up. (slumegle's engine, but to a chosen person instead of a random stranger.)
- **Live** — realtime "N online" count, and brand-new posts appear in the feed without a refresh.
- **Light / dark theme**, mobile-friendly layout, **installable PWA**.

## How the "no photos on the server" part works

| Piece | Where it lives |
|-------|----------------|
| Username, caption, likes, comments | **Supabase Postgres** (with Row Level Security) |
| ~32px blurred preview (LQIP) | Supabase (`posts.preview`, a tiny base64 string) |
| **Full-resolution photo** | **Only in the author's browser** (IndexedDB) |
| Full-photo delivery | **WebRTC** data channel, browser → browser |
| WebRTC signaling (offer/answer/ICE) | **Supabase Realtime Broadcast** (no third-party server) |
| Who's online | **Supabase Realtime** presence |

When you open the feed you instantly see each post's blurred preview. If the author is
currently online, your browser opens a peer-to-peer connection to theirs and pulls the
full image directly — it's never uploaded anywhere. If the author is **offline**, the
post simply stays blurred until they're back. That's the deliberate trade for keeping
photos off any server.

`PREVIEW_PX` in `core.js` is the detail knob for the stored preview (default `32`).

## Files

Plain ES modules loaded straight by the browser — no bundler, no build step.

| File | Purpose |
|------|---------|
| `index.html` | Shell: links `styles.css` and loads `app.js` as a module. |
| `styles.css` | All styles. |
| `util.js` | Pure, dependency-free helpers (sanitizers, chunking, LRU, formatting). |
| `core.js` | Supabase client, DOM helpers, IndexedDB, image processing, shared state. |
| `db.js` | Data-access queries. |
| `rtc.js` | WebRTC + Supabase Realtime signaling. |
| `dm.js` | 1:1 direct messages + video calls. |
| `groups.js` | Group chats + mesh group video calls. |
| `app.js` | Feed, profiles, notifications, router, auth, boot (the entry point). |
| `schema.sql` | Supabase tables + Row Level Security + triggers. |
| `manifest.json`, `sw.js`, `icon.svg` | PWA install + offline shell + icon. |

**Tests:** `node --test` (no dependencies) covers the pure helpers in `util.js`.

## Limitations / notes

- **DMs and calls are live-only.** Like the photos, they're peer-to-peer, so both
  people must be online at the same time; nothing is stored, so there's no offline
  inbox or message history.
- **Offline authors show a blurred post.** By design — the full photo lives only in the
  author's browser. A future option: cache a larger preview, or an opt-in relay.
- **No TURN server (Wi-Fi-first).** P2P uses public STUN only, so two users
  behind strict/symmetric NATs may fail to connect. In practice the P2P features (full
  photos, DMs, video calls) are reliable on Wi-Fi / friendly networks but **often fail on
  mobile cellular data** (carrier-grade NAT). The Supabase-backed parts — feed, likes,
  comments, profiles, discovery — work everywhere. Adding a TURN relay (Metered /
  Cloudflare / Twilio / self-hosted coturn) would make P2P work on cellular too.
- **Mobile UI.** Responsive, with an Instagram-style bottom tab bar on phones; feed,
  composer, DMs (full-width sheet) and calls (fullscreen) are touch-friendly. Note mobile
  browsers suspend backgrounded tabs, which drops presence and any live P2P session.
- **One device per author for full images.** The full photo is stored in the browser that
  created the post; viewing your own posts from a different device shows the preview only.
- **Public anon key + RLS.** All access control is enforced by the Row Level Security
  policies in `schema.sql`. If you add tables, add policies too.

# AGENTS.md — birdclaw (simplified: AI-bookmark index)

This document is the source of truth for the **simplified** birdclaw. It is written for
AI agents (and the humans steering them) that will consume this repository's data. Read
this before changing code or querying data.

## 0. Operator brief: history, present, future

### History

- Upstream `birdclaw` began as a broad local-first Twitter/X workspace: archive import,
  home/mentions/DMs/inbox/moderation/follow graph/research/media/link tooling, a React web
  UI, and a scriptable CLI.
- This fork was narrowed in June 2026 into a smaller agent-facing product: a local index of
  the owner's **bookmarks and likes**, especially AI products/projects/services saved from X.
- The simplification removed most human workflow lanes and kept the pieces needed for:
  saved collections, bookmark parent indexing, URL expansion, metadata generation, JSON
  query output, and a small saved-post frontend.

### Present

- The tool name is **`birdclaw`**. The package declares a real binary at
  `bin/birdclaw.mjs`, so the intended installed UX is:

  ```bash
  birdclaw --help
  birdclaw db stats --json
  birdclaw jobs generate-bookmark-metadata --provider openrouter --model "nvidia/nemotron-3-super-120b-a12b:free"
  ```

- In a source checkout, the development equivalent is:

  ```bash
  pnpm exec tsx src/cli.ts --help
  ```

  That command is not the product UX; it is just the local TypeScript dev entrypoint before
  the package binary is installed or linked into the shell PATH.

- The local frontend exists. Run it from the repo with:

  ```bash
  pnpm dev
  ```

  Then open `http://localhost:3000`. The current app redirects `/` to `/bookmarks`; `/likes`
  is also available.

- The default data root is `~/.birdclaw`; the default SQLite DB is:

  ```text
  ~/.birdclaw/birdclaw.sqlite
  ```

  Override the whole root with `BIRDCLAW_HOME=/path/to/root`.

- Agents should consume data through JSON interfaces first:

  ```bash
  birdclaw search tweets "agent framework" --bookmarked --json --limit 20
  curl "http://localhost:3000/api/query?resource=bookmarks&search=agent%20framework&limit=20"
  ```

  Direct SQLite reads are allowed for inspection, but the schema is still evolving, so API/CLI
  are preferred for agent workflows.

- Current AI metadata providers:
  - OpenAI: `OPENAI_API_KEY`, default provider.
  - OpenRouter: `OPENROUTER_API_KEY`, `--provider openrouter` or
    `BIRDCLAW_AI_PROVIDER=openrouter`.
  - Ollama Cloud: `OLLAMA_API_KEY`, `--provider ollama` or
    `BIRDCLAW_AI_PROVIDER=ollama`.

- The active OpenRouter model for the owner is:

  ```text
  nvidia/nemotron-3-super-120b-a12b:free
  ```

- As of the latest local check, the database exists at `/Users/nalin/.birdclaw/birdclaw.sqlite`.
  `xurl` is installed but not authenticated, so true live X account sync still requires
  registering/authenticating an X app/user before `sync likes` or `sync bookmarks` can pull
  real account data.

### Future

- Keep the CLI install path obvious for non-experts: package installs expose the
  `birdclaw` binary automatically, and source checkouts now provide
  `pnpm run install:cli` (`npm link`) so `birdclaw --help` works without remembering
  `pnpm exec tsx src/cli.ts`.
- Finish real-account setup: `xurl auth apps add`, `xurl auth oauth2`, `xurl auth default`,
  then validate with `birdclaw auth status --json`.
- Add an agent quickstart that shows the minimal loop:
  `sync bookmarks` → `backfill-bookmark-parents` → `generate-bookmark-metadata` →
  `/api/query?resource=bookmarks`.
- Improve query ergonomics for agents: stronger examples, stable JSON contract docs, and
  possibly a dedicated `birdclaw agents query ...` command if the generic tweet search CLI
  feels too Twitter-shaped.
- Decide whether OpenRouter image labeling should be enabled only for vision-capable models
  or remain best-effort on the selected model.
- Keep migrations additive. Do not destructively modify the user DB.

## 1. Purpose (what this fork is now)

The upstream birdclaw is a broad Twitter/X workspace. This fork is deliberately stripped
down to **one job**: maintain a high-quality, machine-readable **index of the owner's
likes and bookmarks**, enriched with metadata so that **AI agents** (not humans) can query
it to discover the AI products, services, and projects the owner saved.

The owner's bookmarks are ~99% about AI products/projects/services. The index exists so an
agent can answer questions like "what AI eval tools have I bookmarked?" or "give me the
URLs of every agent framework I saved."

**Only these features exist. Nothing else is in scope.**

- Keep **Likes** and **Bookmarks**, properly organized.
- For **Bookmarks**: if a bookmark is a retweet or quote of an earlier post, also index
  that **one** referenced "top" post. A mid-thread bookmark keeps only itself.
- For **Bookmarks**: generate **SEO-style metadata** — keywords, a short summary, image
  understanding (labels/keywords from any pictures), and **extracted product/service URLs**.
- Metadata is generated for the **bookmark itself and its indexed parent** (if any).

Everything is consumed by agents via the JSON query API, not by manual browsing.

## 2. Scope decisions (locked)

| Concern             | Decision                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Likes               | Kept + organized. No parent indexing, no metadata.                                                                                                                             |
| Bookmarks           | Full treatment: parent indexing + metadata + URL extraction.                                                                                                                   |
| "Top previous post" | The **immediate** referenced tweet (retweet/quote target). No full-thread walk.                                                                                                |
| Mid-thread bookmark | Keep only the bookmarked tweet itself.                                                                                                                                         |
| Vision / keywords   | Reuse existing OpenAI plumbing (`src/lib/openai.ts`, `BIRDCLAW_OPENAI_MODEL`).                                                                                                 |
| URL resolution      | Keep `src/lib/url-expansion.ts` (resolves t.co → final product URL).                                                                                                           |
| Consumer            | AI agents, via `/api/query` and the CLI.                                                                                                                                       |
| Removed lanes       | Inbox, Today, Discuss, Analyse, Map, Sources, Home, Mentions, Links, Rate Limits, DMs, Blocks/Mutes, follow-graph, geocoding, digests, link-index, research, profile-analysis. |

## 3. Data model

Canonical tweets/profiles plus account-scoped collection rows are retained from upstream.

- `tweets` — canonical tweet rows. Relevant columns: `id`, `text`, `created_at`,
  `reply_to_id`, `quoted_tweet_id`, `entities_json`, `media_json`, `media_count`.
- `tweet_collections` — `(account_id, tweet_id, kind)` where `kind ∈ {likes, bookmarks}`.
- `profiles` — authors.

### New / changed

- **Parent link** (implemented in `timeline-collections-live.ts`): when a bookmark is a
  quote or retweet, the single referenced top post is persisted as a normal `tweets` row
  with `kind = 'reference'`, `bookmarked = 0`, `liked = 0`, and an entry in `tweets_fts`
  (the FTS precondition for search). It is **never** added to `tweet_collections`. Note:
  the current bookmark/home queries are scoped to collections/edges, so a parent is not yet
  _findable_ via the search path on its own — that becomes real with the Phase 3 query
  surface; for now it is reachable as the embedded parent of its bookmark. Reachability:
  - **Quote** → linked via the bookmark's `quoted_tweet_id` column (already populated).
  - **Retweet** → resolved from the bookmark's stored `raw_json` (`referenced_tweets`,
    type `retweeted`) by `getRetweetedTweetIdFromRaw` → `getTweetById` in `queries.ts`.
    We do **not** misuse `reply_to_id` for retweet targets — that column drives the
    reply/conversation ancestor walk and pointing it at a retweet parent would corrupt it.
  - **Mid-thread reply** (`replied_to` only) → parent is **not** indexed (§2 locked).
    The reference upsert never clobbers an existing row's `kind`/`bookmarked`/`liked`, so a
    tweet that is both someone's bookmark and another's quoted parent keeps its collection
    state. Caveat for Phase 3: `attachments.media_keys` only expands media for `data[]`
    tweets, not `includes.tweets`, so parent `media_json` is usually `[]` — don't assume
    parent images exist for vision.
- **`tweet_metadata`** (new table) — one row per indexed tweet (bookmark or its parent):

  ```
  tweet_id      text primary key
  keywords_json text not null default '[]'   -- string[] SEO keywords
  summary       text                         -- short agent-readable summary
  image_labels_json text not null default '[]' -- string[] vision labels/keywords
  urls_json     text not null default '[]'   -- extracted/resolved product URLs (string[])
  model         text                         -- model used for generation
  generated_at  text                         -- ISO timestamp
  ```

## 4. Pipeline

```
sync bookmarks ──► persist bookmark tweet rows
                └─► if retweet/quote: fetch + persist the 1 parent post, link it
                          │
metadata job ─────────────┴─► for each bookmark + parent:
                                • text  → keywords + summary
                                • media → vision → image labels
                                • entities/url-expansion → resolved product URLs
                                • write tweet_metadata row
```

- Bookmark fetch must request the `referenced_tweets.id` expansion (upstream only requested
  `author_id,attachments.media_keys`) so parent posts arrive in `includes` and can be
  persisted in the same pass. A backfill covers pre-existing bookmarks.
- Metadata generation is idempotent: skip tweets that already have a fresh `tweet_metadata`
  row unless re-generation is requested.

## 5. Agent-facing query surface

Agents read the index through the JSON query API (`src/routes/api/query.tsx` →
`queryResource` in `src/lib/queries.ts`) and the CLI. Bookmark/like results include the
joined `tweet_metadata` (keywords, summary, image labels, URLs) and, for bookmarks, the
linked parent post and its metadata. Metadata is exposed as an optional `metadata` object
on `TimelineItem` and on embedded parent tweets (`quotedTweet`, `retweetedTweet`,
`replyToTweet`) with this JSON shape:

```
{
  "keywords": ["..."],
  "summary": "...",
  "imageLabels": ["..."],
  "urls": ["..."],
  "model": "...",
  "generatedAt": "..."
}
```

Saved collections can be queried directly with `/api/query?resource=bookmarks` and
`/api/query?resource=likes`; those are aliases for the same timeline query path with the
saved-collection filters applied. The older explicit filters (`resource=home&bookmarked=true`
or `resource=home&liked=true`) still work.

## 6. Conventions

- TypeScript, Effect for I/O-heavy internals; Promise wrappers only at CLI/route/component
  edges (upstream convention, retained).
- DB access via Kysely types in `src/lib/db.ts`; schema bootstrapped with
  `create table if not exists` + `ensure*` column migrations (additive, no destructive
  migrations on existing user DBs).
- Validate with: `pnpm run typecheck`, `pnpm run build`, `pnpm test`, `pnpm run check`.

## 7. Implementation phases

1. **Strip** — reduce nav to Likes + Bookmarks; delete removed routes/api/lib + their
   tables; keep tweets/profiles/collections/edges, sync core, url-expansion, openai.
2. **Parent indexing** — add `referenced_tweets.id` expansion to bookmark fetch; persist +
   link the single parent; backfill.
3. **Metadata** — add `tweet_metadata`; metadata job (keywords, summary, vision labels,
   URL extraction); join into the bookmark query surface.

## 8. Live status (update every session — this is the credit-survival checkpoint)

**Chosen ordering (2026-06-06):** Phase 1 strip is complete, then Phase 3 metadata work
continues in order (`tweet_metadata` table → generation job → query surface).

**Phase 1 — Strip: DONE.**

- Removed-feature route/component/API files are deleted; `/` redirects to bookmarks;
  `AppNav` is trimmed to Bookmarks + Likes; route tree and focused tests were updated.
- `src/cli.ts`, `src/lib/web-sync.ts`, `SyncNowButton`, and `/api/sync` are pruned to the
  keep-set commands and sync paths.
- Orphaned removed-lane `src/lib` files and their tests were deleted by import reachability.
  `url-expansion` and `url-expansion-store` are intentionally kept for Phase 3 URL
  extraction.
- Existing DB tables for removed lanes were intentionally not dropped; migrations must stay
  additive for user DBs.
- The moderation cluster (`blocks`, `mutes`, `moderation-*`) is intentionally kept because
  the retained `src/routes/api/action.tsx` imports `blocks`/`mutes`.
- The previously noted `link-insights.test.ts` date-dependent flake is gone because the
  removed-lane `link-insights` lib and test were deleted.

**Phase 2 — Parent indexing: DONE & green** (typecheck, build, targeted tests pass).

- `xurl.ts`: bookmark fetch now requests
  `referenced_tweets.id,referenced_tweets.id.author_id` (likes unchanged).
- `types.ts`: `XurlMentionsResponse.includes.tweets?` added.
- `timeline-collections-live.ts`: `mergePayloads` carries `includes.tweets`;
  `mergeTimelineCollectionIntoLocalStore` persists the single quoted/retweeted parent via
  `upsertReferenceTweet` (kind `reference`, FTS row, gated to `kind === "bookmarks"`).
  See §3 for the linkage/skip rules.
- **Backfill (done):** `backfillBookmarkReferenceParents{,Effect}` in
  `timeline-collections-live.ts` lights up the _existing_ corpus (forward-only sync would
  leave every already-saved bookmark parent-less, and the bookmarks API pagination bug
  means a fresh walk can't recover old bookmarks). It reads each bookmark's referenced
  parent id from the stored `raw_json` (`retweeted`/`quoted`) and `quoted_tweet_id`, fetches
  the absent ones by id via `lookupTweetsByIdsEffect` (xurl→bird), and persists through the
  same `createReferenceParentWriter` the live sync uses (no drift). Idempotent. Runnable:
  `birdclaw jobs backfill-bookmark-parents [--mode auto|xurl|bird] [--batch-size n]`.
- **Transport caveat:** inline parent indexing is **xurl-only** — only the xurl bookmark
  fetch requests `referenced_tweets.id` and only the xurl branch flows through `mergePayloads`
  (which carries `includes.tweets`). The bird fallback returns its payload directly, so
  bird-sourced bookmarks get their parents via `backfill-bookmark-parents` (by id), not
  inline. Not a bug: bird is fallback-only and backfill is transport-agnostic.
- Tests: 7 new cases in `timeline-collections-live.test.ts` (quote/retweet indexed,
  reply-parent skipped, likes untouched, backfill quote, backfill retweet-from-raw_json,
  backfill idempotency); `xurl.test.ts` expansion assertions updated (new
  `BOOKMARK_EXPANSIONS` const). Full suite green except the pre-existing flake below.

**Phase 3 — Metadata: DONE.**

- `tweet_metadata` table per §3 is added additively in `db.ts` via
  `ensureTweetMetadataTable`, with a Kysely `TweetMetadataTable` type and idempotent
  bootstrap coverage in `db.test.ts`. Note: `ensureTweetMetadataColumns` still only adds
  legacy columns to `tweets`; it is unrelated.
- Metadata job is added in `bookmark-metadata.ts` and exposed as
  `birdclaw jobs generate-bookmark-metadata [--refresh] [--limit n] [--model model]
[--provider openai|openrouter|ollama]`.
  It scans bookmarks plus `kind='reference'` parents, skips existing rows unless refreshed,
  writes keywords/summary/image labels/resolved URLs, and continues after per-tweet
  failures. OpenAI remains the default provider (`OPENAI_API_KEY`). OpenRouter is supported
  through its OpenAI-compatible endpoint (`https://openrouter.ai/api/v1/chat/completions`)
  with `BIRDCLAW_AI_PROVIDER=openrouter` or `--provider openrouter`, `OPENROUTER_API_KEY`,
  and `BIRDCLAW_OPENAI_MODEL`/`--model` (for example `nvidia/nemotron-3-super-120b-a12b:free`). Ollama Cloud
  is supported directly through `https://ollama.com/api` with `BIRDCLAW_AI_PROVIDER=ollama`
  or `--provider ollama`, `OLLAMA_API_KEY`, and `BIRDCLAW_OPENAI_MODEL`/`--model` (for
  example `deepseek-v4-flash`). Ollama text metadata is parsed from JSON-only chat output;
  image labels are skipped for the Ollama provider path until a vision-capable cloud model
  is selected and tested. Freshness is presence-only for v1.
- Query surface joins metadata in `queries.ts` with a batched lookup after timeline items
  and embedded parents are built. The optional `metadata` object is attached to top-level
  bookmark/like items when present and to embedded parent tweets (`quotedTweet`,
  `retweetedTweet`, `replyToTweet`) when present. The API route and CLI inherit this JSON
  shape through `queryResource`/`listTimelineItems`. `/api/query?resource=bookmarks` and
  `/api/query?resource=likes` are supported as saved-collection aliases.
- Translation support is additive: `tweets.text` remains the original source text to
  preserve entity offsets/raw fidelity, while `tweets.lang` and `tweets.text_en` store AI
  language detection and English translation for non-English/non-Hindi bookmark/reference
  rows. `generate-bookmark-metadata` now language-checks rows even when metadata already
  exists, and the saved-post UI renders `text_en` for top-level, quoted/replied, retweeted,
  and conversation tweets when present.
- Metadata candidate scans skip rows that already have both metadata and a language check
  unless `--refresh` is passed, so repeated limited runs progress to older unprocessed
  bookmarks. Image labeling is best-effort: if the selected model/provider cannot label
  images, the job still writes text metadata, URLs, and translations with empty image labels.

Keep this file updated as the design evolves.

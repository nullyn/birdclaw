# birdclaw 🪶 — AI-readable X bookmarks and likes index

`birdclaw` is a local-first index of the owner's X/Twitter **bookmarks** and
**likes**, stored in SQLite and exposed through a scriptable CLI, JSON API, and a
small local web UI.

This fork is intentionally narrow. It is not a general Twitter workspace. The
current product goal is to help AI agents query saved posts — especially saved AI
products, projects, services, tools, and examples — with useful metadata.

## What works today

- Local SQLite database under `~/.birdclaw/birdclaw.sqlite`.
- Saved collections for likes and bookmarks.
- Bookmark parent indexing: when a bookmark is a quote or retweet, birdclaw also
  stores the single referenced parent tweet as a `kind='reference'` row.
- Bookmark metadata generation:
  - SEO keywords
  - short agent-readable summary
  - image labels when a vision-capable provider/model is used
  - extracted and resolved product/service URLs
- Translation support for saved bookmark/reference rows:
  - original `tweets.text` is preserved for raw fidelity and entity offsets
  - `tweets.lang` stores detected language
  - `tweets.text_en` stores English translation for non-English/non-Hindi tweets
  - the web UI renders `text_en` when present
- Local web UI at `/bookmarks` and `/likes`.
- Agent-facing JSON query API at `/api/query`.
- CLI binary exposed as `birdclaw` after package install/link.

## Install and run

From a source checkout:

```bash
pnpm install
pnpm run build
pnpm run install:cli
birdclaw --help
```

Development entrypoint without linking:

```bash
pnpm exec tsx src/cli.ts --help
```

Run the local web app:

```bash
pnpm dev
```

Open:

```text
http://localhost:3000
```

The root route redirects to `/bookmarks`; `/likes` is also available.

## Storage

Default root:

```text
~/.birdclaw
```

Default SQLite DB:

```text
~/.birdclaw/birdclaw.sqlite
```

Override the root:

```bash
export BIRDCLAW_HOME=/path/to/custom/root
```

## Agent query examples

Prefer JSON surfaces for agent workflows:

```bash
birdclaw db stats --json
birdclaw search tweets "agent framework" --bookmarked --json --limit 20
curl "http://localhost:3000/api/query?resource=bookmarks&search=agent%20framework&limit=20"
curl "http://localhost:3000/api/query?resource=likes&limit=20"
```

Bookmark and like results include metadata when present. Bookmark results also
include embedded quoted/retweeted parents when available, with parent metadata
attached when generated.

Metadata shape:

```json
{
	"keywords": ["agent framework", "developer tools"],
	"summary": "A framework for building and evaluating AI agents.",
	"imageLabels": ["dashboard", "benchmark chart"],
	"urls": ["https://example.com"],
	"model": "nvidia/nemotron-3-super-120b-a12b:free",
	"generatedAt": "2026-06-07T12:00:00.000Z"
}
```

## Sync bookmarks and likes

Live X sync requires local `xurl` or `bird` setup. Check status:

```bash
birdclaw auth status --json
```

Sync saved collections:

```bash
birdclaw sync bookmarks --mode auto --limit 100 --max-pages 5 --refresh --json
birdclaw sync likes --mode auto --limit 100 --max-pages 5 --refresh --json
```

Backfill bookmark parent tweets for already-saved bookmarks:

```bash
birdclaw jobs backfill-bookmark-parents --mode auto --batch-size 100
```

## Generate bookmark metadata and translations

OpenAI is the default provider:

```bash
export OPENAI_API_KEY=...
birdclaw jobs generate-bookmark-metadata --limit 25
```

OpenRouter is supported through its OpenAI-compatible endpoint:

```bash
export OPENROUTER_API_KEY=...
birdclaw jobs generate-bookmark-metadata \
  --provider openrouter \
  --model "nvidia/nemotron-3-super-120b-a12b:free" \
  --skip-image-labels \
  --limit 50
```

Ollama Cloud is also supported for text metadata/translation:

```bash
export OLLAMA_API_KEY=...
birdclaw jobs generate-bookmark-metadata \
  --provider ollama \
  --model "deepseek-v4-flash" \
  --skip-image-labels
```

Without `--refresh`, existing metadata rows are not regenerated, but rows with
missing `lang` are still language-checked and translated when needed. Use
`--refresh` only when you intentionally want to regenerate existing metadata.

## Database model summary

Core tables:

- `tweets` — canonical tweets, including `text`, `lang`, `text_en`, entities,
  media, and quote links.
- `tweet_collections` — account-scoped saved rows where `kind` is `likes` or
  `bookmarks`.
- `tweet_metadata` — generated keywords, summary, image labels, URLs, model, and
  generation timestamp.
- `profiles` — tweet authors.

Reference-parent tweets are persisted as normal `tweets` rows with
`kind='reference'`; they are not inserted into `tweet_collections`.

## Development

Useful checks:

```bash
pnpm run typecheck
pnpm run build
pnpm test
pnpm run check
```

Format changed files when needed:

```bash
pnpm exec oxfmt <files>
```

## Current scope

In scope:

- likes and bookmarks
- bookmark parent indexing
- bookmark/reference metadata
- translation for non-English/non-Hindi bookmark/reference rows
- JSON query surfaces for agents
- small saved-post frontend

Out of scope for this fork:

- home timeline workspace
- mentions/DM inbox workflows
- link-insights dashboards
- research/discussion lanes
- follow-graph/network-map UI
- moderation UI

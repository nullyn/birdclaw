---
title: Nalanda
description: "A local saved knowledge library for agents, with a JSON CLI and SQLite storage."
---

# Nalanda

Nalanda brings your X bookmarks, Instagram AI collection, and GitHub stars into a
local library that agents can hydrate and search. It is a fork of
[Birdclaw](https://github.com/steipete/birdclaw); the upstream archive and Twitter
workflows remain available.

## Agent interface

The CLI is the primary interface. Agents with shell access invoke commands with
`--json`; a skill explains the commands and when to use them. No MCP server is
required. An MCP adapter would only be useful for a client that needs discoverable
tool calls instead of shell commands, and would call the same library functions.

From an installed source checkout:

```bash
nalanda --json sync bookmarks --mode playwright --early-stop --max-pages 10 --refresh
nalanda --json sync github-stars
nalanda --json sync instagram-saved --account alice --collection AI
nalanda --json index knowledge
nalanda --json search knowledge "Tools for giving an AI assistant lasting memory"
nalanda --json search knowledge "agent memory" --source github --no-rerank
nalanda --json search saved "agent" --source github --limit 10
nalanda --json search saved "AI" --source instagram --limit 10
nalanda --json saved-get github alice <external-id-from-search>
```

Without linking the executable, use `pnpm cli --json ...` or
`node bin/nalanda.mjs --json ...` in this checkout with Node 26.

`sync github-stars` uses the account authenticated by `gh`. It imports the
repository description, topics, star timestamp, and README. README refreshes are
cached against repository push time and default branch; failed fetches preserve
previously saved README text and appear in warnings. Repositories without
retrievable READMEs still retain their metadata. A capped scan is partial.

`sync instagram-saved` uses the signed-in Chrome session and selects the exact
collection name. It captures available caption text or metadata preview, visible author-authored
comments and links, author,
permalink, and publication time. It does not transcribe reels or read text inside
images. The first observed timestamp is stored separately from publication time;
Instagram does not expose a reliable bookmark timestamp through this workflow.
The default cap is 500 posts. Capped or stalled scans report `partial` and retain
prior data; they never infer that older records were unsaved.

Neither command stars, unstars, saves, or unsaves remote content. Source identity
is explicit and account-scoped. Browser session credentials stay in memory.
Nalanda is an archive: captured posts and repositories remain available after
you unsave or unstar them. Sync adds and refreshes captured content; it does not
mirror deletions from the remote collections. Search results describe this
captured library, not a verified snapshot of today's saved membership.

## Storage and compatibility

Fresh installations use `~/.nalanda/nalanda.sqlite`. Existing installations
continue to use `~/.birdclaw/birdclaw.sqlite`, including media and configuration.
`NALANDA_HOME` and `NALANDA_CONFIG` override those locations; legacy
`BIRDCLAW_HOME` and `BIRDCLAW_CONFIG` still work. Other existing `BIRDCLAW_*`
settings and scheduled job identifiers remain compatible.

`nalanda` is the primary package executable. `birdclaw` is a compatibility alias
for old scripts and scheduled jobs. No public npm package or Homebrew formula has
been published for this fork; install from this checkout.

X data remains in the existing canonical tweet and collection tables. GitHub and
Instagram records live in `saved_resources`, with a source/account/external-ID
key, content hash, timestamps, metadata, and their own SQLite FTS5 index. They are
included in backup export/import as `data/saved_resources.jsonl`; search indexes
are reconstructed from the records.
Backup merge keeps the capture with the newer `fetchedAt`; an older or equal-time
backup cannot overwrite a fresh local README, caption, metadata, or timestamps.
An explicit replace restore still replaces the local records.

## Timestamps

Store fetch timestamps as UTC ISO 8601 instants. Preserve source publication time
when provided; a date-only value remains a date with explicit precision/provenance
rather than an invented midnight timestamp.

- X retains post publication time in `tweets.created_at` and the most recent
  collection refresh in `tweet_collections.updated_at`. Browser fetches do not
  expose an exact bookmark timestamp; `collected_at` remains unknown rather than
  borrowing the publication date. Historical first-fetch times are not retained.
- GitHub retains the actual `starredAt` timestamp as `savedAt`, plus the per-record
  `fetchedAt` refresh time and repository push time in metadata.
- Instagram retains first observed time as `savedAt` with `savedAtSource: first-seen`,
  per-record `fetchedAt`, and `publishedAt` with its source/precision in metadata.
  Its exact save timestamp is unavailable. Refreshing must preserve first-seen time.

Future keyword-summary enrichment must preserve these dates and add its own
processing timestamp. A summary's generation date cannot replace the post's
publication or capture date. Search results expose capture and available
publication timestamps alongside citation URLs.

## Unified retrieval

The requested X content scope is saved post text, locally available quotes, and
article previews. Full linked articles and complete threads are outside that
scope. GitHub includes README text, and Instagram includes available captions.
Available author comments and their captured link URLs are searchable too.
An Instagram preview-only refresh preserves a previously captured full caption,
known author comments/links, and any more precise publication timestamp.

JEV credentials resolve from `TYPESAFE_API_KEY` in the process environment, then
`.env` in Nalanda's data directory, then the package's ignored `.env` file.
They are never read from an unrelated caller's working directory. For an installed
CLI, use the environment or data-directory file; package files contain no key.

`index knowledge` builds a derived passage index across all three sources. It
uses Google’s EmbeddingGemma 2 (built on Gemma 4, released October 6, 2026)
through local Ollama as `embeddinggemma-2:latest`, with its actual model digest
recorded on each embedding. Install/start Ollama and run `ollama pull embeddinggemma-2`
once. Ollama 0.40.1 is verified here; older runtimes can reject this new model
with a request to upgrade. Embedding inference stays on `127.0.0.1:11434`; this integration has no cloud
embedding fallback and uses no OpenRouter credits. This importer currently sends
text only; the new model’s image/audio/video capabilities are not yet wired into
Nalanda’s ingestion pipeline.

`search knowledge` searches the whole indexed library:

1. Project saved records into bounded overlapping passages with stable document
   identities, exact text offsets, and citation URLs. Available X quotes are
   labeled separately in the projected document text.
2. Retrieve passages by local cosine similarity and SQLite FTS5/BM25 keywords.
3. Combine both lists with reciprocal rank fusion, retaining at most two passages
   per source record. The reranking shortlist contains 30–50 passages, depending
   on the requested result limit.
4. By default, JEV scores the shortlist's usefulness for the query on a 0–4 scale,
   returning confidence alongside its score. Cached judgments are keyed by query,
   evidence, model, and rubric. A failed/missing JEV service produces explicit
   warnings and preserves the complete local retrieval order.
5. Return evidence text, passage/document IDs, offsets, source/account, URLs,
   publication/save/fetch timestamps, retrieval scores, and JEV judgments. The
   calling agent composes its answer and cites those URLs. Nalanda does not
   generate an answer or a verbatim video transcript.

```bash
# First build, or update the index after syncing a source:
nalanda --json index knowledge
# Search by meaning across all sources, with JEV reranking:
nalanda --json search knowledge "How can an assistant remember past interactions?"
# Entirely local search, with no JEV requests:
nalanda --json search knowledge "persistent agent memory" --no-rerank
# Restrict evidence before retrieval and reranking:
nalanda --json search knowledge "browser automation" --source github --account alice
# Refresh embeddings for changed local records and then search:
nalanda --json search knowledge "agent tools" --refresh-index
# Explicit keyword-only mode works without running Ollama:
nalanda --json search knowledge "Playwright" --mode keyword --no-rerank
```

The default mode is `hybrid`; `--mode semantic` uses only embedding recall, and
`--mode keyword` uses only the passage keyword index. `--limit` accepts 1–50.
`--account` matches the source's exact account identifier: X uses `acct_alice`,
while GitHub and Instagram use their account usernames. These examples use `alice`; replace it with your own identifiers. `--no-rerank`
prevents JEV requests; default reranking sends only the selected passage text,
title, author, and source to TypeSafe and reports request/token usage.

Semantic similarity and fusion scores are retrieval signals, not probabilities
that a claim is true. JEV scores measure relevance, not factual correctness;
callers must distinguish weak matches from useful evidence and avoid inventing
an answer when the saved material does not supply one. Query constraints such as
"saved last month" are not implemented as date filters.

### Freshness, recovery, and storage

Indexing is explicit: source sync fetches remote content, then `index knowledge`
or `--refresh-index` updates the search index from that local content. Search
itself does not open Chrome or fetch GitHub. Changed content is re-embedded;
timestamp-only refreshes reuse embeddings. Query embeddings and JEV judgments
are cached. Changed or removed source records are excluded from search immediately,
even before the index is rebuilt; missing/outdated records produce an explicit
`stats.indexIncomplete` flag and warning. This index flag describes local index
coverage, not proof that a remote bookmark collection is complete.

SQLite stores derived `knowledge_documents`, `knowledge_passages`, float32
embedding blobs, and a passage FTS index. At this personal-library scale, exact
cosine search avoids adding a separate vector database or native extension.
A model digest change invalidates semantic reuse and requires reindexing.

A SQLite lease prevents overlapping index writers and expires five minutes after
an abandoned run. Embedding calls occur outside write transactions; a document's
new passages are committed together, so a failed embedding batch cannot leave a
half-updated document. Completed documents survive interruptions; rerunning
reuses them. Searches can run while indexing, and report partial coverage.

Source records are included in backups, but these derived passage/vector tables
and JEV caches are not. After restoring, rerun `index knowledge`; no remote fetch
is needed to rebuild saved text. SQLite remains the durable store; Postgres and
MCP are not required.

The existing X bookmark UI and `search saved` keyword command still work.
Unified semantic retrieval is currently CLI-only. X's incremental refresh walks
newest bookmarks until a fully known page; tweet publication dates cannot identify
newly saved old posts. Durable remote-source checkpoints and coordination between
multiple remote hydration requests remain future work.

## Instagram video enrichment

The requested video output is a keyword-rich summary of what is spoken, enriched
by visible video text and links posted by the author in comments. Do not store or
return a verbatim speech transcript. The summary should emphasize named tools,
models, techniques, key claims, and practical steps; extracted keywords and
entities support retrieval.

Speech recognition can supply temporary input for summarization, with the raw
transcript discarded after processing. A free local generative model or the
calling agent writes the summary. JEV judges topic relevance and importance of
candidate terms; it does not generate prose. Persist the summary, keywords,
extraction provenance, and author links. Preserve the distinction between the
written caption, extracted screen text, and the inferred video summary.

Whisper.cpp is a local speech-recognition option with Apple Silicon support.
`ffmpeg` is already installed here; no Whisper runtime has been installed or
video speech recognition run yet. Video OCR and keyword-summary generation are
not currently implemented. JEV accepts text only, so it consumes extracted text
after speech recognition/OCR.

Only loaded author comments are currently in scope for the importer. Empty
`authorLinks` does not prove there are no links in unloaded comments or replies.
Guides that require posting a keyword or receiving a DM are not captured by a
read-only collection fetch.

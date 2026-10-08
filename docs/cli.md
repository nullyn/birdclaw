# CLI Spec

Designed with `create-cli` defaults:

- humans first
- scriptable
- stable `--json`
- diagnostics on stderr
- prompts only on TTY

## Name

`birdclaw`

## One-liner

`birdclaw` imports, syncs, searches, and operates on a local Twitter archive.

## Usage

```text
nalanda [global flags] <subcommand> [args]
```

## Global flags

- `-h, --help`
- `--version`
- `--json`
- `--plain`
- `-q, --quiet`
- `-v, --verbose`
- `--no-color`
- `--no-input`
- `--config <path>`
- `--profile <name>`
- `--db <path>`

## Config precedence

Flags > env > project config > user config

User config:

- `~/.birdclaw/config.json`

Project config:

- `./.birdclawrc.json5`

## Env vars

- `BIRDCLAW_DB`
- `BIRDCLAW_PROFILE`
- `BIRDCLAW_TRANSPORT`
- `BIRDCLAW_LOG`
- `NO_COLOR`

## Command tree

```text
nalanda init
nalanda auth status
nalanda auth use <transport>
nalanda import archive [path]
nalanda sync all
nalanda sync tweets
nalanda sync authored
nalanda sync dms
nalanda sync bookmarks
nalanda sync likes
nalanda sync timeline
nalanda sync mentions
nalanda sync mention-threads
nalanda sync followers
nalanda sync following
nalanda search tweets <query>
nalanda search dms <query>
nalanda discuss <query>
nalanda today
nalanda digest [today|24h|yesterday|week]
nalanda mentions export [query]
nalanda media fetch
nalanda dms list
nalanda mute <handle-or-id>
nalanda unmute <handle-or-id>
nalanda mutes list
nalanda blocks list
nalanda blocks add <handle-or-id>
nalanda blocks remove <handle-or-id>
nalanda ban <handle-or-id>
nalanda unban <handle-or-id>
nalanda show tweet <id>
nalanda show thread <id>
nalanda show dm <conversation-id>
nalanda inbox
nalanda serve
nalanda graph summary
nalanda graph events
nalanda graph top-followers
nalanda graph unfollowed
nalanda graph non-mutual-following
nalanda graph mutuals
nalanda compose post
nalanda compose reply <tweet-id>
nalanda db stats
nalanda db vacuum
nalanda backup export --repo <path>
nalanda backup sync --repo <path> --remote <url>
nalanda backup import <path>
nalanda backup validate <path>
nalanda debug transport
```

## Subcommand semantics

### `today`

- alias for `digest today`
- streams Markdown as model tokens arrive
- uses `gpt-5.5`, medium reasoning, and priority service tier by default
- requires `OPENAI_API_KEY`
- excludes DMs unless `--include-dms` is passed
- supports `--refresh`, `--model`, `--max-tweets`, and `--max-links`

### `digest [period]`

- period: `today`, `24h`, `yesterday`, or `week`
- accepts explicit `--since <iso>` and `--until <iso>` windows
- caches the final structured result by local context hash, model, reasoning effort, and service tier
- `--json` suppresses token streaming and emits the final envelope

### `init`

- create app dir
- create DB
- write default config if absent
- optionally detect `xurl` and `bird`

### `auth status`

- show transport availability
- show active account/profile
- never print secrets

### `auth use <transport>`

- set preferred moderation action transport
- allowed: `auto`, `xurl`, `bird`

### `backup export`

- writes Git-friendly canonical JSONL text shards
- removes and rewrites the `data/` directory in the backup repo
- validates the manifest and file hashes by default
- `--commit` creates a Git commit in the backup repo
- `--push` implies commit and pushes the backup repo

```bash
nalanda backup export --repo ~/Projects/birdclaw-store --commit --push
```

### `backup sync`

- clones/configures the backup Git repo when needed
- pulls the backup repo before reading
- merge-imports remote backup rows into local SQLite
- exports the local union back into deterministic text shards
- commits and pushes the backup repo

```bash
nalanda backup sync --repo ~/Projects/backup-birdclaw --remote https://github.com/steipete/backup-birdclaw.git --json
```

Shard contract:

- tweets: `data/tweets/YYYY.jsonl`
- unknown tweet dates: `data/tweets/unknown.jsonl`
- profiles: `data/profiles.jsonl` includes bio, follower/following counts, profile URL, location, verification type, structured URL entities, and raw profile JSON
- affiliations: `data/profile_affiliations.jsonl` includes X badge/highlighted-label organization edges
- identity history: `data/profile_snapshots.jsonl` and `data/profile_bio_entities.jsonl` preserve profile-change states and extracted bio identity hints
- collections: `data/collections/likes.jsonl`, `data/collections/bookmarks.jsonl`
- DMs: `data/dms/conversations.jsonl` plus `data/dms/YYYY.jsonl`
- moderation: `data/moderation/blocks.jsonl`, `data/moderation/mutes.jsonl`
- no SQLite WAL/SHM, FTS shadow tables, or transient live cache rows

Backup auto-sync config lives in `~/.birdclaw/config.json`:

```json
{
	"backup": {
		"repoPath": "/Users/steipete/Projects/backup-birdclaw",
		"remote": "https://github.com/steipete/backup-birdclaw.git",
		"autoSync": true,
		"staleAfterSeconds": 900
	}
}
```

Read commands pull + merge only when the last backup check is stale. Data-changing commands run a full backup sync afterward. Set `BIRDCLAW_BACKUP_AUTO_SYNC=0` to disable backup auto-sync for one process.

### local `bird` command

Live local likes, bookmarks, DMs, and moderation verification use `bird` on PATH
by default. Override it with `BIRDCLAW_BIRD_COMMAND` or:

```json
{
	"mentions": {
		"birdCommand": "/absolute/path/to/bird"
	}
}
```

### `backup import`

- validates the backup first unless `--no-validate` is passed
- merge-imports by default so local-only rows are not deleted
- `--replace` restores exactly from backup and deletes local portable rows first
- rebuilds tweet and DM FTS from the JSONL text

```bash
nalanda backup import ~/Projects/birdclaw-store --json
```

### `backup validate`

- checks `manifest.json`
- checks every listed shard hash, byte count, row count, and JSONL parseability
- exits non-zero on validation failure

```bash
nalanda backup validate ~/Projects/birdclaw-store --json
```

### `import archive [path]`

- validate archive
- analyze contents
- import selected slices
- stream bundled media files from `data/tweets_media/`, `data/direct_messages_media/`, `data/community_tweet_media/`, `data/deleted_tweets_media/`, `data/profile_media/`, `data/moments_tweets_media/`, and `data/direct_messages_group_media/` into `~/.birdclaw/media/originals/archive/<kind>/<id>/<filename>`
- extract `extended_entities.media[].video_info.variants[]` onto each tweet media row for archive video and animated GIFs
- parse `data/follower.js` and `data/following.js` into the local follow graph
- idempotent
- path is optional; without one, macOS archive autodiscovery picks the newest likely ZIP

Flags:

- `--select <kinds>` — comma-separated subset of `tweets,likes,bookmarks,profiles,directMessages,followers,following`

`--select` details:

- selected re-imports preserve unselected slices
- valid aliases for `directMessages`: `directmessages`, `direct-messages`, `dms`
- duplicate names are ignored
- empty values and unknown names exit as invalid usage
- selected imports validate that existing `acct_primary` matches the archive account before writing
- selected imports preserve compatible existing profile rows unless `profiles` is selected

Examples:

```bash
nalanda import archive --json
nalanda import archive ~/Downloads/twitter-archive.zip --json
nalanda import archive ~/Downloads/twitter-archive.zip --select tweets --json
nalanda import archive ~/Downloads/twitter-archive.zip --select likes,bookmarks --json
nalanda import archive ~/Downloads/twitter-archive.zip --select dms --json
nalanda import archive ~/Downloads/twitter-archive.zip --select followers,following --json
```

### `sync *`

- fetch deltas
- update canonical tables
- refresh cursors
- refresh FTS incrementally
- `sync likes` and `sync bookmarks` use cached live transport; `auto` tries `xurl`, then `bird`; `--early-stop` caps at 10 pages unless paired with `--all` or `--max-pages`
- `sync authored` uses `xurl`, includes retweets, and resumes from a stored `since_id`
- `sync timeline` stores the live home timeline through `bird`; it defaults to the chronological Following feed
- `sync mentions` ingests recent mentions through `xurl` (default) or `bird` and writes `kind='mention'` rows into the canonical store; this is the cron-friendly ingest path that replaces relying on `mentions export --refresh`
- `sync mention-threads` fetches conversation context for recent mentions through `bird thread` or `xurl`; pass `--mode xurl` when the `bird` CLI is unavailable, otherwise use `--delay-ms` and `--timeout-ms` to stay gentle on live X
- `sync followers` and `sync following` default to dry-run and require `--yes` for live sync or fresh-cache merge; `auto` prefers `bird`, then falls back to `xurl`

Common flags:

- `--since <cursor-or-id>`
- `--limit <n>`
- `--transport <kind>`
- `--dry-run`
- `--mode auto|xurl|bird`
- `--all`
- `--max-pages <n>`
- `--mode playwright` (bookmarks only; default bookmark transport)
- `--early-stop` (on `sync likes` and `sync bookmarks`)
- `--refresh`
- `--cache-ttl <seconds>`

Examples:

```bash
nalanda sync authored --mode xurl --limit 100 --json
nalanda sync likes --mode auto --limit 100 --refresh --json
nalanda sync likes --mode auto --limit 100 --max-pages 5 --early-stop --refresh --json
nalanda sync bookmarks --mode playwright --limit 100 --refresh --json
nalanda sync bookmarks --mode playwright --limit 100 --max-pages 5 --early-stop --refresh --json
nalanda sync bookmarks --mode bird --all --max-pages 5 --limit 100 --refresh --json
nalanda sync timeline --limit 100 --refresh --json
nalanda sync mentions --mode xurl --limit 100 --max-pages 3 --refresh --json
nalanda sync mention-threads --mode bird --limit 30 --delay-ms 1500 --timeout-ms 15000 --json
nalanda sync mention-threads --mode xurl --limit 30 --json
```

Follow graph examples:

```bash
nalanda sync followers --json
nalanda sync following --json
nalanda sync followers --yes --json
nalanda sync following --yes --json
nalanda sync followers --mode bird --yes --json
nalanda sync followers --yes --max-pages 1 --allow-partial --json
nalanda sync followers --yes --refresh --json
```

Follow graph sync uses a 24-hour cache by default. Repeating the same sync command with `--yes` reuses fresh cache unless `--refresh` is passed, which prevents duplicate live reads during agent workflows.

`--allow-partial` acknowledges capped/incomplete snapshots and suppresses the warning. Incomplete snapshots are still recorded for audit, but they are not used for churn events.

### `jobs sync-account`

- refreshes home timeline, mentions, mention threads, likes, bookmarks, and DMs for one account
- appends one JSONL audit entry per run to `~/.birdclaw/audit/account-sync.jsonl`
- records each step independently with count, source, and error
- uses `~/.birdclaw/locks/account-sync.lock` to skip overlapping runs
- requires `--allow-bird-account` before Bird-backed steps write to a non-default `--account`
- exits non-zero when any step failed

Examples:

```bash
nalanda --json jobs sync-account --account acct_openclaw --limit 100 --max-pages 3 --refresh --allow-bird-account
tail -n 20 ~/.birdclaw/audit/account-sync.jsonl | jq .
```

### `jobs install-account-launchd`

- writes `~/Library/LaunchAgents/com.steipete.birdclaw.account-sync.plist`
- runs `jobs sync-account` every 30 minutes by default
- uses `launchctl load -w` unless `--no-load` is passed
- `--steps <steps>` narrows the scheduled surfaces
- `--env-path <path>` sources account-specific `bird` cookies for launchd
- `--allow-bird-account` asserts those cookies match `--account` for Bird-backed timeline, mentions, and DM steps

```bash
nalanda --json jobs install-account-launchd --account acct_openclaw --program /opt/homebrew/bin/birdclaw --env-path ~/.config/bird/openclaw.env --allow-bird-account
```

### `bookmarks-analyze [query]`

Tag local bookmarks with JEV and optionally rank them for a question. Supports
`--account`, `--limit` (1–50, default 20), `--search`, and `--cached-only`.
`--all` tags the library in resumable batches with a soft 2M input-token run
budget; it cannot be combined with a question or search. Requires
`TYPESAFE_API_KEY` for uncached judgments. See [Bookmarks](bookmarks.md).

### `jobs sync-bookmarks`

- runs a live bookmark refresh with scheduler-friendly defaults
- appends one JSONL audit entry per run
- records host, timestamps, duration, before/after bookmark counts, transport source, fetched count, backup sync result, and errors
- uses `~/.birdclaw/locks/bookmarks-sync.lock` to skip overlapping runs
- exits non-zero when the sync failed

Default audit log:

```text
~/.birdclaw/audit/bookmarks-sync.jsonl
```

Examples:

```bash
nalanda --json jobs sync-bookmarks --mode playwright --limit 100 --max-pages 5 --refresh
tail -n 20 ~/.birdclaw/audit/bookmarks-sync.jsonl | jq .
```

### `jobs install-bookmarks-launchd`

- writes `~/Library/LaunchAgents/com.steipete.birdclaw.bookmarks-sync.plist`
- runs `jobs sync-bookmarks` every 3 hours by default
- uses `launchctl load -w` unless `--no-load` is passed
- writes launchd stdout/stderr to `~/.birdclaw/logs/bookmarks-sync.*.log`
- `--env-path <path>` sources an export-only shell env file inside the scheduled process, useful when `bird` needs `AUTH_TOKEN`/`CT0` outside an interactive browser session

```bash
nalanda --json jobs install-bookmarks-launchd --program /opt/homebrew/bin/birdclaw
```

### `search tweets <query>`

Flags:

- `--author <handle-or-id>`
- `--since <date>`
- `--until <date>`
- `--originals-only`
- `--hide-low-quality`
- `--liked`
- `--bookmarked`
- `--limit <n>`

Examples:

```bash
nalanda search tweets --liked --limit 20 --json
nalanda search tweets --bookmarked --limit 20 --json
```

### `search dms <query>`

Flags:

- `--participant <handle-or-id>`
- `--min-followers <n>`
- `--max-followers <n>`
- `--min-influence-score <n>`
- `--max-influence-score <n>`
- `--sort recent|followers`
- `--context <n>`
- `--resolve-profiles`
- `--expand-urls`
- `--refresh-profile-cache`
- `--refresh-url-cache`
- `--no-xurl-fallback`
- `--replied`
- `--unreplied`
- `--limit <n>`

Profile resolution reads the local profile row first, then the persistent lookup
cache, then `bird user`, then `xurl` unless `--no-xurl-fallback` is set. Failed
lookups are cached briefly so repeated searches do not keep spending live calls.
Resolved profile rows store bio, profile URL, location, verification type,
structured X URL entities, raw profile JSON, and affiliation badge metadata when
the live transport exposes it.

### `discuss <query>`

Fetch live keyword matches through `bird` or `xurl`, store them as local
`search` tweets, then stream an OpenAI Markdown summary and discussion. DMs stay
out unless explicitly requested.

Flags:

- `--account <account-id>`
- `--source all|search|home|mentions|authored|likes|bookmarks`
- `--mode auto|bird|xurl|local`
- `--include-dms`
- `--since <date>` / `--until <date>`
- `--question <prompt>`
- `--originals-only`
- `--hide-low-quality`
- `--refresh`
- `--model <model>`
- `--limit <n>`
- `--max-pages <n>`

Examples:

```bash
nalanda discuss "local-first" --mode bird
nalanda discuss "sync engine" --question "what changed over time?"
nalanda discuss "prototype" --include-dms --limit 500 --max-pages 5 --json
```

### `whois <query>`

Find likely people or orgs from local DM and optional tweet evidence.
Candidates include structured `profileEvidence` entries for profile bio, profile
URL, bio URLs, location, verified type, first-class affiliations, bio entities,
profile-history snapshots, DM context, and expanded URLs. `whois` also searches
significant terms from fuzzy prompts, so `blacksmith guy` can rank a match from
`@useblacksmith` and `blacksmith.sh` even when the literal phrase was not stored
in a DM. Query intent changes ranking: `@github` emphasizes handle and
affiliation evidence, `github.com` emphasizes URL/domain evidence, and
`github guy` emphasizes people/org affiliation evidence. Human output explains
"why this person?" and buckets candidates as likely affiliated, ecosystem,
profile/link-only, DM context, or other local matches.

Flags:

- `--account <account-id>`
- `--no-dms`
- `--tweets`
- `--no-resolve-profiles`
- `--no-expand-urls`
- `--refresh-profile-cache`
- `--refresh-url-cache`
- `--no-xurl-fallback`
- `--affiliation <query>` - require current/bio/history affiliation evidence
- `--current-affiliation <query>` - require an active affiliation badge edge
- `--exclude-domain-only` - drop candidates that only matched domains or URLs
- `--context <n>`
- `--limit <n>`

Examples:

```bash
nalanda whois blacksmith --context 4 --no-xurl-fallback --json
nalanda whois "blacksmith guy" --context 4 --no-xurl-fallback --json
nalanda whois "github guy" --current-affiliation github --exclude-domain-only
nalanda whois blacksmith --tweets --no-xurl-fallback
```

### `mentions export [query]`

- export local mention tweets for scripts and agents
- always emits JSON
- supports `birdclaw`, cached `xurl`, or cached `bird` output
- each item includes:
  - raw `text`
  - rendered `plainText`
  - rendered `markdown`
  - canonical tweet URL
  - author and reply-state metadata

Flags:

- `--account <account-id>`
- `--mode birdclaw|xurl|bird`
- `--replied`
- `--unreplied`
- `--refresh`
- `--cache-ttl <seconds>`
- `--all`
- `--max-pages <n>`
- `--limit <n>`

Examples:

```bash
nalanda mentions export "agent" --unreplied --limit 10
nalanda mentions export --mode bird --limit 20
nalanda mentions export --mode xurl --limit 5
nalanda mentions export "codex" --mode xurl --limit 5
nalanda mentions export --mode xurl --refresh --cache-ttl 30 --limit 5
nalanda mentions export --mode xurl --refresh --all --max-pages 9 --limit 100
```

Notes:

- `--mode xurl` mirrors the `xurl mentions` response shape: `data`, `includes.users`, `meta`
- `--mode bird` shells out to your local `bird` CLI, normalizes the JSON to that same `xurl`-compatible shape, then caches it in SQLite
- payload is cached in local SQLite and reused until the cache TTL expires
- `--refresh` bypasses the cache and fetches live mentions immediately
- `--all` keeps paginating until the retrievable mentions window is exhausted
- `--max-pages` limits that paged xurl scan and implies `--all`
- in paged `xurl` mode, `--limit` is the page size, not the total returned item count
- query and reply-state filters still work in `xurl` mode, but the filtered response is rebuilt from the local canonical store after sync
- default live source can live in `~/.birdclaw/config.json` under `mentions.dataSource`

### `media fetch`

- fill the local originals cache for images, videos, and animated GIFs whose tweets already live in the local SQLite store
- reuse bytes already extracted by `import archive` before falling back to the CDN; reuses are counted in JSON output as `reused_from_archive` and spend zero CDN bandwidth
- only fetch URLs birdclaw already has from an archive or live sync record; never enumerate, crawl, or derive CDN URLs
- skip files already present on disk; resume partial downloads with `Range: bytes=<size>-`
- back off on `429`; cap each file at `--max-bytes`

Flags:

- `--account <accountId>`
- `--limit <n>` - stop after N tweets processed
- `--kind <kind>` - tweet/collection kind, e.g. `home`, `like`, `bookmark`, `mention`
- `--since <isoDate>` - only consider tweets created at or after this date
- `--parallel <n>` - concurrent image workers, capped at 5 (default `1`)
- `--pacing-ms <n>` - delay between image request starts (default `250`)
- `--video-pacing-ms <n>` - separate delay between video request starts
- `--retry-max <n>` - retries per file after rate limiting (default `3`)
- `--include-video` / `--no-include-video` - videos and animated GIFs are on by default
- `--max-bytes <n>` - per-file size cap in bytes (default `104857600`)
- `--dry-run` - list what would be fetched without downloading
- `--json`

JSON output carries `images_fetched`, `videos_fetched`, `gifs_fetched`, `reused_from_archive`, `skipped_cached`, `failed`, `rate_limited`, per-kind byte counters, and a `failures[]` array. See [Media](media.md) for the full pipeline.

Examples:

```bash
nalanda media fetch --json
nalanda media fetch --dry-run --limit 20
nalanda media fetch --include-video --video-pacing-ms 1500 --max-bytes 209715200 --json
nalanda media fetch --no-include-video --parallel 3 --pacing-ms 250 --json
```

### `profiles replies <handle-or-id>`

- inspect a profile's recent authored replies when one mention feels borderline
- moderation-first: scans the live authored tweet timeline, excludes retweets, keeps reply tweets only
- good for spotting templated AI cadence across unrelated conversations
- supports `--json`

Flags:

- `--limit <n>`

Examples:

```bash
nalanda profiles replies @jpctan --limit 12 --json
```

### `dms list`

- list DM conversations or events without requiring a full-text query
- optimized for agent and operator filtering
- optionally refreshes live DMs before listing

Flags:

- `--refresh`
- `--mode bird|xurl|auto`
- `--cache-ttl <seconds>`
- `--participant <handle-or-id>`
- `--min-followers <n>`
- `--max-followers <n>`
- `--min-influence-score <n>`
- `--max-influence-score <n>`
- `--sort recent|followers`
- `--replied`
- `--unreplied`
- `--account <name>`
- `--limit <n>`

### `dms sync`

- refresh live direct messages
- merge conversations/messages into the local SQLite store
- supports `--json`

Flags:

- `--account <account-id>`
- `--mode bird|xurl|auto`
- `--limit <n>`
- `--refresh`
- `--cache-ttl <seconds>`

`--mode bird` is the default and the only mode that can sync message requests. `--mode xurl` reads recent OAuth2 `/2/dm_events` as accepted conversations; `--mode auto` tries xurl first for accepted DMs and falls back to bird.

### `inbox`

- show AI-ranked actionable queue
- supports `--json`
- supports `--limit`
- supports `--kind mentions|dms|mixed`
- supports replied/unreplied filters
- supports `--score` to refresh stored OpenAI scores before listing
- supports `--min-score` and `--hide-low-signal`

### `blocks list`

- list current local blocked profiles
- account-scoped
- supports `--json`

Flags:

- `--account <account-id>`
- `--search <query>`
- `--limit <n>`

### `blocks add <handle-or-id>`

- add a local block entry for one account
- accepts handle, `@handle`, Twitter URL, local profile id, or numeric Twitter user id
- attempts live block transport via `xurl` when resolvable
- falls back to the Twitter web cookie session if `xurl` is rejected for OAuth2 block writes
- still records the local block if live transport is unavailable

Flags:

- `--account <account-id>`

### `blocks import <path>`

- import a blocklist file in one call
- reads newline-delimited handles, ids, or Twitter URLs
- ignores blank lines and `#` comments
- tolerates markdown bullets like `- @handle`
- returns per-entry success/failure in `--json`

Flags:

- `--account <account-id>`

### `blocks remove <handle-or-id>`

- remove a local block entry for one account
- attempts live unblock transport via `xurl` when resolvable
- falls back to the Twitter web cookie session if `xurl` is rejected for OAuth2 block writes

Flags:

- `--account <account-id>`

### `ban <handle-or-id>` / `unban <handle-or-id>`

- shorthand aliases for `blocks add` and `blocks remove`
- useful when you want one obvious moderation verb from the CLI

Flags:

- `--account <account-id>`

### `mutes list`

- list current local muted profiles
- account-scoped
- supports `--json`

Flags:

- `--account <account-id>`
- `--search <query>`
- `--limit <n>`

### `mute <handle-or-id>`

- add a local mute entry for one account
- accepts handle, `@handle`, Twitter URL, local profile id, or numeric Twitter user id
- resolves remote targets via `bird user --json` before falling back to `xurl /2/users`
- `--transport auto` tries `bird` first, then `xurl`
- still records the local mute if live transport is unavailable

Flags:

- `--account <account-id>`

### `unmute <handle-or-id>`

- remove a local mute entry for one account
- `--transport auto` tries `bird` first, then `xurl`

Flags:

- `--account <account-id>`

### `serve`

- starts local app server
- starts background sync automatically by default
- stdout prints URL in plain mode

Flags:

- `--host <host>`
- `--port <port>`
- `--open`
- `--no-open`
- `--sync`
- `--no-sync`

`birdclaw serve` binds the dev server to `127.0.0.1` and enables local
loopback web APIs without a token. Remote access through a trusted private proxy
requires `BIRDCLAW_ALLOW_REMOTE_WEB=1`. To require an app-level token too, set
`BIRDCLAW_WEB_TOKEN` and send it as `x-birdclaw-token` or a `birdclaw_token`
cookie.

### `graph summary`

- cache-only SQLite read
- current followers/following counts
- mutuals and non-mutual following counts
- last complete and incomplete snapshot times

### `graph top-followers`

- cache-only SQLite read
- current followers sorted by their `public_metrics.followers_count`
- supports `--limit`

### `graph unfollowed`

- cache-only SQLite read
- append-only ended follow edges since `--date`
- defaults to `followers`; pass `--direction following` for outbound ended edges

### `graph events`

- cache-only SQLite read
- append-only `started` and `ended` follow graph history
- supports `--direction followers|following`, `--kind started|ended`, `--since`, `--until`, and `--limit`

### `graph mutuals`

- cache-only SQLite read
- current mutuals
- sorted by follower size

### `graph non-mutual-following`

- cache-only SQLite read
- current following profiles that are not current followers
- supports `--sort followers|handle`

Agent rule: use `graph` commands for analysis. Ask for explicit user approval before `sync ... --yes --refresh`, because that can spend live X API reads.

## I/O contract

stdout:

- primary data
- URLs
- JSON output

stderr:

- progress
- warnings
- diagnostics
- auth hints

## Output modes

- default human output
- `--json` stable machine-readable envelopes
- `--plain` stable line-oriented text, no color

## Exit codes

- `0` success
- `1` runtime failure
- `2` invalid usage / validation
- `3` auth unavailable
- `4` transport unavailable
- `5` partial sync failure

## Examples

```bash
nalanda init
nalanda auth status
nalanda import archive ~/Downloads/twitter-archive.zip --select tweets,directMessages
nalanda sync all --transport xurl
nalanda search tweets "openai" --since 2024-01-01 --limit 20
nalanda search tweets --since 2020-01-01 --until 2021-01-01 --originals-only --hide-low-quality --limit 500
nalanda search dms "invoice" --participant @someone --min-followers 1000
nalanda dms list --unreplied --min-followers 500 --min-influence-score 90 --sort followers
nalanda inbox --json
nalanda serve --sync
nalanda graph events --json
nalanda compose reply 1891234567890
```

## Saved sources

Nalanda adds the following commands. All support the root `--json` flag.

```bash
nalanda --json sync github-stars
nalanda --json sync instagram-saved --account alice --collection AI --max-items 500
nalanda --json search saved "agent" --source github --limit 10
nalanda --json saved-get github alice <external-id>
```

GitHub imports descriptions, topics, and cached READMEs through authenticated `gh`.
Instagram reads only the named saved collection through Chrome. `search saved`
is local keyword search over these two sources. See [Nalanda](nalanda.md) for
partial results, storage compatibility, and the semantic retrieval design.

### Unified semantic retrieval

```bash
nalanda --json index knowledge
nalanda --json search knowledge "Ways to give an AI assistant persistent memory"
nalanda --json search knowledge "agent memory" --source github --account alice --no-rerank
nalanda --json search knowledge "Playwright" --mode keyword --no-rerank
```

`index knowledge` incrementally embeds captured X bookmarks, Instagram posts,
and GitHub README passages using local Ollama (`ollama pull embeddinggemma-2`).
Search modes are `hybrid` (default), `semantic`, and `keyword`. The default JEV
reranking is cached and metered; `--no-rerank` makes no JEV calls. `--limit` accepts
1–50. `--refresh-index` indexes changed local content before searching; it does
not fetch sources. Source/account filters apply before retrieval and reranking.

JSON includes evidence passages, citation URLs, text offsets, source timestamps,
retrieval scores, JEV relevance/confidence, request/token usage, and an explicit
`stats.indexIncomplete` flag when captured content is missing or stale in the
index. See [Nalanda](nalanda.md) for the complete behavior and recovery workflow.

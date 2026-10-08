---
title: Install
description: "Install Nalanda from this source checkout. Optional xurl and bird improve legacy live transport coverage."
---

# Install

Nalanda ships as a Node CLI plus a local web app. Install this fork from source.

## Requirements

- **Node.js** 25.8.1 or Node 26.x (managed via `fnm`, `nvm`, or `volta`)
- **pnpm** 10.x for source installs
- **macOS** is recommended for archive autodiscovery (Spotlight `mdfind`); Linux works for everything else
- **SQLite** uses Node's native `node:sqlite` runtime — no system install needed

Optional but encouraged:

- [`xurl`](https://github.com/xdevplatform/xurl) — official-API live reads/writes (likes, bookmarks, blocks, mutes, posting)
- [`bird`](https://github.com/steipete/bird) — cookie-backed reads/writes for surfaces where `xurl` is rate-limited or unavailable
- `OPENAI_API_KEY` — inbox scoring and low-signal filtering

birdclaw still works in pure local/archive mode without any of the above.

## Install this fork from source

Nalanda is not yet published on npm or Homebrew. Use this checkout with Node 26:

```bash
pnpm install
pnpm build
node ./bin/nalanda.mjs --version
pnpm link --global
nalanda --help
```

`birdclaw` remains a compatibility executable. To avoid a global link, use
`pnpm cli` in the checkout. GitHub star hydration needs an authenticated `gh`
installation; X and Instagram hydration use installed Chrome and Playwright.

See [Nalanda](nalanda.md) for source scope, storage compatibility, and commands.

## Optional: xurl

```bash
brew install xdevplatform/tap/xurl
xurl auth login
```

After `xurl auth login` succeeds, `birdclaw` will pick `xurl` first for live reads and writes. No extra wiring needed — `birdclaw` shells out to `xurl` rather than owning `~/.xurl` itself.

## Optional: bird

```bash
brew install steipete/tap/bird
bird auth import-cookies
```

Once `bird` is in `PATH`, `birdclaw` uses it as the cookie-backed fallback. This matters most for DMs, mentions, blocks, and any block/unblock flow where Twitter rejects OAuth2 writes.

If you only run birdclaw via `launchd` (`jobs install-bookmarks-launchd`), `bird` may need its `AUTH_TOKEN`/`CT0` exported via an env file because launchd does not see your interactive browser session. See [Jobs](jobs.md#env-files-for-launchd).

## Optional: OpenAI

```bash
export OPENAI_API_KEY="sk-..."
```

Add it to `~/.profile` or your shell rc to persist. The inbox uses OpenAI for low-signal scoring; without the key, `inbox --score` is a no-op and the heuristic ranker still works.

## Updating

Update this checkout, then run `pnpm install` and `pnpm build`. An existing global
link continues to point to the checkout. Keep a [backup](backup.md) of local data.

Fresh installations use `~/.nalanda`; existing `~/.birdclaw` installations are
reused. Removing either data directory deletes the records and local caches in
that directory.

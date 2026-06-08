#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";
import { findArchives } from "#/lib/archive-finder";
import {
	ARCHIVE_IMPORT_SLICES,
	type ArchiveImportSlice,
	type ImportProgressEvent,
	type ImportProgressSlice,
	type ImportWritePhase,
	importArchive,
} from "#/lib/archive-import";
import {
	exportBackup,
	importBackup,
	maybeAutoSyncBackup,
	maybeAutoUpdateBackup,
	syncBackup,
	validateBackup,
} from "#/lib/backup";
import {
	installBookmarkSyncLaunchAgent,
	runBookmarkSyncJob,
} from "#/lib/bookmark-sync-job";
import { generateBookmarkMetadata } from "#/lib/bookmark-metadata";
import {
	ensureBirdclawDirs,
	getBirdclawPaths,
	setActionsTransport,
} from "#/lib/config";
import { closeDatabase } from "#/lib/db";
import { getQueryEnvelope, listTimelineItems } from "#/lib/queries";
import {
	backfillBookmarkReferenceParents,
	syncTimelineCollection,
	type TimelineCollectionMode,
	type TweetLookupMode,
} from "#/lib/timeline-collections-live";

const program = new Command();
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageVersion = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version?: string };

function print(data: unknown, asJson: boolean) {
	if (asJson) {
		console.log(JSON.stringify(data, null, 2));
		return;
	}
	console.log(data);
}

function printError(error: string) {
	console.error(JSON.stringify({ error }));
}

const IMPORT_SLICE_LABELS: Record<ImportProgressSlice, string> = {
	tweets: "tweets",
	noteTweets: "note tweets",
	directMessages: "direct messages",
	likes: "likes",
	bookmarks: "bookmarks",
	media: "media files",
	followers: "followers",
	following: "following",
};
const IMPORT_WRITE_LABELS: Record<ImportWritePhase, string> = {
	profiles: "profiles",
	tweets: "tweets",
	collections: "likes+bookmarks",
	dmMessages: "DM messages",
};

function logImportProgress(event: ImportProgressEvent) {
	switch (event.kind) {
		case "scanned":
			process.stderr.write(
				`Scanning archive… ${String(event.entryCount)} entries\n`,
			);
			return;
		case "slice-start":
			if (event.slice === "media") {
				process.stderr.write("Indexing media files…\n");
				return;
			}
			process.stderr.write(
				`Parsing ${IMPORT_SLICE_LABELS[event.slice]}… (${String(event.files)} file${event.files === 1 ? "" : "s"})\n`,
			);
			return;
		case "slice-file":
			if (event.files > 1) {
				process.stderr.write(
					`  ${IMPORT_SLICE_LABELS[event.slice]} ${String(event.processed)}/${String(event.files)}\n`,
				);
			}
			return;
		case "slice-done":
			process.stderr.write(
				`  ${IMPORT_SLICE_LABELS[event.slice]}: ${event.count.toLocaleString()}\n`,
			);
			return;
		case "writing":
			process.stderr.write("Writing to database…\n");
			return;
		case "write-start":
			process.stderr.write(
				`Writing ${IMPORT_WRITE_LABELS[event.phase]}… (${event.total.toLocaleString()})\n`,
			);
			return;
		case "write-progress":
			process.stderr.write(
				`  ${IMPORT_WRITE_LABELS[event.phase]} ${event.processed.toLocaleString()}/${event.total.toLocaleString()}\n`,
			);
			return;
		case "done":
			process.stderr.write("Import complete.\n");
			return;
	}
}

function parseNonNegativeIntegerOption(
	value: string | undefined,
	option: string,
) {
	if (value === undefined) {
		return undefined;
	}

	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) {
		printError(`${option} must be a non-negative integer`);
		process.exitCode = 1;
		return undefined;
	}

	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isSafeInteger(parsed)) {
		printError(`${option} must be a non-negative integer`);
		process.exitCode = 1;
		return undefined;
	}

	return parsed;
}

function parseArchiveImportSelect(value: string | undefined) {
	if (value === undefined) {
		return undefined;
	}

	const aliases: Record<string, ArchiveImportSlice> = Object.assign(
		Object.create(null) as Record<string, ArchiveImportSlice>,
		{
			tweets: "tweets",
			likes: "likes",
			bookmarks: "bookmarks",
			directmessages: "directMessages",
			"direct-messages": "directMessages",
			dms: "directMessages",
			profiles: "profiles",
			followers: "followers",
			following: "following",
		},
	);
	const selected: ArchiveImportSlice[] = [];
	const seen = new Set<ArchiveImportSlice>();
	for (const rawItem of value.split(",")) {
		const item = rawItem.trim();
		if (!item) continue;
		const slice = aliases[item] ?? aliases[item.toLowerCase()];
		if (!slice) {
			printError(
				`--select must be a comma-separated subset of ${ARCHIVE_IMPORT_SLICES.join(", ")}`,
			);
			process.exitCode = 1;
			return undefined;
		}
		if (!seen.has(slice)) {
			seen.add(slice);
			selected.push(slice);
		}
	}

	if (selected.length === 0) {
		printError(
			`--select must include at least one of ${ARCHIVE_IMPORT_SLICES.join(", ")}`,
		);
		process.exitCode = 1;
		return undefined;
	}

	return selected;
}

function parseActionsTransport(value: string | undefined) {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "auto" || normalized === "bird" || normalized === "xurl") {
		return normalized;
	}
	printError("transport must be auto, bird, or xurl");
	process.exitCode = 1;
	return undefined;
}

async function autoUpdateBeforeRead() {
	let result: Awaited<ReturnType<typeof maybeAutoUpdateBackup>>;
	try {
		result = await maybeAutoUpdateBackup();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`birdclaw backup auto-sync failed: ${message}`);
		return;
	}
	if (!result.ok) {
		console.error(`birdclaw backup auto-sync failed: ${result.error}`);
	}
}

async function autoSyncAfterWrite() {
	let result: Awaited<ReturnType<typeof maybeAutoSyncBackup>>;
	try {
		result = await maybeAutoSyncBackup();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`birdclaw backup sync failed: ${message}`);
		return;
	}
	if (!result.ok) {
		console.error(`birdclaw backup sync failed: ${result.error}`);
	}
}

program
	.name("birdclaw")
	.description("Local-first Twitter workspace")
	.version(packageVersion.version ?? "0.0.0")
	.option("--json", "Emit JSON output");

program
	.command("init")
	.description("Create local birdclaw root and seed the database")
	.action(async () => {
		const paths = ensureBirdclawDirs();
		await getQueryEnvelope();
		print(
			{
				ok: true,
				rootDir: paths.rootDir,
				configPath: paths.configPath,
				dbPath: paths.dbPath,
				mediaOriginalsDir: paths.mediaOriginalsDir,
				mediaThumbsDir: paths.mediaThumbsDir,
			},
			program.opts().json ?? false,
		);
	});

const authCommand = program
	.command("auth")
	.description("Manage live transport");

authCommand
	.command("status")
	.description("Show transport status")
	.action(async () => {
		const meta = await getQueryEnvelope();
		print(meta.transport, program.opts().json ?? false);
	});

authCommand
	.command("use <transport>")
	.description("Set preferred moderation action transport")
	.action((transport: string) => {
		const parsed = parseActionsTransport(transport);
		if (!parsed) return;
		print(setActionsTransport(parsed), program.opts().json ?? false);
	});

program
	.command("archive find")
	.description("Find likely Twitter archives on disk")
	.action(async () => {
		const items = await findArchives();
		print(items, program.opts().json ?? false);
	});

const importCommand = program
	.command("import")
	.description("Import local archive data");

importCommand
	.command("archive [archivePath]")
	.description("Import a Twitter archive into the local SQLite store")
	.option(
		"--select <kinds>",
		`Import only selected archive slices: ${ARCHIVE_IMPORT_SLICES.join(", ")}`,
	)
	.action(async (archivePath, options: { select?: string }) => {
		const select = parseArchiveImportSelect(options.select);
		if (options.select !== undefined && !select) {
			return;
		}
		let resolvedArchivePath = archivePath;
		if (!resolvedArchivePath) {
			const [latestArchive] = await findArchives();
			resolvedArchivePath = latestArchive?.path;
		}

		if (!resolvedArchivePath) {
			throw new Error(
				"No archive found. Pass a path or place one in Downloads.",
			);
		}

		const asJson = Boolean(program.opts().json);
		const result = await importArchive(resolvedArchivePath, {
			select,
			onProgress: asJson ? undefined : logImportProgress,
		});
		await autoSyncAfterWrite();
		print(result, asJson);
	});

const searchCommand = program
	.command("search")
	.description("Search local data");

searchCommand
	.command("tweets [query]")
	.option("--resource <resource>", "home, mentions, or authored", "home")
	.option("--replied", "Only replied items")
	.option("--unreplied", "Only unreplied items")
	.option("--since <date>", "Include tweets created at or after this date")
	.option("--until <date>", "Include tweets created before this date")
	.option("--originals-only", "Exclude authored replies that start with @")
	.option("--hide-low-quality", "Hide RTs, tiny replies, and link-only noise")
	.option(
		"--min-likes <n>",
		"Override the low-quality like threshold (default 50)",
	)
	.option("--quality-reason", "Include qualityReason on each row")
	.option("--liked", "Only liked tweets")
	.option("--bookmarked", "Only bookmarked tweets")
	.option("--limit <n>", "Limit results", "20")
	.action(async (query, options) => {
		const minLikes = parseNonNegativeIntegerOption(
			options.minLikes,
			"--min-likes",
		);
		if (options.minLikes !== undefined && minLikes === undefined) {
			return;
		}

		await autoUpdateBeforeRead();
		const replyFilter = options.replied
			? "replied"
			: options.unreplied
				? "unreplied"
				: "all";
		const items = listTimelineItems({
			resource:
				options.resource === "mentions"
					? "mentions"
					: options.resource === "authored"
						? "authored"
						: "home",
			search: query,
			replyFilter,
			since: options.since,
			until: options.until,
			includeReplies: !options.originalsOnly,
			qualityFilter: options.hideLowQuality ? "summary" : "all",
			lowQualityThreshold: minLikes,
			includeQualityReason: Boolean(options.qualityReason),
			likedOnly: Boolean(options.liked),
			bookmarkedOnly: Boolean(options.bookmarked),
			limit: Number(options.limit),
		});
		print(items, program.opts().json ?? false);
	});

const syncCommand = program
	.command("sync")
	.description("Refresh live Twitter collections into the local store");

for (const kind of ["likes", "bookmarks"] as const) {
	syncCommand
		.command(kind)
		.description(`Refresh live ${kind} through xurl or bird`)
		.option("--account <accountId>", "Account id")
		.option("--mode <mode>", "auto, xurl, or bird", "auto")
		.option("--limit <n>", "Per-page/result limit", "20")
		.option("--all", "Fetch every retrievable page")
		.option(
			"--max-pages <n>",
			"Stop after N pages when using --all or --early-stop",
		)
		.option("--early-stop", "Stop when a fetched page is already fully local")
		.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
		.option("--refresh", "Bypass live-cache freshness window")
		.action(async (options) => {
			const result = await syncTimelineCollection({
				kind,
				account: options.account,
				mode: options.mode as TimelineCollectionMode,
				limit: Number(options.limit),
				all: Boolean(options.all) || options.maxPages !== undefined,
				maxPages: options.maxPages ? Number(options.maxPages) : undefined,
				refresh: Boolean(options.refresh),
				cacheTtlMs: Number(options.cacheTtl) * 1000,
				earlyStop: Boolean(options.earlyStop),
			});
			await autoSyncAfterWrite();
			print(result, true);
		});
}

const jobsCommand = program
	.command("jobs")
	.description("Run and install background Birdclaw jobs");

jobsCommand
	.command("sync-bookmarks")
	.description("Refresh live bookmarks and append a JSONL audit entry")
	.option("--account <accountId>", "Account id")
	.option("--mode <mode>", "auto, xurl, or bird", "auto")
	.option("--limit <n>", "Per-page/result limit", "100")
	.option("--all", "Fetch every retrievable page")
	.option("--max-pages <n>", "Stop after N pages", "5")
	.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
	.option("--refresh", "Bypass live-cache freshness window")
	.option("--log <path>", "Audit JSONL path")
	.action(async (options) => {
		const result = await runBookmarkSyncJob({
			account: options.account,
			mode: options.mode as TimelineCollectionMode,
			limit: Number(options.limit),
			all: Boolean(options.all) || options.maxPages !== undefined,
			maxPages: options.all ? undefined : Number(options.maxPages),
			refresh: Boolean(options.refresh),
			cacheTtlMs: Number(options.cacheTtl) * 1000,
			logPath: options.log,
		});
		print(result, true);
		if (!result.ok) {
			process.exitCode = 1;
		}
	});

jobsCommand
	.command("backfill-bookmark-parents")
	.description(
		"Index the quoted/retweeted parent of bookmarks saved before parent indexing existed",
	)
	.option("--mode <mode>", "auto, xurl, or bird", "auto")
	.option("--batch-size <n>", "Tweet lookups per request (max 100)", "100")
	.action(async (options) => {
		const result = await backfillBookmarkReferenceParents({
			mode: options.mode as TweetLookupMode,
			batchSize: Number(options.batchSize),
		});
		print(result, true);
	});

jobsCommand
	.command("generate-bookmark-metadata")
	.description("Generate SEO metadata for bookmarks and indexed parent tweets")
	.option("--refresh", "Regenerate rows that already have metadata")
	.option("--limit <n>", "Maximum indexed tweets to scan", "25")
	.option("--model <model>", "AI model override")
	.option(
		"--provider <provider>",
		"AI provider override: openai, openrouter, or ollama",
	)
	.option("--skip-image-labels", "Only generate text metadata and URLs")
	.action(async (options) => {
		const result = await generateBookmarkMetadata({
			refresh: Boolean(options.refresh),
			limit: Number(options.limit),
			model: options.model,
			provider: options.provider,
			skipImageLabels: Boolean(options.skipImageLabels),
		});
		print(result, true);
	});

jobsCommand
	.command("install-bookmarks-launchd")
	.description("Install a LaunchAgent that runs bookmark sync every 3 hours")
	.option("--label <label>", "LaunchAgent label")
	.option("--interval-seconds <seconds>", "Launch interval", "10800")
	.option("--program <path>", "birdclaw executable or command", "birdclaw")
	.option("--mode <mode>", "auto, xurl, or bird", "auto")
	.option("--limit <n>", "Per-page/result limit", "100")
	.option("--all", "Fetch every retrievable page")
	.option("--max-pages <n>", "Stop after N pages", "5")
	.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
	.option("--no-refresh", "Allow live-cache reuse")
	.option("--log <path>", "Audit JSONL path")
	.option("--env-path <path>", "Shell env file to source before running")
	.option("--env-file <path>", "Deprecated alias for --env-path")
	.option("--stdout <path>", "launchd stdout path")
	.option("--stderr <path>", "launchd stderr path")
	.option("--launch-agents-dir <path>", "LaunchAgents directory")
	.option("--no-load", "Write plist without loading it")
	.action(async (options) => {
		const result = await installBookmarkSyncLaunchAgent({
			label: options.label,
			intervalSeconds: Number(options.intervalSeconds),
			program: options.program,
			mode: options.mode as TimelineCollectionMode,
			limit: Number(options.limit),
			all: Boolean(options.all) || options.maxPages !== undefined,
			maxPages: options.all ? undefined : Number(options.maxPages),
			refresh: options.refresh,
			cacheTtlSeconds: Number(options.cacheTtl),
			logPath: options.log,
			envFile: options.envPath ?? options.envFile,
			stdoutPath: options.stdout,
			stderrPath: options.stderr,
			launchAgentsDir: options.launchAgentsDir,
			load: options.load,
		});
		print(result, true);
	});

program
	.command("db stats")
	.description("Show local storage and dataset stats")
	.action(async () => {
		await autoUpdateBeforeRead();
		const meta = await getQueryEnvelope();
		const paths = getBirdclawPaths();
		print(
			{
				paths,
				stats: meta.stats,
				transport: meta.transport,
			},
			program.opts().json ?? false,
		);
	});

const backupCommand = program
	.command("backup")
	.description("Export, import, and validate Git-friendly text backups");

backupCommand
	.command("export")
	.description("Export canonical JSONL backup shards")
	.requiredOption("--repo <path>", "Backup repository/path")
	.option("--commit", "Create a git commit in the backup repo")
	.option("--push", "Push the backup repo after committing")
	.option(
		"--message <message>",
		"Git commit message",
		"archive: update birdclaw backup",
	)
	.option("--no-validate", "Skip post-export validation")
	.action(async (options) => {
		const result = await exportBackup({
			repoPath: options.repo,
			commit: Boolean(options.commit) || Boolean(options.push),
			push: Boolean(options.push),
			message: options.message,
			validate: options.validate,
		});
		print(result, true);
	});

backupCommand
	.command("import <repo>")
	.description("Merge a canonical JSONL backup into the local SQLite store")
	.option("--no-validate", "Skip backup validation before import")
	.option("--replace", "Replace local portable tables instead of merging")
	.action(async (repo, options) => {
		const result = await importBackup({
			repoPath: repo,
			validate: options.validate,
			mode: options.replace ? "replace" : "merge",
		});
		print(result, true);
	});

backupCommand
	.command("sync")
	.description("Pull, merge-import, export, commit, and push a backup repo")
	.requiredOption("--repo <path>", "Backup repository/path")
	.option("--remote <url>", "Git remote to clone/configure")
	.option(
		"--message <message>",
		"Git commit message",
		"archive: sync birdclaw backup",
	)
	.action(async (options) => {
		const result = await syncBackup({
			repoPath: options.repo,
			remote: options.remote,
			message: options.message,
		});
		print(result, true);
	});

backupCommand
	.command("validate <repo>")
	.description("Validate backup manifest, shard hashes, and JSONL rows")
	.action(async (repo) => {
		const result = await validateBackup(repo);
		print(result, true);
		if (!result.ok) {
			process.exitCode = 1;
		}
	});

program
	.command("serve")
	.description("Run the local web app")
	.action(async () => {
		await autoUpdateBeforeRead();
		const child = spawn(
			process.execPath,
			[
				"node_modules/vite/bin/vite.js",
				"dev",
				"--host",
				"127.0.0.1",
				"--port",
				"3000",
			],
			{
				cwd: packageRoot,
				env: { ...process.env, BIRDCLAW_LOCAL_WEB: "1" },
				stdio: "inherit",
				detached: process.platform !== "win32",
			},
		);
		const forwardedSignals = [
			"SIGINT",
			"SIGTERM",
			"SIGHUP",
			"SIGQUIT",
		] as const;
		const forwardSignal = (signal: NodeJS.Signals) => {
			if (child.exitCode === null && child.signalCode === null) {
				signalChild(signal);
			}
		};
		const signalChild = (signal: NodeJS.Signals) => {
			if (child.pid === undefined) {
				return;
			}
			const targetPid = process.platform === "win32" ? child.pid : -child.pid;
			try {
				process.kill(targetPid, signal);
			} catch (error) {
				if (
					!(
						typeof error === "object" &&
						error !== null &&
						"code" in error &&
						error.code === "ESRCH"
					)
				) {
					throw error;
				}
			}
		};
		const removeSignalHandlers = () => {
			for (const signal of forwardedSignals) {
				process.removeListener(signal, forwardSignal);
			}
		};
		for (const signal of forwardedSignals) {
			process.on(signal, forwardSignal);
		}
		child.on("exit", (code, signal) => {
			removeSignalHandlers();
			if (signal) {
				process.kill(process.pid, signal);
				return;
			}
			process.exit(code ?? 0);
		});
	});

export async function runCli(argv = process.argv) {
	try {
		await program.parseAsync(argv);
	} finally {
		await closeDatabase();
	}
}

/* v8 ignore next 5 */
if (process.argv[1]) {
	const entryUrl = pathToFileURL(process.argv[1]).href;
	if (import.meta.url === entryUrl) {
		void runCli().catch((error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});
	}
}

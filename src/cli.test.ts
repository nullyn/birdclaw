// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureBirdclawDirsMock = vi.fn();
const getBirdclawPathsMock = vi.fn();
const setActionsTransportMock = vi.fn();
const getQueryEnvelopeMock = vi.fn();
const closeDatabaseMock = vi.fn();
const findArchivesMock = vi.fn();
const importArchiveMock = vi.fn();
const maybeAutoUpdateBackupMock = vi.fn();
const maybeAutoSyncBackupMock = vi.fn();
const exportBackupMock = vi.fn();
const importBackupMock = vi.fn();
const syncBackupMock = vi.fn();
const validateBackupMock = vi.fn();
const runBookmarkSyncJobMock = vi.fn();
const installBookmarkSyncLaunchAgentMock = vi.fn();
const generateBookmarkMetadataMock = vi.fn();
const listTimelineItemsMock = vi.fn();
const syncTimelineCollectionMock = vi.fn();
const backfillBookmarkReferenceParentsMock = vi.fn();
const spawnMock = vi.fn();
const consoleLogMock = vi.spyOn(console, "log").mockImplementation(() => {});
const consoleErrorMock = vi
	.spyOn(console, "error")
	.mockImplementation(() => {});

vi.mock("#/lib/config", () => ({
	ensureBirdclawDirs: () => ensureBirdclawDirsMock(),
	getBirdclawPaths: () => getBirdclawPathsMock(),
	setActionsTransport: (...args: unknown[]) => setActionsTransportMock(...args),
}));

vi.mock("#/lib/db", () => ({
	closeDatabase: () => closeDatabaseMock(),
}));

vi.mock("#/lib/archive-finder", () => ({
	findArchives: () => findArchivesMock(),
}));

vi.mock("#/lib/archive-import", () => ({
	ARCHIVE_IMPORT_SLICES: [
		"tweets",
		"likes",
		"bookmarks",
		"directMessages",
		"profiles",
		"followers",
		"following",
	],
	importArchive: (...args: unknown[]) => importArchiveMock(...args),
}));

vi.mock("#/lib/backup", () => ({
	exportBackup: (...args: unknown[]) => exportBackupMock(...args),
	importBackup: (...args: unknown[]) => importBackupMock(...args),
	maybeAutoUpdateBackup: () => maybeAutoUpdateBackupMock(),
	maybeAutoSyncBackup: () => maybeAutoSyncBackupMock(),
	syncBackup: (...args: unknown[]) => syncBackupMock(...args),
	validateBackup: (...args: unknown[]) => validateBackupMock(...args),
}));

vi.mock("#/lib/bookmark-sync-job", () => ({
	installBookmarkSyncLaunchAgent: (...args: unknown[]) =>
		installBookmarkSyncLaunchAgentMock(...args),
	runBookmarkSyncJob: (...args: unknown[]) => runBookmarkSyncJobMock(...args),
}));

vi.mock("#/lib/bookmark-metadata", () => ({
	generateBookmarkMetadata: (...args: unknown[]) =>
		generateBookmarkMetadataMock(...args),
}));

vi.mock("#/lib/queries", () => ({
	getQueryEnvelope: () => getQueryEnvelopeMock(),
	listTimelineItems: (...args: unknown[]) => listTimelineItemsMock(...args),
}));

vi.mock("#/lib/timeline-collections-live", () => ({
	backfillBookmarkReferenceParents: (...args: unknown[]) =>
		backfillBookmarkReferenceParentsMock(...args),
	syncTimelineCollection: (...args: unknown[]) =>
		syncTimelineCollectionMock(...args),
}));

vi.mock("node:child_process", () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
}));

async function loadCli() {
	vi.resetModules();
	return import("./cli");
}

describe("cli", () => {
	beforeEach(() => {
		process.exitCode = undefined;
		consoleLogMock.mockClear();
		consoleErrorMock.mockClear();
		ensureBirdclawDirsMock.mockReset();
		getBirdclawPathsMock.mockReset();
		setActionsTransportMock.mockReset();
		getQueryEnvelopeMock.mockReset();
		closeDatabaseMock.mockReset();
		findArchivesMock.mockReset();
		importArchiveMock.mockReset();
		maybeAutoUpdateBackupMock.mockReset();
		maybeAutoSyncBackupMock.mockReset();
		exportBackupMock.mockReset();
		importBackupMock.mockReset();
		syncBackupMock.mockReset();
		validateBackupMock.mockReset();
		runBookmarkSyncJobMock.mockReset();
		installBookmarkSyncLaunchAgentMock.mockReset();
		generateBookmarkMetadataMock.mockReset();
		listTimelineItemsMock.mockReset();
		syncTimelineCollectionMock.mockReset();
		backfillBookmarkReferenceParentsMock.mockReset();
		spawnMock.mockReset();

		ensureBirdclawDirsMock.mockReturnValue({
			rootDir: "/tmp/.birdclaw",
			configPath: "/tmp/.birdclaw/config.json",
			dbPath: "/tmp/.birdclaw/birdclaw.sqlite",
			mediaOriginalsDir: "/tmp/.birdclaw/media/originals",
			mediaThumbsDir: "/tmp/.birdclaw/media/thumbs",
		});
		getBirdclawPathsMock.mockReturnValue({
			rootDir: "/tmp/.birdclaw",
			dbPath: "/tmp/.birdclaw/birdclaw.sqlite",
		});
		setActionsTransportMock.mockImplementation((transport: string) => ({
			configPath: "/tmp/.birdclaw/config.json",
			transport,
		}));
		getQueryEnvelopeMock.mockResolvedValue({
			stats: { bookmarks: 3, likes: 2 },
			transport: { statusText: "local", installed: false },
			accounts: [],
			archives: [],
		});
		findArchivesMock.mockResolvedValue([
			{ name: "twitter.zip", path: "/tmp/twitter.zip" },
		]);
		importArchiveMock.mockResolvedValue({
			ok: true,
			archivePath: "/tmp/twitter.zip",
		});
		maybeAutoUpdateBackupMock.mockResolvedValue({
			ok: true,
			enabled: false,
			skipped: true,
		});
		maybeAutoSyncBackupMock.mockResolvedValue({
			ok: true,
			enabled: false,
			skipped: true,
		});
		exportBackupMock.mockResolvedValue({ ok: true, exported: 1 });
		importBackupMock.mockResolvedValue({ ok: true, imported: 1 });
		syncBackupMock.mockResolvedValue({ ok: true, synced: true });
		validateBackupMock.mockResolvedValue({ ok: true });
		runBookmarkSyncJobMock.mockResolvedValue({ ok: true, count: 2 });
		installBookmarkSyncLaunchAgentMock.mockResolvedValue({ ok: true });
		generateBookmarkMetadataMock.mockResolvedValue({
			scanned: 2,
			generated: 1,
			skipped: 1,
			failed: 0,
		});
		listTimelineItemsMock.mockReturnValue([{ id: "tweet_1" }]);
		syncTimelineCollectionMock.mockResolvedValue({
			ok: true,
			source: "xurl",
			kind: "bookmarks",
			count: 1,
		});
		backfillBookmarkReferenceParentsMock.mockResolvedValue({
			ok: true,
			scanned: 2,
			fetched: 1,
		});
		spawnMock.mockReturnValue({
			exitCode: null,
			signalCode: null,
			on: vi.fn(),
		});
	});

	it("prints init, auth status, archive results, and db stats", async () => {
		const { runCli } = await loadCli();

		await runCli(["node", "birdclaw", "--json", "init"]);
		await runCli(["node", "birdclaw", "--json", "auth", "status"]);
		await runCli(["node", "birdclaw", "--json", "archive", "find"]);
		await runCli(["node", "birdclaw", "--json", "db", "stats"]);

		expect(ensureBirdclawDirsMock).toHaveBeenCalled();
		expect(findArchivesMock).toHaveBeenCalled();
		expect(maybeAutoUpdateBackupMock).toHaveBeenCalledTimes(1);
		expect(consoleLogMock).toHaveBeenCalledWith(
			expect.stringContaining('"bookmarks": 3'),
		);
	});

	it("sets the preferred auth transport and rejects unsupported transports", async () => {
		const { runCli } = await loadCli();

		await runCli(["node", "birdclaw", "--json", "auth", "use", "xurl"]);
		await runCli(["node", "birdclaw", "--json", "auth", "use", "bad"]);

		expect(setActionsTransportMock).toHaveBeenCalledWith("xurl");
		expect(consoleErrorMock).toHaveBeenCalledWith(
			JSON.stringify({ error: "transport must be auto, bird, or xurl" }),
		);
		expect(process.exitCode).toBe(1);
	});

	it("imports discovered and explicit archives", async () => {
		const { runCli } = await loadCli();

		await runCli(["node", "birdclaw", "--json", "import", "archive"]);
		await runCli([
			"node",
			"birdclaw",
			"--json",
			"import",
			"archive",
			"/tmp/manual.zip",
			"--select",
			"likes,bookmarks",
		]);

		expect(importArchiveMock).toHaveBeenNthCalledWith(
			1,
			"/tmp/twitter.zip",
			expect.objectContaining({ select: undefined }),
		);
		expect(importArchiveMock).toHaveBeenNthCalledWith(
			2,
			"/tmp/manual.zip",
			expect.objectContaining({ select: ["likes", "bookmarks"] }),
		);
		expect(maybeAutoSyncBackupMock).toHaveBeenCalledTimes(2);
	});

	it("rejects invalid archive import selections", async () => {
		const { runCli } = await loadCli();

		await runCli([
			"node",
			"birdclaw",
			"--json",
			"import",
			"archive",
			"/tmp/manual.zip",
			"--select",
			"timeline",
		]);

		expect(importArchiveMock).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(consoleErrorMock).toHaveBeenCalledWith(
			expect.stringContaining("--select must be a comma-separated subset"),
		);
	});

	it("searches tweets with bookmark and quality filters", async () => {
		const { runCli } = await loadCli();

		await runCli([
			"node",
			"birdclaw",
			"--json",
			"search",
			"tweets",
			"agents",
			"--resource",
			"home",
			"--bookmarked",
			"--hide-low-quality",
			"--min-likes",
			"4",
			"--limit",
			"7",
		]);

		expect(maybeAutoUpdateBackupMock).toHaveBeenCalled();
		expect(listTimelineItemsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				resource: "home",
				search: "agents",
				bookmarkedOnly: true,
				qualityFilter: "summary",
				lowQualityThreshold: 4,
				limit: 7,
			}),
		);
	});

	it("rejects invalid tweet search numeric filters", async () => {
		const { runCli } = await loadCli();

		await runCli([
			"node",
			"birdclaw",
			"--json",
			"search",
			"tweets",
			"agents",
			"--min-likes",
			"many",
		]);

		expect(listTimelineItemsMock).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it("syncs likes and bookmarks collections", async () => {
		const { runCli } = await loadCli();

		await runCli([
			"node",
			"birdclaw",
			"sync",
			"bookmarks",
			"--account",
			"acct_primary",
			"--mode",
			"xurl",
			"--limit",
			"10",
			"--max-pages",
			"2",
			"--refresh",
			"--early-stop",
		]);
		await runCli(["node", "birdclaw", "sync", "likes"]);

		expect(syncTimelineCollectionMock).toHaveBeenNthCalledWith(1, {
			kind: "bookmarks",
			account: "acct_primary",
			mode: "xurl",
			limit: 10,
			all: true,
			maxPages: 2,
			refresh: true,
			cacheTtlMs: 120_000,
			earlyStop: true,
		});
		expect(syncTimelineCollectionMock).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ kind: "likes", mode: "auto" }),
		);
		expect(maybeAutoSyncBackupMock).toHaveBeenCalledTimes(2);
	});

	it("runs bookmark jobs", async () => {
		const { runCli } = await loadCli();

		await runCli([
			"node",
			"birdclaw",
			"jobs",
			"sync-bookmarks",
			"--mode",
			"bird",
			"--limit",
			"50",
			"--all",
			"--log",
			"/tmp/bookmarks.jsonl",
		]);
		await runCli([
			"node",
			"birdclaw",
			"jobs",
			"generate-bookmark-metadata",
			"--refresh",
			"--limit",
			"12",
			"--model",
			"gpt-test",
		]);
		await runCli([
			"node",
			"birdclaw",
			"jobs",
			"backfill-bookmark-parents",
			"--mode",
			"xurl",
			"--batch-size",
			"25",
		]);
		await runCli([
			"node",
			"birdclaw",
			"jobs",
			"install-bookmarks-launchd",
			"--program",
			"birdclaw",
			"--no-load",
		]);

		expect(runBookmarkSyncJobMock).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "bird",
				limit: 50,
				all: true,
				maxPages: undefined,
				logPath: "/tmp/bookmarks.jsonl",
			}),
		);
		expect(generateBookmarkMetadataMock).toHaveBeenCalledWith({
			refresh: true,
			limit: 12,
			model: "gpt-test",
			skipImageLabels: false,
		});
		expect(backfillBookmarkReferenceParentsMock).toHaveBeenCalledWith({
			mode: "xurl",
			batchSize: 25,
		});
		expect(installBookmarkSyncLaunchAgentMock).toHaveBeenCalledWith(
			expect.objectContaining({ program: "birdclaw", load: false }),
		);
	});

	it("dispatches backup commands", async () => {
		const { runCli } = await loadCli();

		await runCli([
			"node",
			"birdclaw",
			"backup",
			"export",
			"--repo",
			"/tmp/bak",
			"--commit",
			"--push",
			"--message",
			"sync backup",
			"--no-validate",
		]);
		await runCli([
			"node",
			"birdclaw",
			"backup",
			"import",
			"/tmp/bak",
			"--replace",
			"--no-validate",
		]);
		await runCli([
			"node",
			"birdclaw",
			"backup",
			"sync",
			"--repo",
			"/tmp/bak",
			"--remote",
			"git@example.com:backup.git",
		]);
		await runCli(["node", "birdclaw", "backup", "validate", "/tmp/bak"]);

		expect(exportBackupMock).toHaveBeenCalledWith({
			repoPath: "/tmp/bak",
			commit: true,
			push: true,
			message: "sync backup",
			validate: false,
		});
		expect(importBackupMock).toHaveBeenCalledWith({
			repoPath: "/tmp/bak",
			validate: false,
			mode: "replace",
		});
		expect(syncBackupMock).toHaveBeenCalledWith({
			repoPath: "/tmp/bak",
			remote: "git@example.com:backup.git",
			message: "archive: sync birdclaw backup",
		});
		expect(validateBackupMock).toHaveBeenCalledWith("/tmp/bak");
	});

	it("sets exit code when backup validation fails", async () => {
		validateBackupMock.mockResolvedValueOnce({ ok: false });
		const { runCli } = await loadCli();

		await runCli(["node", "birdclaw", "backup", "validate", "/tmp/bak"]);

		expect(process.exitCode).toBe(1);
	});

	it("starts the local web server", async () => {
		const { runCli } = await loadCli();

		await runCli(["node", "birdclaw", "serve"]);

		expect(maybeAutoUpdateBackupMock).toHaveBeenCalled();
		expect(spawnMock).toHaveBeenCalledWith(
			process.execPath,
			expect.arrayContaining(["dev", "--host", "127.0.0.1", "--port", "3000"]),
			expect.objectContaining({
				env: expect.objectContaining({ BIRDCLAW_LOCAL_WEB: "1" }),
			}),
		);
	});
});

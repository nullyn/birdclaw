// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const maybeAutoSyncBackupMock = vi.fn();
const syncTimelineCollectionMock = vi.fn();

vi.mock("./backup", () => ({
	maybeAutoSyncBackup: (...args: unknown[]) => maybeAutoSyncBackupMock(...args),
	maybeAutoSyncBackupEffect: (...args: unknown[]) =>
		Effect.tryPromise({
			try: () => maybeAutoSyncBackupMock(...args),
			catch: (error) => error,
		}),
}));

vi.mock("./timeline-collections-live", () => ({
	syncTimelineCollection: (...args: unknown[]) =>
		syncTimelineCollectionMock(...args),
	syncTimelineCollectionEffect: (...args: unknown[]) =>
		Effect.tryPromise({
			try: () => syncTimelineCollectionMock(...args),
			catch: (error) => error,
		}),
}));

import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	clearWebSyncLocksForTests,
	getWebSyncJob,
	parseWebSyncKind,
	runWebSync,
	runWebSyncEffect,
	startWebSync,
} from "./web-sync";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}

const originalBirdclawHome = process.env.BIRDCLAW_HOME;
const tempRoots: string[] = [];

function setupDefaultAccount(accountId: string) {
	const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-web-sync-"));
	tempRoots.push(tempRoot);
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
	getNativeDb({ seedDemoData: false })
		.prepare(
			`
      insert into accounts (id, name, handle, transport, is_default, created_at)
      values (?, ?, ?, ?, ?, ?)
      `,
		)
		.run(accountId, "Studio", "@studio", "bird", 1, "2026-01-01T00:00:00.000Z");
}

describe("web sync dispatcher", () => {
	beforeEach(() => {
		clearWebSyncLocksForTests();
		vi.useRealTimers();
		maybeAutoSyncBackupMock.mockReset();
		syncTimelineCollectionMock.mockReset();
		maybeAutoSyncBackupMock.mockResolvedValue({
			ok: true,
			enabled: false,
			skipped: true,
		});
	});

	afterEach(() => {
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		if (originalBirdclawHome === undefined) {
			delete process.env.BIRDCLAW_HOME;
		} else {
			process.env.BIRDCLAW_HOME = originalBirdclawHome;
		}
		for (const tempRoot of tempRoots.splice(0)) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("syncs saved collections through the shared collection path and backup pass", async () => {
		syncTimelineCollectionMock.mockResolvedValue({
			ok: true,
			source: "bird",
			count: 11,
		});

		const result = await runWebSync("bookmarks");

		expect(syncTimelineCollectionMock).toHaveBeenCalledWith({
			kind: "bookmarks",
			mode: "auto",
			limit: 100,
			maxPages: 5,
			refresh: true,
			earlyStop: true,
		});
		expect(maybeAutoSyncBackupMock).toHaveBeenCalled();
		expect(result).toMatchObject({
			ok: true,
			kind: "bookmarks",
			summary: "Synced 11 items",
			steps: [{ kind: "bookmarks", count: 11, source: "bird" }],
		});
	});

	it("uses account-targeted xurl mode for selected saved collection syncs", async () => {
		syncTimelineCollectionMock.mockResolvedValue({
			ok: true,
			source: "xurl",
			count: 7,
		});

		await runWebSync("likes", "acct_studio");

		expect(syncTimelineCollectionMock).toHaveBeenCalledWith({
			kind: "likes",
			account: "acct_studio",
			mode: "xurl",
			limit: 100,
			maxPages: 5,
			refresh: true,
			earlyStop: true,
		});
	});

	it("keeps auto fallback for default-account saved collection syncs", async () => {
		setupDefaultAccount("acct_studio");
		syncTimelineCollectionMock.mockResolvedValue({
			ok: true,
			source: "bird",
			count: 7,
		});

		await runWebSync("likes", "acct_studio");

		expect(syncTimelineCollectionMock).toHaveBeenCalledWith({
			kind: "likes",
			account: "acct_studio",
			mode: "auto",
			limit: 100,
			maxPages: 5,
			refresh: true,
			earlyStop: true,
		});
	});

	it("returns an in-progress response for duplicate sync clicks", async () => {
		const pending = deferred<{ ok: boolean; source: string; count: number }>();
		syncTimelineCollectionMock.mockReturnValue(pending.promise);

		const first = runWebSync("bookmarks");
		const second = await runWebSync("bookmarks");
		pending.resolve({ ok: true, source: "bird", count: 1 });
		await first;

		expect(second).toMatchObject({
			ok: false,
			kind: "bookmarks",
			inProgress: true,
			summary: "Sync already running",
		});
		expect(syncTimelineCollectionMock).toHaveBeenCalledTimes(1);
	});

	it("does not start a sync while constructing the Effect", async () => {
		const pending = deferred<{ ok: boolean; source: string; count: number }>();
		syncTimelineCollectionMock.mockReturnValue(pending.promise);

		const effect = runWebSyncEffect("bookmarks");

		expect(syncTimelineCollectionMock).not.toHaveBeenCalled();

		const result = Effect.runPromise(effect);
		expect(syncTimelineCollectionMock).toHaveBeenCalledTimes(1);
		pending.resolve({ ok: true, source: "bird", count: 1 });

		await expect(result).resolves.toMatchObject({
			ok: true,
			kind: "bookmarks",
		});
	});

	it("keeps account-aware running locks scoped by account", async () => {
		const primary = deferred<{ ok: boolean; source: string; count: number }>();
		const studio = deferred<{ ok: boolean; source: string; count: number }>();
		syncTimelineCollectionMock
			.mockReturnValueOnce(primary.promise)
			.mockReturnValueOnce(studio.promise);

		const primaryJob = startWebSync("likes", "acct_primary");
		const studioJob = startWebSync("likes", "acct_studio");

		expect(primaryJob.id).not.toBe(studioJob.id);
		expect(syncTimelineCollectionMock).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ account: "acct_primary" }),
		);
		expect(syncTimelineCollectionMock).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ account: "acct_studio" }),
		);

		primary.resolve({ ok: true, source: "bird", count: 1 });
		studio.resolve({ ok: true, source: "bird", count: 2 });
		await vi.waitFor(() => {
			expect(getWebSyncJob(primaryJob.id)).toMatchObject({
				status: "succeeded",
				accountId: "acct_primary",
			});
			expect(getWebSyncJob(studioJob.id)).toMatchObject({
				status: "succeeded",
				accountId: "acct_studio",
			});
		});
	});

	it("treats omitted account and the default account as the same running sync", async () => {
		setupDefaultAccount("acct_studio");
		const pending = deferred<{ ok: boolean; source: string; count: number }>();
		syncTimelineCollectionMock.mockReturnValue(pending.promise);

		const defaultJob = startWebSync("likes");
		const explicitDefaultJob = startWebSync("likes", "acct_studio");

		expect(explicitDefaultJob.id).toBe(defaultJob.id);
		expect(syncTimelineCollectionMock).toHaveBeenCalledTimes(1);

		pending.resolve({ ok: true, source: "bird", count: 1 });
		await vi.waitFor(() => {
			expect(getWebSyncJob(defaultJob.id)).toMatchObject({
				status: "succeeded",
			});
		});
	});

	it("tracks background sync jobs through completion", async () => {
		const pending = deferred<{ ok: boolean; source: string; count: number }>();
		syncTimelineCollectionMock.mockReturnValue(pending.promise);

		const job = startWebSync("bookmarks");

		expect(job).toMatchObject({
			kind: "bookmarks",
			status: "running",
			inProgress: true,
		});
		expect(getWebSyncJob(job.id)).toMatchObject({ status: "running" });

		pending.resolve({ ok: true, source: "bird", count: 5 });
		await vi.waitFor(() => {
			expect(getWebSyncJob(job.id)).toMatchObject({
				status: "succeeded",
				inProgress: false,
				summary: "Synced 5 items",
			});
		});
	});

	it("keeps non-Error background failure messages in job snapshots", async () => {
		syncTimelineCollectionMock.mockRejectedValue("rate limited");

		const job = startWebSync("bookmarks");

		await vi.waitFor(() => {
			expect(getWebSyncJob(job.id)).toMatchObject({
				status: "failed",
				summary: "rate limited",
				error: "rate limited",
			});
		});
	});

	it("expires completed background sync jobs after the polling window", async () => {
		vi.useFakeTimers();
		syncTimelineCollectionMock.mockResolvedValue({
			ok: true,
			source: "bird",
			count: 5,
		});

		const job = startWebSync("bookmarks");
		await vi.waitFor(() => {
			expect(getWebSyncJob(job.id)).toMatchObject({
				status: "succeeded",
				inProgress: false,
			});
		});

		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

		expect(getWebSyncJob(job.id)).toBeNull();
	});

	it("parses only supported sync kinds", () => {
		expect(parseWebSyncKind("likes")).toBe("likes");
		expect(parseWebSyncKind("bookmarks")).toBe("bookmarks");
		expect(parseWebSyncKind("timeline")).toBeNull();
		expect(parseWebSyncKind("blocks")).toBeNull();
		expect(parseWebSyncKind(undefined)).toBeNull();
	});
});

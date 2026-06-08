// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteHandler } from "#/test/route-handlers";

const getWebSyncJobMock = vi.fn();
const startWebSyncMock = vi.fn();

vi.mock("#/lib/web-sync", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/lib/web-sync")>();
	return {
		...actual,
		getWebSyncJob: (...args: unknown[]) => getWebSyncJobMock(...args),
		startWebSync: (...args: unknown[]) => startWebSyncMock(...args),
	};
});

import { Route } from "./sync";

const GET = getRouteHandler(Route, "GET");
const POST = getRouteHandler(Route, "POST");

describe("api sync route", () => {
	beforeEach(() => {
		getWebSyncJobMock.mockReset();
		startWebSyncMock.mockReset();
	});

	it("starts a supported sync kind as a background job", async () => {
		startWebSyncMock.mockReturnValue({
			id: "sync_bookmarks_1",
			kind: "bookmarks",
			accountId: "acct_primary",
			status: "running",
			startedAt: "2026-05-15T12:00:00.000Z",
			summary: "Syncing Bookmarks",
			inProgress: true,
		});

		const response = await POST({
			request: new Request("http://localhost/api/sync", {
				method: "POST",
				body: JSON.stringify({ kind: "bookmarks", accountId: "acct_primary" }),
			}),
		});

		expect(response.status).toBe(202);
		expect(startWebSyncMock).toHaveBeenCalledWith("bookmarks", "acct_primary");
		expect(await response.json()).toMatchObject({
			id: "sync_bookmarks_1",
			accountId: "acct_primary",
			status: "running",
			summary: "Syncing Bookmarks",
		});
	});

	it("returns an existing running job for duplicate sync starts", async () => {
		startWebSyncMock.mockReturnValue({
			id: "sync_likes_1",
			kind: "likes",
			status: "running",
			startedAt: "2026-05-15T12:00:00.000Z",
			inProgress: true,
			summary: "Syncing Likes",
		});

		const response = await POST({
			request: new Request("http://localhost/api/sync", {
				method: "POST",
				body: JSON.stringify({ kind: "likes" }),
			}),
		});

		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({
			id: "sync_likes_1",
			inProgress: true,
		});
	});

	it("returns sync job status by id", async () => {
		getWebSyncJobMock.mockReturnValue({
			id: "sync_bookmarks_1",
			kind: "bookmarks",
			status: "succeeded",
			startedAt: "2026-05-15T12:00:00.000Z",
			finishedAt: "2026-05-15T12:00:02.000Z",
			summary: "Synced 5 items",
			inProgress: false,
			result: {
				ok: true,
				kind: "bookmarks",
				startedAt: "2026-05-15T12:00:00.000Z",
				finishedAt: "2026-05-15T12:00:02.000Z",
				summary: "Synced 5 items",
				steps: [],
			},
		});

		const response = await GET({
			request: new Request("http://localhost/api/sync?id=sync_bookmarks_1"),
		});

		expect(response.status).toBe(200);
		expect(getWebSyncJobMock).toHaveBeenCalledWith("sync_bookmarks_1");
		expect(await response.json()).toMatchObject({ status: "succeeded" });
	});

	it("rejects unknown sync kinds", async () => {
		const response = await POST({
			request: new Request("http://localhost/api/sync", {
				method: "POST",
				body: JSON.stringify({ kind: "blocks" }),
			}),
		});

		expect(response.status).toBe(400);
		expect(startWebSyncMock).not.toHaveBeenCalled();
	});

	it("returns 404 for unknown sync job ids", async () => {
		getWebSyncJobMock.mockReturnValue(null);

		const response = await GET({
			request: new Request("http://localhost/api/sync?id=missing"),
		});

		expect(response.status).toBe(404);
	});
});

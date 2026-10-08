import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineItem } from "#/lib/types";
import { useBookmarkIntelligence } from "./useBookmarkIntelligence";

function item(id: string): TimelineItem {
	return {
		id,
		accountId: "acct_a",
		accountHandle: "alice",
		kind: "bookmark",
		text: `Post ${id}`,
		createdAt: "2026-01-01T00:00:00.000Z",
		isReplied: false,
		likeCount: 0,
		mediaCount: 0,
		bookmarked: true,
		liked: false,
		author: {
			id: "profile_author",
			handle: "author",
			displayName: "Author",
			bio: "",
			followersCount: 0,
			avatarHue: 0,
			createdAt: "2026-01-01T00:00:00.000Z",
		},
		entities: {},
		media: [],
	};
}

function response(id: string, query = "") {
	return new Response(
		JSON.stringify({
			items: [
				{
					id,
					model: "jev-1.13.0",
					topics: { AI: 0.9 },
					relevance: query
						? { score: 3, confidence: 0.8, probabilities: { "3": 0.8 } }
						: null,
				},
			],
			topics: ["AI"],
			requests: 1,
			inputTokens: 42,
			skippedIds: [],
		}),
	);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, index: number) {
	return JSON.parse(fetchMock.mock.calls[index]![1]!.body as string) as Record<
		string,
		unknown
	>;
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("useBookmarkIntelligence", () => {
	it("opens with a cached-only lookup and submits a live request on demand", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response("bookmark-1"))
			.mockResolvedValueOnce(response("bookmark-1", "agents"));
		vi.stubGlobal("fetch", fetchMock);
		const { result } = renderHook(() =>
			useBookmarkIntelligence([item("bookmark-1")], "acct_a", true),
		);

		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(requestBody(fetchMock, 0)).toMatchObject({
			ids: ["bookmark-1"],
			account: "acct_a",
			cachedOnly: true,
		});
		expect(requestBody(fetchMock, 0)).not.toHaveProperty("query");
		expect(result.current.activeQuery).toBe("");

		act(() => result.current.setQuery(" agents "));
		await act(async () => {
			await result.current.analyze();
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(requestBody(fetchMock, 1)).toMatchObject({
			ids: ["bookmark-1"],
			account: "acct_a",
			query: "agents",
		});
		expect(requestBody(fetchMock, 1)).not.toHaveProperty("cachedOnly");
		expect(result.current.activeQuery).toBe("agents");
		expect(result.current.analysis?.data.items[0]?.id).toBe("bookmark-1");
	});

	it("clears the active query when the user edits the search", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(response("bookmark-1"));
		vi.stubGlobal("fetch", fetchMock);
		const { result } = renderHook(() =>
			useBookmarkIntelligence([item("bookmark-1")], "acct_a", true),
		);
		await waitFor(() =>
			expect(result.current.analysis?.data.items).toBeDefined(),
		);

		act(() => result.current.setQuery("new question"));
		expect(result.current.analysis).not.toBeNull();
		expect(result.current.activeQuery).toBe("");
	});

	it("aborts old scope requests and ignores their stale results", async () => {
		const pending = deferred<Response>();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response("old-bookmark"))
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValueOnce(response("new-bookmark"));
		vi.stubGlobal("fetch", fetchMock);
		const { result, rerender } = renderHook(
			({ items, account }) => useBookmarkIntelligence(items, account, true),
			{
				initialProps: {
					items: [item("old-bookmark")],
					account: "acct_a" as string | undefined,
				},
			},
		);
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		await waitFor(() =>
			expect(result.current.analysis?.data.items[0]?.id).toBe("old-bookmark"),
		);
		act(() => {
			void result.current.analyze();
		});
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		const oldSignal = fetchMock.mock.calls[1]![1]!.signal as AbortSignal;

		rerender({ items: [item("new-bookmark")], account: "acct_b" });
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
		expect(oldSignal.aborted).toBe(true);
		await waitFor(() =>
			expect(result.current.analysis?.data.items[0]?.id).toBe("new-bookmark"),
		);
		await act(async () => {
			pending.resolve(response("old-bookmark"));
			await pending.promise;
		});
		expect(
			result.current.analysis?.data.items.map((entry) => entry.id),
		).toEqual(["new-bookmark"]);
		expect(requestBody(fetchMock, 2)).toMatchObject({
			ids: ["new-bookmark"],
			account: "acct_b",
			cachedOnly: true,
		});
	});

	it("shows request failures and permits retry", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response("bookmark-1"))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ message: "JEV unavailable" }), {
					status: 503,
				}),
			)
			.mockResolvedValueOnce(response("bookmark-1", "retry"));
		vi.stubGlobal("fetch", fetchMock);
		const { result } = renderHook(() =>
			useBookmarkIntelligence([item("bookmark-1")], "acct_a", true),
		);
		await waitFor(() =>
			expect(result.current.analysis?.data.items).toBeDefined(),
		);
		act(() => result.current.setQuery("retry"));

		await act(async () => {
			await result.current.analyze();
		});
		expect(result.current.error).toBe("JEV unavailable");
		expect(result.current.busy).toBe(false);

		await act(async () => {
			await result.current.analyze();
		});
		expect(result.current.error).toBeNull();
		expect(result.current.analysis?.query).toBe("retry");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
});

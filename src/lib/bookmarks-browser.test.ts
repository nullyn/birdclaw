// @vitest-environment node
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getCookies: vi.fn(), launch: vi.fn() }));
vi.mock("@steipete/sweet-cookie", () => ({ getCookies: mocks.getCookies }));
vi.mock("playwright", () => ({ chromium: { launch: mocks.launch } }));
import {
	listBrowserBookmarksEffect,
	parseBrowserBookmarks,
} from "./bookmarks-browser";

function makeResponse(
	payload: unknown,
	url = "https://x.com/graphql/op/Bookmarks",
) {
	return {
		url: () => url,
		ok: () => true,
		status: () => 200,
		json: async () => payload,
	};
}

function makeCollectorHarness(
	options: {
		profile?: string;
		onGoto?: (
			emit: (response: ReturnType<typeof makeResponse>) => void,
		) => void;
	} = {},
) {
	const responseListeners: ((
		response: ReturnType<typeof makeResponse>,
	) => void)[] = [];
	const waiters: {
		predicate: (response: ReturnType<typeof makeResponse>) => boolean;
		resolve: (response: ReturnType<typeof makeResponse>) => void;
	}[] = [];
	const emit = (response: ReturnType<typeof makeResponse>) => {
		for (const listener of responseListeners) listener(response);
		for (const [index, waiter] of waiters.entries()) {
			if (waiter.predicate(response)) {
				waiters.splice(index, 1);
				waiter.resolve(response);
				break;
			}
		}
	};
	const waitForResponse = vi.fn(
		(predicate: (response: ReturnType<typeof makeResponse>) => boolean) =>
			new Promise<ReturnType<typeof makeResponse>>((resolve) => {
				waiters.push({ predicate, resolve });
			}),
	);
	const wheel = vi.fn(async () => {});
	const close = vi.fn(async () => {});
	const page = {
		on: vi.fn(
			(
				_event: string,
				listener: (response: ReturnType<typeof makeResponse>) => void,
			) => {
				responseListeners.push(listener);
			},
		),
		waitForResponse,
		goto: vi.fn(async () => {
			options.onGoto?.(emit);
		}),
		locator: vi.fn((selector: string) =>
			selector.includes("Profile_Link")
				? {
						waitFor: vi.fn(async () => {}),
						getAttribute: vi.fn(async () => `/${options.profile ?? "alice"}`),
					}
				: {
						hover: vi.fn(async () => {}),
						last: () => ({ scrollIntoViewIfNeeded: vi.fn(async () => {}) }),
					},
		),
		mouse: { wheel },
	};
	const browser = {
		newContext: vi.fn(async () => ({
			addCookies: vi.fn(async () => {}),
			newPage: vi.fn(async () => page),
		})),
		close,
	};
	mocks.getCookies.mockResolvedValue({
		cookies: [{ name: "auth_token", value: "mock-cookie" }],
	});
	mocks.launch.mockResolvedValue(browser);
	return { browser, close, emit, page, waitForResponse, wheel };
}

beforeEach(() => {
	mocks.getCookies.mockReset();
	mocks.launch.mockReset();
});
afterEach(() => vi.useRealTimers());

function bookmarkPayload(options: { id?: string; text?: string } = {}) {
	const id = options.id ?? "tweet-1";
	const payload = {
		data: {
			bookmark_timeline_v2: {
				timeline: {
					instructions: [
						{
							type: "TimelineAddEntries",
							entries: [
								{
									content: {
										itemContent: {
											tweet_results: {
												result: {
													rest_id: id,
													core: {
														user_results: {
															result: {
																rest_id: "user-1",
																core: { screen_name: "alice", name: "Alice" },
																avatar: {
																	image_url: "https://img.test/alice.jpg",
																},
																profile_bio: {
																	description: "Engineer and avid reader",
																},
																relationship_counts: {
																	followers: 25,
																	following: 80,
																},
															},
														},
													},
													legacy: {
														id_str: id,
														created_at: "Wed Oct 07 12:00:00 +0000 2026",
														full_text: options.text ?? "Short legacy text",
														conversation_id_str: "conversation-1",
														favorite_count: 9,
														extended_entities: {
															media: [
																{
																	media_key: "3_media",
																	type: "video",
																	media_url_https:
																		"https://img.test/preview.jpg",
																	video_info: {
																		variants: [
																			{
																				url: "https://video.test/clip.mp4",
																				content_type: "video/mp4",
																				bitrate: 128000,
																			},
																		],
																	},
																},
															],
														},
													},
													note_tweet: {
														note_tweet_results: {
															result: {
																text: "A much longer note post with the full text.",
															},
														},
													},
												},
											},
										},
									},
								},
								{ content: { cursorType: "Bottom", value: "cursor-next" } },
							],
						},
					],
				},
			},
		},
	};
	const tweetResult = (
		payload.data.bookmark_timeline_v2.timeline.instructions[0]!.entries[0]!
			.content as {
			itemContent: { tweet_results: { result: Record<string, unknown> } };
		}
	).itemContent.tweet_results.result;
	(tweetResult.legacy as Record<string, unknown>).quoted_status_id_str =
		"quoted-1";
	tweetResult.quoted_status_result = {
		result: {
			rest_id: "quoted-1",
			core: {
				user_results: {
					result: {
						rest_id: "user-2",
						core: { screen_name: "bob", name: "Bob" },
					},
				},
			},
			legacy: {
				id_str: "quoted-1",
				created_at: "Tue Oct 06 12:00:00 +0000 2026",
				full_text: "The full quoted post for context.",
				conversation_id_str: "quoted-1",
			},
		},
	};
	return payload;
}

describe("parseBrowserBookmarks", () => {
	it("parses bookmark timeline v2 with core profile, note text, and media", () => {
		const parsed = parseBrowserBookmarks(bookmarkPayload());
		expect(parsed.data).toHaveLength(1);
		expect(parsed.data[0]).toMatchObject({
			id: "tweet-1",
			author_id: "user-1",
			text: "A much longer note post with the full text.",
			attachments: { media_keys: ["3_media"] },
			public_metrics: { like_count: 9 },
		});
		expect(parsed.includes?.users?.[0]).toMatchObject({
			id: "user-1",
			username: "alice",
			name: "Alice",
			description: "Engineer and avid reader",
			profile_image_url: "https://img.test/alice.jpg",
			public_metrics: { followers_count: 25, following_count: 80 },
		});
		expect(parsed.includes?.media?.[0]).toMatchObject({
			media_key: "3_media",
			type: "video",
			preview_image_url: "https://img.test/preview.jpg",
			variants: [
				{
					url: "https://video.test/clip.mp4",
					content_type: "video/mp4",
					bit_rate: 128000,
				},
			],
		});
		expect(parsed.meta?.next_token).toBe("cursor-next");
		expect(parsed.includes?.tweets).toMatchObject([
			{
				id: "quoted-1",
				author_id: "user-2",
				text: "The full quoted post for context.",
			},
		]);
		expect(parsed.data[0]?.referenced_tweets).toContainEqual({
			type: "quoted",
			id: "quoted-1",
		});
	});

	it("does not treat quoted tweet data as an additional bookmark", () => {
		const payload = bookmarkPayload();
		const item = (
			payload.data.bookmark_timeline_v2.timeline.instructions[0]!.entries[0]!
				.content as {
				itemContent: { tweet_results: { result: Record<string, unknown> } };
			}
		).itemContent;
		item.tweet_results.result.quoted_status_result = {
			result: { rest_id: "quoted-tweet" },
		};
		const parsed = parseBrowserBookmarks(payload);
		expect(parsed.data.map((tweet) => tweet.id)).toEqual(["tweet-1"]);
	});

	it("rejects X errors and malformed timeline payloads", () => {
		expect(() =>
			parseBrowserBookmarks({ errors: [{ message: "nope" }] }),
		).toThrow("X returned an error");
		expect(() => parseBrowserBookmarks({ data: {} })).toThrow(
			"missing timeline instructions",
		);
	});

	describe("listBrowserBookmarksEffect", () => {
		it("rejects a Chrome profile mismatch before calling onPage and closes the browser", async () => {
			const harness = makeCollectorHarness({
				profile: "other-user",
				onGoto: (emit) => emit(makeResponse(bookmarkPayload())),
			});
			const onPage = vi.fn();
			await expect(
				Effect.runPromise(
					listBrowserBookmarksEffect({ username: "alice", limit: 5, onPage }),
				),
			).rejects.toThrow("expected @alice");
			expect(onPage).not.toHaveBeenCalled();
			expect(harness.close).toHaveBeenCalledTimes(1);
		});

		it("consumes a prefetched page from the response queue and calls onPage for each page", async () => {
			const harness = makeCollectorHarness({
				onGoto: (emit) => {
					emit(makeResponse(bookmarkPayload({ id: "page-1" })));
					emit(makeResponse(bookmarkPayload({ id: "page-2" })));
				},
			});
			const onPage = vi.fn();
			const result = await Effect.runPromise(
				listBrowserBookmarksEffect({
					username: "alice",
					limit: 5,
					all: true,
					maxPages: 2,
					onPage,
				}),
			);
			expect(result.data.map((tweet) => tweet.id)).toEqual([
				"page-1",
				"page-2",
			]);
			expect(onPage).toHaveBeenCalledTimes(2);
			expect(harness.waitForResponse).toHaveBeenCalledTimes(1);
			expect(harness.wheel).not.toHaveBeenCalled();
			expect(harness.close).toHaveBeenCalledTimes(1);
		});

		it("stops when X repeats posts even with another cursor", async () => {
			makeCollectorHarness({
				onGoto: (emit) => {
					emit(makeResponse(bookmarkPayload()));
					emit(makeResponse(bookmarkPayload()));
				},
			});
			const onPage = vi.fn();
			const result = await Effect.runPromise(
				listBrowserBookmarksEffect({
					username: "alice",
					limit: 5,
					all: true,
					onPage,
				}),
			);
			expect(result.data).toHaveLength(1);
			expect(result.meta?.partial).toBe(true);
			expect(result.meta?.warnings).toEqual([
				"X repeated a bookmark page; imported the distinct pages already received.",
			]);
			expect(onPage).toHaveBeenCalledTimes(1);
		});

		it("closes the browser when a per-page callback fails", async () => {
			const harness = makeCollectorHarness({
				onGoto: (emit) => emit(makeResponse(bookmarkPayload())),
			});
			const onPage = vi.fn(() => {
				throw new Error("persist failed");
			});
			await expect(
				Effect.runPromise(
					listBrowserBookmarksEffect({ username: "alice", limit: 5, onPage }),
				),
			).rejects.toThrow("persist failed");
			expect(onPage).toHaveBeenCalledTimes(1);
			expect(harness.close).toHaveBeenCalledTimes(1);
		});

		it("retries a transient SQLite page-save lock without refetching X", async () => {
			const harness = makeCollectorHarness({
				onGoto: (emit) => emit(makeResponse(bookmarkPayload())),
			});
			const onPage = vi.fn().mockImplementationOnce(() => {
				throw Object.assign(new Error("database is locked"), { errcode: 517 });
			});
			const result = await Effect.runPromise(
				listBrowserBookmarksEffect({ username: "alice", limit: 5, onPage }),
			);
			expect(result.data).toHaveLength(1);
			expect(onPage).toHaveBeenCalledTimes(2);
			expect(harness.waitForResponse).toHaveBeenCalledTimes(1);
			expect(harness.close).toHaveBeenCalledTimes(1);
		});

		it("reports a later malformed page as partial and retains the first page", async () => {
			makeCollectorHarness({
				onGoto: (emit) => {
					emit(makeResponse(bookmarkPayload()));
					emit(makeResponse({ data: {} }));
				},
			});
			const onPage = vi.fn();
			const result = await Effect.runPromise(
				listBrowserBookmarksEffect({
					username: "alice",
					limit: 5,
					all: true,
					onPage,
				}),
			);
			expect(result.data).toHaveLength(1);
			expect(result.meta?.partial).toBe(true);
			expect(String(result.meta?.warnings)).toContain(
				"missing timeline instructions",
			);
			expect(onPage).toHaveBeenCalledTimes(1);
		});

		it("stops at a known local page without scrolling", async () => {
			const harness = makeCollectorHarness({
				onGoto: (emit) => emit(makeResponse(bookmarkPayload())),
			});
			const onPage = vi.fn();
			const result = await Effect.runPromise(
				listBrowserBookmarksEffect({
					username: "alice",
					limit: 5,
					all: true,
					maxPages: 3,
					onPage,
					isPageAlreadyLocal: () => true,
				}),
			);
			expect(result.meta?.saturated_at_page).toBe(1);
			expect(onPage).toHaveBeenCalledTimes(1);
			expect(harness.wheel).not.toHaveBeenCalled();
		});
	});
});

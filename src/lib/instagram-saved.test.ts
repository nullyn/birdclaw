// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getCookies: vi.fn(),
	launch: vi.fn(),
	getSaved: vi.fn(),
	upsert: vi.fn(),
}));
vi.mock("@steipete/sweet-cookie", () => ({ getCookies: mocks.getCookies }));
vi.mock("playwright", () => ({ chromium: { launch: mocks.launch } }));
vi.mock("./saved-resources", () => ({
	getSavedResource: mocks.getSaved,
	upsertSavedResource: mocks.upsert,
}));

import {
	dateFromMetadata,
	readStandalonePostDom,
	syncInstagramCollection,
} from "./instagram-saved";

function makeBrowserHarness(
	options: {
		profileHref?: string;
		collectionText?: string;
		postHref?: string;
		caption?: string;
		publishedAt?: string;
		metadataPreview?: string;
		authorComments?: string[];
		authorLinks?: string[];
	} = {},
) {
	const makePage = (detail = false) => {
		const locators: Record<string, any> = {};
		const locator = (selector: string) => {
			if (locators[selector]) return locators[selector];
			const value: any = {
				first: () => value,
				nth: () => value,
				filter: () => value,
				locator: (nested: string) => locator(nested),
				count: async () =>
					selector.includes("/saved/") ||
					selector.includes('a[href^="/"]') ||
					(detail &&
						(selector.includes("meta[") ||
							selector.includes("h1") ||
							selector.includes("time[datetime]"))) ||
					(!detail &&
						Boolean(options.postHref) &&
						selector.includes('a[href*="/p/"')) ||
					(!detail &&
						Boolean(options.postHref) &&
						selector.includes('a[href*="/reel/"'))
						? 1
						: 0,
				waitFor: async () => {},
				isVisible: async () => true,
				getAttribute: async () => {
					if (detail && selector.includes('meta[property="og:url"]'))
						return "https://www.instagram.com/100xengineers/reel/DeExZDCJJNj/";
					if (detail && selector.includes('meta[property="og:description"]'))
						return options.metadataPreview ?? "A metadata preview";
					if (detail && selector.includes("time[datetime]"))
						return options.publishedAt ?? "2026-10-07T12:00:00.000Z";
					if (detail && selector.includes('a[href^="/"]'))
						return "/100xengineers/";
					if (selector.includes("img")) {
						const handle = (options.profileHref ?? "/alice/")
							.split("/")
							.filter(Boolean)[0];
						return `${handle}'s profile picture`;
					}
					if (selector.includes("/saved/"))
						return "/alice/saved/ai/collection-id/";
					if (options.postHref && selector.includes('a[href*="/p/"'))
						return options.postHref;
					if (options.postHref && selector.includes('a[href*="/reel/"'))
						return options.postHref;
					return options.profileHref ?? "/alice/";
				},
				innerText: async () => {
					if (detail && selector.includes("h1"))
						return options.caption ?? "A real post caption";
					if (detail && selector.includes('a[href^="/"]'))
						return "100xengineers";
					return options.collectionText ?? "AI";
				},
				evaluate: async (_callback: unknown, author: string) => {
					if (selector.includes("img")) {
						const handle = (options.profileHref ?? "/alice/")
							.split("/")
							.filter(Boolean)[0];
						return {
							href: options.profileHref ?? "/alice/",
							alt: `${handle}'s profile picture`,
							outsideMain: true,
						};
					}
					return {
						comments:
							options.authorComments ?? (author ? ["An author comment"] : []),
						links: options.authorLinks ?? ["https://example.com/guide"],
					};
				},
				close: vi.fn(async () => {}),
			};
			locators[selector] = value;
			return value;
		};
		return {
			goto: vi.fn(async () => {}),
			getByRole: (_role: string, roleOptions: { name: string }) => {
				const link = locator('a[href*="/saved/"]');
				return {
					first: () => link,
					nth: () => link,
					count: async () =>
						(options.collectionText ?? "AI") === roleOptions.name ? 1 : 0,
				};
			},
			close: vi.fn(async () => {}),
			url: () =>
				detail
					? (options.postHref ??
						"https://www.instagram.com/100xengineers/reel/DeExZDCJJNj/")
					: "https://www.instagram.com/alice/saved/ai/collection-id/",
			locator,
		};
	};
	const page = makePage();
	const detailPage = makePage(true);
	const context = {
		addCookies: vi.fn(async () => {}),
		newPage: vi.fn().mockResolvedValueOnce(page).mockResolvedValue(detailPage),
	};
	const browser = {
		newContext: vi.fn(async () => context),
		close: vi.fn(async () => {}),
	};
	mocks.launch.mockResolvedValue(browser);
	return { browser, context, page };
}

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.getCookies.mockResolvedValue({
		cookies: [{ name: "sessionid", value: "secret" }],
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("Instagram standalone post DOM", () => {
	it("keeps date-only metadata dates in their displayed calendar date", () => {
		const previousTimezone = process.env.TZ;
		process.env.TZ = "Asia/Kolkata";
		try {
			expect(dateFromMetadata('Posted on September 30, 2026: "caption"')).toBe(
				"2026-09-30",
			);
		} finally {
			if (previousTimezone === undefined) delete process.env.TZ;
			else process.env.TZ = previousTimezone;
		}
	});

	it("attributes comments to the first commenter profile, not a mentioned creator", () => {
		document.body.innerHTML = `<main>
				<div><div><a href="/creator/">creator</a><time datetime="2026-09-30T12:09:11.000Z"></time></div><span>Caption text</span></div>
				<div class="row"><div><a href="/someone-else/">someone-else</a></div><span dir="auto">Nice work <a href="/creator/">@creator</a></span><a href="/p/short/c/1/"></a></div>
				<div class="row"><div><a href="/creator/">creator</a></div><span dir="auto">Thanks for reading</span><a href="/p/short/c/2/"></a></div>
			</main>`;
		expect(
			(
				new Function(
					`return (${readStandalonePostDom.toString()});`,
				)() as typeof readStandalonePostDom
			)({
				author: "creator",
				origin: "https://www.instagram.com",
			}),
		).toMatchObject({
			caption: "Caption text",
			publishedAt: "2026-09-30T12:09:11.000Z",
			comments: ["Thanks for reading"],
		});
	});
});

describe("syncInstagramCollection", () => {
	it("preserves full captured evidence when a refresh only returns a preview", async () => {
		makeBrowserHarness({
			postHref: "/100xengineers/reel/DeExZDCJJNj/",
			caption: "",
			publishedAt: "",
			metadataPreview: 'Posted on October 7, 2026: "A short preview"',
			authorComments: [],
			authorLinks: [],
		});
		mocks.getSaved.mockResolvedValue({
			author: "100xengineers",
			savedAt: "2026-09-01T08:30:00.000Z",
			metadata: {
				caption: "The full captured caption about local model retrieval",
				captionSource: "visible-caption-span",
				authorComments: ["Use this guide"],
				authorLinks: ["https://example.com/durable-guide"],
				publishedAt: "2026-10-07T12:34:56.000Z",
				publishedAtSource: "time-element",
			},
			contentHash: "old",
		});
		await syncInstagramCollection({ username: "alice", maxItems: 1 });
		expect(mocks.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				text: expect.stringContaining("The full captured caption"),
				metadata: expect.objectContaining({
					captionSource: "visible-caption-span",
					authorComments: ["Use this guide"],
					authorLinks: ["https://example.com/durable-guide"],
					publishedAt: "2026-10-07T12:34:56.000Z",
					publishedAtSource: "time-element",
				}),
			}),
		);
	});

	it("requires a Chrome Instagram session before opening Chrome", async () => {
		mocks.getCookies.mockResolvedValue({ cookies: [] });
		await expect(
			syncInstagramCollection({ username: "alice", maxItems: 5 }),
		).rejects.toThrow(/No Instagram session/);
		expect(mocks.launch).not.toHaveBeenCalled();
	});

	it("does not confuse a similarly named collection with the requested one", async () => {
		const { browser } = makeBrowserHarness({ collectionText: "AI Tools" });
		const error = syncInstagramCollection({
			username: "alice",
			collection: "AI",
			maxItems: 5,
		});
		await expect(error).rejects.toThrow(/visible “AI” saved collection/);
		expect(mocks.getCookies).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://www.instagram.com/",
				browsers: ["chrome"],
				names: ["sessionid", "ds_user_id", "csrftoken"],
			}),
		);
		expect(mocks.launch).toHaveBeenCalledWith({
			channel: "chrome",
			headless: false,
		});
		expect(browser.close).toHaveBeenCalledOnce();
	});

	it("rejects a mismatch against the signed-in profile link", async () => {
		const { browser } = makeBrowserHarness({
			profileHref: "/another-account/",
		});
		await expect(
			syncInstagramCollection({ username: "alice", maxItems: 5 }),
		).rejects.toThrow(/signed in to a different Instagram account/);
		expect(browser.close).toHaveBeenCalledOnce();
	});

	it("rejects usernames that could alter a locator or URL path", async () => {
		await expect(
			syncInstagramCollection({ username: 'alice"] a[href="/evil' }),
		).rejects.toThrow(/username/);
		expect(mocks.getCookies).not.toHaveBeenCalled();
	});

	it("hydrates author-prefixed reels and stores caption and author comments", async () => {
		makeBrowserHarness({ postHref: "/100xengineers/reel/DeExZDCJJNj/" });
		mocks.getSaved.mockResolvedValue(null);
		mocks.upsert.mockResolvedValue(undefined);
		const result = await syncInstagramCollection({
			username: "alice",
			maxItems: 1,
		});
		expect(result).toMatchObject({ count: 1, newCount: 1, partial: true });
		expect(mocks.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				externalId: "DeExZDCJJNj",
				url: "https://www.instagram.com/100xengineers/reel/DeExZDCJJNj/",
				author: "100xengineers",
				text: "A real post caption\n\nAn author comment",
				metadata: expect.objectContaining({
					caption: "A real post caption",
					captionSource: "visible-caption",
					authorComments: ["An author comment"],
					authorLinks: ["https://example.com/guide"],
					publishedAt: "2026-10-07T12:00:00.000Z",
				}),
			}),
		);
	});

	it("refreshes fetchedAt while preserving first-seen provenance", async () => {
		vi.useFakeTimers();
		const existing = {
			savedAt: "2026-09-04T10:00:00.000Z",
			metadata: { firstSeenAt: "2026-09-01T08:30:00.000Z" },
			contentHash: "old",
		};
		mocks.getSaved.mockResolvedValue(existing);
		mocks.upsert.mockResolvedValue(undefined);
		for (const fetchedAt of [
			"2026-10-07T12:00:00.000Z",
			"2026-10-08T12:00:00.000Z",
		]) {
			vi.setSystemTime(new Date(fetchedAt));
			makeBrowserHarness({ postHref: "/100xengineers/reel/DeExZDCJJNj/" });
			await syncInstagramCollection({ username: "alice", maxItems: 1 });
		}
		const first = mocks.upsert.mock.calls[0]?.[0];
		const second = mocks.upsert.mock.calls[1]?.[0];
		expect(first).toMatchObject({
			savedAt: existing.savedAt,
			fetchedAt: "2026-10-07T12:00:00.000Z",
			metadata: {
				firstSeenAt: "2026-09-01T08:30:00.000Z",
				savedAtSource: "first-seen",
			},
		});
		expect(second).toMatchObject({
			savedAt: existing.savedAt,
			fetchedAt: "2026-10-08T12:00:00.000Z",
			metadata: {
				firstSeenAt: "2026-09-01T08:30:00.000Z",
				savedAtSource: "first-seen",
			},
		});
	});
});

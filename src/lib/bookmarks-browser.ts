import { parseBrowserBookmarks } from "./bookmarks-parser";
export { parseBrowserBookmarks } from "./bookmarks-parser";
import { getCookies } from "@steipete/sweet-cookie";
import { Effect, Schedule } from "effect";
import type { Browser, Response } from "playwright";
import { getBirdclawConfig } from "./config";
import { tryPromise } from "./effect-runtime";
import { launchSavedBrowser } from "./saved-browser";
import type {
	XurlMentionData,
	XurlMentionsResponse,
	XurlMentionUser,
	XurlMediaItem,
} from "./types";

export interface BrowserBookmarkOptions {
	username: string;
	limit: number;
	all?: boolean;
	maxPages?: number;
	onPage?: (payload: XurlMentionsResponse) => void;
	isPageAlreadyLocal?: (payload: XurlMentionsResponse) => boolean;
}

function trySync<T>(try_: () => T) {
	return Effect.try({
		try: try_,
		catch: (cause) =>
			cause instanceof Error ? cause : new Error(String(cause)),
	});
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function string(value: unknown) {
	return typeof value === "string" ? value : "";
}
export function listBrowserBookmarksEffect(options: BrowserBookmarkOptions) {
	return Effect.gen(function* () {
		const cookies = yield* tryPromise(() =>
			getCookies({
				url: "https://x.com/",
				browsers: ["chrome"],
				chromiumBrowser: "chrome",
				mode: "first",
				chromeProfile:
					process.env.BIRDCLAW_CHROME_PROFILE ??
					getBirdclawConfig().bookmarks?.chromeProfile,
				names: ["auth_token", "ct0"],
				timeoutMs: 30_000,
			}),
		);
		if (!cookies.cookies.some((cookie) => cookie.name === "auth_token")) {
			return yield* Effect.fail(
				new Error(
					"No X session found in Chrome. Sign in to X in Chrome or set BIRDCLAW_CHROME_PROFILE.",
				),
			);
		}
		return yield* Effect.acquireUseRelease(
			tryPromise(launchSavedBrowser),
			(browser) => collectBookmarksEffect(browser, cookies.cookies, options),
			(browser) => tryPromise(() => browser.close()).pipe(Effect.orDie),
		);
	});
}

function collectBookmarksEffect(
	browser: Browser,
	cookies: Awaited<ReturnType<typeof getCookies>>["cookies"],
	options: BrowserBookmarkOptions,
) {
	return Effect.gen(function* () {
		const context = yield* tryPromise(() => browser.newContext());
		yield* tryPromise(() =>
			context.addCookies(
				cookies.map((cookie) => ({
					name: cookie.name,
					value: cookie.value,
					domain: ".x.com",
					path: "/",
					secure: true,
					httpOnly: cookie.httpOnly ?? false,
				})),
			),
		);
		const page = yield* tryPromise(() => context.newPage());
		const isBookmarkResponse = (response: Response) =>
			new URL(response.url()).hostname === "x.com" &&
			/\/graphql\/[^/]+\/Bookmarks(?:\?|$)/.test(response.url());
		const responses: Response[] = [];
		page.on("response", (response) => {
			if (isBookmarkResponse(response)) responses.push(response);
		});
		const firstResponse = page.waitForResponse(isBookmarkResponse, {
			timeout: 30_000,
		});
		// Attach rejection handling immediately if navigation fails before a response.
		void firstResponse.catch(() => undefined);
		yield* tryPromise(() =>
			page.goto("https://x.com/i/bookmarks", { waitUntil: "domcontentloaded" }),
		);
		const profileLink = page.locator('a[data-testid="AppTabBar_Profile_Link"]');
		yield* tryPromise(() => profileLink.waitFor({ timeout: 30_000 }));
		const profile = yield* tryPromise(() => profileLink.getAttribute("href"));
		if (
			profile?.replace(/^\//, "").toLowerCase() !==
			options.username.toLowerCase()
		) {
			return yield* Effect.fail(
				new Error(
					`Chrome is signed in as ${profile ?? "an unknown account"}, expected @${options.username}. Select the matching Birdclaw account or Chrome profile.`,
				),
			);
		}
		yield* tryPromise(() =>
			page.locator('[data-testid="primaryColumn"]').hover(),
		);
		let response = yield* tryPromise(() => firstResponse);
		responses.splice(responses.indexOf(response), 1);
		const tweets = new Map<string, XurlMentionData>();
		const users = new Map<string, XurlMentionUser>();
		const media = new Map<string, XurlMediaItem>();
		const contextTweets = new Map<string, XurlMentionData>();
		const seenCursors = new Set<string>();
		let cursor: string | null = null;
		let pages = 0;
		const warnings: string[] = [];
		let saturatedAtPage: number | undefined;
		const maxPages = options.maxPages ?? (options.all ? 250 : 1);
		while (pages < maxPages) {
			if (!response.ok()) {
				if (pages === 0)
					return yield* Effect.fail(
						new Error(`X bookmark page request failed: ${response.status()}`),
					);
				warnings.push(
					`X stopped paging with HTTP ${response.status()}; imported the pages already received.`,
				);
				break;
			}
			const parsedPage = yield* tryPromise(() => response.json()).pipe(
				Effect.timeoutFail({
					duration: "30 seconds",
					onTimeout: () => new Error("X bookmark response body timed out"),
				}),
				Effect.flatMap((raw) => trySync(() => parseBrowserBookmarks(raw))),
				Effect.map((value) => ({ ok: true as const, value })),
				Effect.catchAll((error) =>
					Effect.succeed({ ok: false as const, error }),
				),
			);
			if (!parsedPage.ok) {
				if (pages === 0) return yield* Effect.fail(parsedPage.error);
				warnings.push(
					`Stopped reading X bookmarks: ${parsedPage.error instanceof Error ? parsedPage.error.message : String(parsedPage.error)}; imported the pages already received.`,
				);
				break;
			}
			const payload = parsedPage.value;
			if (
				payload.data.length > 0 &&
				payload.data.every((tweet) => tweets.has(tweet.id))
			) {
				warnings.push(
					"X repeated a bookmark page; imported the distinct pages already received.",
				);
				break;
			}
			const alreadyLocal = yield* trySync(
				() => options.isPageAlreadyLocal?.(payload) ?? false,
			);
			yield* trySync(() =>
				options.onPage?.(
					!options.all && options.maxPages === undefined
						? { ...payload, data: payload.data.slice(0, options.limit) }
						: payload,
				),
			).pipe(
				Effect.retry({
					times: 3,
					schedule: Schedule.spaced("250 millis"),
					while: (error) => {
						const code = record(error).errcode;
						return typeof code === "number" && [5, 6].includes(code & 255);
					},
				}),
			);
			pages += 1;
			for (const tweet of payload.data) tweets.set(tweet.id, tweet);
			for (const tweet of payload.includes?.tweets ?? [])
				contextTweets.set(tweet.id, tweet);
			for (const user of payload.includes?.users ?? [])
				users.set(user.id, user);
			for (const item of payload.includes?.media ?? [])
				media.set(item.media_key, item);
			cursor = string(payload.meta?.next_token) || null;
			if (alreadyLocal) {
				saturatedAtPage = pages;
				break;
			}
			if (!cursor || payload.data.length === 0 || seenCursors.has(cursor))
				break;
			seenCursors.add(cursor);
			if ((!options.all && options.maxPages === undefined) || pages >= maxPages)
				break;
			yield* Effect.sleep("1500 millis");
			for (
				let scrolls = 0;
				scrolls < 50 && responses.length === 0;
				scrolls += 1
			) {
				yield* tryPromise(() => page.mouse.wheel(0, 1800));
				yield* Effect.sleep("500 millis");
			}
			const next = responses.shift();
			if (!next) {
				warnings.push(
					"X did not load another bookmark page after scrolling; imported the pages already received.",
				);
				break;
			}
			response = next;
		}
		const data = [...tweets.values()];
		return {
			data:
				options.all || options.maxPages !== undefined
					? data
					: data.slice(0, options.limit),
			includes: {
				users: [...users.values()],
				media: [...media.values()],
				tweets: [...contextTweets.values()],
			},
			meta: {
				result_count: tweets.size,
				page_count: pages,
				next_token: cursor,
				partial: Boolean(cursor) || warnings.length > 0,
				warnings,
				...(saturatedAtPage ? { saturated_at_page: saturatedAtPage } : {}),
			},
		} satisfies XurlMentionsResponse;
	});
}

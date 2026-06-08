import type { Database } from "./sqlite";
import { Effect } from "effect";
import {
	listBookmarkedTweetsViaBirdEffect,
	listLikedTweetsViaBirdEffect,
} from "./bird";
import { getNativeDb } from "./db";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import { buildMediaJsonFromIncludes, countTweetMedia } from "./media-includes";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import { lookupTweetsByIdsEffect, type TweetLookupMode } from "./tweet-lookup";

export type { TweetLookupMode };
import type {
	XurlMentionData,
	XurlMentionsResponse,
	XurlMediaItem,
	XurlMentionUser,
	XurlReferencedTweet,
	XurlTweetData,
} from "./types";
import { ensureStubProfileForXUser, upsertProfileFromXUser } from "./x-profile";
import {
	listBookmarkedTweetsViaXurl,
	listLikedTweetsViaXurl,
	lookupUsersByHandles,
} from "./xurl";

export type TimelineCollectionKind = "likes" | "bookmarks";
export type TimelineCollectionMode = "auto" | "xurl" | "bird";
export interface SyncTimelineCollectionOptions {
	kind: TimelineCollectionKind;
	account?: string;
	mode?: TimelineCollectionMode;
	limit?: number;
	all?: boolean;
	maxPages?: number;
	refresh?: boolean;
	cacheTtlMs?: number;
	earlyStop?: boolean;
}

const DEFAULT_COLLECTION_CACHE_TTL_MS = 2 * 60_000;
const DEFAULT_EARLY_STOP_MAX_PAGES = 10;
const MIN_XURL_LIMIT = 5;
const MAX_XURL_LIMIT = 100;

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function trySync<T>(try_: () => T) {
	return Effect.try({
		try: try_,
		catch: toError,
	});
}

function parseCacheTtlMs(value?: number) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return DEFAULT_COLLECTION_CACHE_TTL_MS;
	}
	return Math.floor(value);
}

function parseMaxPages(value?: number) {
	if (value === undefined) {
		return null;
	}
	if (!Number.isFinite(value) || value < 1) {
		throw new Error("--max-pages must be at least 1");
	}
	return Math.floor(value);
}

function assertLimit(limit: number) {
	if (!Number.isFinite(limit) || limit < 1) {
		throw new Error("--limit must be at least 1");
	}
}

function assertXurlLimit(limit: number) {
	if (limit < MIN_XURL_LIMIT || limit > MAX_XURL_LIMIT) {
		throw new Error("xurl mode requires --limit between 5 and 100");
	}
}

function resolveAccount(db: Database, accountId?: string) {
	const row = accountId
		? (db
				.prepare(
					"select id, handle, external_user_id from accounts where id = ?",
				)
				.get(accountId) as
				| { id: string; handle: string; external_user_id: string | null }
				| undefined)
		: (db
				.prepare(
					`
          select id, handle, external_user_id
          from accounts
          order by is_default desc, created_at asc
          limit 1
          `,
				)
				.get() as
				| { id: string; handle: string; external_user_id: string | null }
				| undefined);

	if (!row) {
		throw new Error(`Unknown account: ${accountId ?? "default"}`);
	}

	return {
		accountId: row.id,
		username: row.handle.replace(/^@/, ""),
		externalUserId:
			typeof row.external_user_id === "string" &&
			row.external_user_id.length > 0
				? row.external_user_id
				: undefined,
	};
}

function replaceTweetFts(db: Database, tweetId: string, text: string) {
	db.prepare("delete from tweets_fts where tweet_id = ?").run(tweetId);
	db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
		tweetId,
		text,
	);
}

function getReferencedTweetId(
	tweet: { referenced_tweets?: XurlReferencedTweet[] },
	type: string,
) {
	return (
		tweet.referenced_tweets?.find((item) => item.type === type)?.id ?? null
	);
}

function mergePayloads(pages: XurlMentionsResponse[]): XurlMentionsResponse {
	const tweets: XurlMentionData[] = [];
	const seenTweetIds = new Set<string>();
	const users: XurlMentionUser[] = [];
	const seenUserIds = new Set<string>();
	const media: XurlMediaItem[] = [];
	const seenMediaKeys = new Set<string>();
	const referencedTweets: XurlTweetData[] = [];
	const seenReferencedTweetIds = new Set<string>();

	for (const page of pages) {
		for (const tweet of page.data) {
			if (seenTweetIds.has(tweet.id)) {
				continue;
			}
			seenTweetIds.add(tweet.id);
			tweets.push(tweet);
		}

		for (const user of page.includes?.users ?? []) {
			if (seenUserIds.has(user.id)) {
				continue;
			}
			seenUserIds.add(user.id);
			users.push(user);
		}

		for (const item of page.includes?.media ?? []) {
			if (seenMediaKeys.has(item.media_key)) {
				continue;
			}
			seenMediaKeys.add(item.media_key);
			media.push(item);
		}

		for (const tweet of page.includes?.tweets ?? []) {
			if (seenReferencedTweetIds.has(tweet.id)) {
				continue;
			}
			seenReferencedTweetIds.add(tweet.id);
			referencedTweets.push(tweet);
		}
	}

	const lastPage = pages.at(-1);
	const hasIncludes =
		users.length > 0 || media.length > 0 || referencedTweets.length > 0;
	const includes = {
		...(users.length > 0 ? { users } : {}),
		...(media.length > 0 ? { media } : {}),
		...(referencedTweets.length > 0 ? { tweets: referencedTweets } : {}),
	};
	return {
		data: tweets,
		includes: hasIncludes ? includes : undefined,
		meta: {
			result_count: tweets.length,
			page_count: pages.length,
			next_token: lastPage?.meta?.next_token ?? null,
			...(tweets[0] ? { newest_id: tweets[0].id } : {}),
			...(tweets.at(-1) ? { oldest_id: tweets.at(-1)?.id } : {}),
		},
	};
}

function getCollectionPageDedupe(
	db: Database,
	accountId: string,
	kind: TimelineCollectionKind,
	tweetIds: string[],
) {
	const uniqueTweetIds = [...new Set(tweetIds)];
	if (uniqueTweetIds.length === 0) {
		return { existingTweetIds: new Set<string>(), uniqueTweetCount: 0 };
	}

	const rows = db
		.prepare(
			`
      select tweet_id
      from tweet_collections
      where account_id = ?
        and kind = ?
        and tweet_id in (${uniqueTweetIds.map(() => "?").join(", ")})
      `,
		)
		.all(accountId, kind, ...uniqueTweetIds) as { tweet_id: string }[];
	return {
		existingTweetIds: new Set(rows.map((row) => row.tweet_id)),
		uniqueTweetCount: uniqueTweetIds.length,
	};
}

function filterExistingCollectionTweets(
	payload: XurlMentionsResponse,
	existingTweetIds: Set<string>,
) {
	if (existingTweetIds.size === 0) {
		return payload;
	}
	return {
		...payload,
		data: payload.data.filter((tweet) => !existingTweetIds.has(tweet.id)),
	};
}

function readSaturatedAtPage(payload: XurlMentionsResponse) {
	const value = payload.meta?.saturated_at_page;
	return typeof value === "number" ? value : undefined;
}

// Shared writer for indexed parent posts so the live sync and the backfill job persist
// reference tweets identically (kind `reference`, FTS row, never clobbering an existing
// row's collection state). See AGENTS.md §3.
function createReferenceParentWriter(db: Database) {
	const upsertReferenceTweet = db.prepare(
		`
    insert into tweets (
      id, account_id, author_profile_id, kind, text, created_at,
      is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
      entities_json, media_json, quoted_tweet_id
    ) values (?, ?, ?, 'reference', ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
    on conflict(id) do update set
      author_profile_id = excluded.author_profile_id,
      text = excluded.text,
      created_at = excluded.created_at,
      like_count = excluded.like_count,
      media_count = max(tweets.media_count, excluded.media_count),
      entities_json = excluded.entities_json,
      media_json = case
        when excluded.media_json not in ('', '[]', 'null') then excluded.media_json
        else tweets.media_json
      end,
      is_replied = max(tweets.is_replied, excluded.is_replied),
      reply_to_id = coalesce(excluded.reply_to_id, tweets.reply_to_id),
      quoted_tweet_id = coalesce(excluded.quoted_tweet_id, tweets.quoted_tweet_id),
      kind = tweets.kind,
      bookmarked = tweets.bookmarked,
      liked = tweets.liked
    `,
	);
	return (
		accountId: string,
		parent: XurlTweetData,
		usersById: Map<string, XurlMentionUser>,
		mediaItems?: XurlMediaItem[],
	) => {
		const parentAuthorId = parent.author_id;
		const author = parentAuthorId ? usersById.get(parentAuthorId) : undefined;
		const profile = author
			? upsertProfileFromXUser(db, author)
			: ensureStubProfileForXUser(db, parentAuthorId ?? `unknown_${parent.id}`);
		const parentReplyToId = getReferencedTweetId(parent, "replied_to");
		const parentQuotedId = getReferencedTweetId(parent, "quoted");
		upsertReferenceTweet.run(
			parent.id,
			accountId,
			profile.profile.id,
			parent.text,
			parent.created_at,
			parentReplyToId ? 1 : 0,
			parentReplyToId,
			Number(parent.public_metrics?.like_count ?? 0),
			countTweetMedia(parent),
			JSON.stringify(parent.entities ?? {}),
			buildMediaJsonFromIncludes(parent, mediaItems),
			parentQuotedId,
		);
		replaceTweetFts(db, parent.id, parent.text);
	};
}

function mergeTimelineCollectionIntoLocalStore(
	db: Database,
	accountId: string,
	kind: TimelineCollectionKind,
	payload: XurlMentionsResponse,
	source: "xurl" | "bird",
) {
	const usersById = new Map(
		(payload.includes?.users ?? []).map((user) => [user.id, user]),
	);
	const tweetKind = kind === "likes" ? "like" : "bookmark";
	const liked = kind === "likes" ? 1 : 0;
	const bookmarked = kind === "bookmarks" ? 1 : 0;
	const upsertTweet = db.prepare(
		`
    insert into tweets (
      id, account_id, author_profile_id, kind, text, created_at,
      is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
      entities_json, media_json, quoted_tweet_id
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      account_id = tweets.account_id,
      author_profile_id = excluded.author_profile_id,
      kind = case
        when tweets.kind in ('authored', 'home', 'mention') then tweets.kind
        else excluded.kind
      end,
      text = excluded.text,
      created_at = excluded.created_at,
      like_count = excluded.like_count,
      media_count = max(tweets.media_count, excluded.media_count),
      entities_json = excluded.entities_json,
      media_json = case
        when excluded.media_json not in ('', '[]', 'null') then excluded.media_json
        else tweets.media_json
      end,
      is_replied = max(tweets.is_replied, excluded.is_replied),
      reply_to_id = coalesce(excluded.reply_to_id, tweets.reply_to_id),
      quoted_tweet_id = coalesce(excluded.quoted_tweet_id, tweets.quoted_tweet_id),
      bookmarked = tweets.bookmarked,
      liked = tweets.liked
    `,
	);
	const upsertCollection = db.prepare(`
    insert into tweet_collections (
      account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
    ) values (?, ?, ?, null, ?, ?, ?)
    on conflict(account_id, tweet_id, kind) do update set
      source = excluded.source,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `);
	const writeReferenceParent = createReferenceParentWriter(db);
	const includedTweetsById = new Map(
		(payload.includes?.tweets ?? []).map((tweet) => [tweet.id, tweet]),
	);

	// Persist the bookmark's single immediate quoted/retweeted parent (AGENTS.md §2).
	// Mid-thread replies are intentionally not parent-indexed, and we never walk the
	// parent's own references (no full-thread walk).
	function persistReferenceParent(tweet: XurlMentionData) {
		const parentId =
			getReferencedTweetId(tweet, "retweeted") ??
			getReferencedTweetId(tweet, "quoted");
		if (!parentId || parentId === tweet.id) {
			return;
		}
		const parent = includedTweetsById.get(parentId);
		if (!parent) {
			return;
		}
		writeReferenceParent(accountId, parent, usersById, payload.includes?.media);
	}

	db.transaction(() => {
		const updatedAt = new Date().toISOString();
		for (const tweet of payload.data) {
			const author =
				usersById.get(tweet.author_id) ??
				({
					id: tweet.author_id,
					username: `user_${tweet.author_id}`,
					name: `user_${tweet.author_id}`,
				} as const);
			const profile = usersById.has(tweet.author_id)
				? upsertProfileFromXUser(db, author)
				: ensureStubProfileForXUser(db, tweet.author_id);
			const replyToId = getReferencedTweetId(tweet, "replied_to");
			const quotedTweetId = getReferencedTweetId(tweet, "quoted");
			upsertTweet.run(
				tweet.id,
				accountId,
				profile.profile.id,
				tweetKind,
				tweet.text,
				tweet.created_at,
				replyToId ? 1 : 0,
				replyToId,
				Number(tweet.public_metrics?.like_count ?? 0),
				countTweetMedia(tweet),
				bookmarked,
				liked,
				JSON.stringify(tweet.entities ?? {}),
				buildMediaJsonFromIncludes(tweet, payload.includes?.media),
				quotedTweetId,
			);
			upsertCollection.run(
				accountId,
				tweet.id,
				kind,
				source,
				JSON.stringify(tweet),
				updatedAt,
			);
			replaceTweetFts(db, tweet.id, tweet.text);
			if (kind === "bookmarks") {
				persistReferenceParent(tweet);
			}
		}
	})();
}

function fetchXurlCollectionEffect({
	db,
	kind,
	accountId,
	username,
	userId,
	limit,
	all,
	maxPages,
	earlyStop,
}: {
	db: Database;
	kind: TimelineCollectionKind;
	accountId: string;
	username: string;
	userId?: string;
	limit: number;
	all: boolean;
	maxPages: number | null;
	earlyStop: boolean;
}) {
	return Effect.gen(function* () {
		let resolvedUserId = userId;
		if (!resolvedUserId) {
			const [accountUser] = yield* tryPromise(() =>
				lookupUsersByHandles([username]),
			);
			if (!accountUser?.id) {
				return yield* Effect.fail(
					new Error(`Could not resolve Twitter user id for @${username}`),
				);
			}
			resolvedUserId = String(accountUser.id);
		}

		const pages: XurlMentionsResponse[] = [];
		let nextToken: string | undefined;
		let pageCount = 0;
		let saturatedAtPage: number | undefined;
		do {
			const payload = yield* tryPromise(() =>
				kind === "likes"
					? listLikedTweetsViaXurl({
							maxResults: limit,
							username,
							userId: resolvedUserId,
							paginationToken: nextToken,
						})
					: listBookmarkedTweetsViaXurl({
							maxResults: limit,
							username,
							userId: resolvedUserId,
							isPaginatedWalk: all,
							paginationToken: nextToken,
						}),
			);
			pageCount += 1;
			if (earlyStop) {
				const tweetIds = payload.data.map((tweet) => tweet.id);
				const { existingTweetIds, uniqueTweetCount } = yield* trySync(() =>
					getCollectionPageDedupe(db, accountId, kind, tweetIds),
				);
				if (tweetIds.length > 0 && existingTweetIds.size === uniqueTweetCount) {
					saturatedAtPage = pageCount;
					console.error(
						`${kind} saturated at page ${pageCount} (100% existing rows)`,
					);
					break;
				}
				pages.push(filterExistingCollectionTweets(payload, existingTweetIds));
			} else {
				pages.push(payload);
			}
			nextToken =
				typeof payload.meta?.next_token === "string"
					? payload.meta.next_token
					: undefined;
		} while (
			(all || earlyStop) &&
			nextToken &&
			(maxPages === null || pageCount < maxPages)
		);

		const merged = mergePayloads(pages);
		// A saturated page may expose another token, but our walk is complete.
		const saturationMeta =
			saturatedAtPage === undefined
				? {}
				: { saturated_at_page: saturatedAtPage, next_token: null };
		merged.meta = {
			...merged.meta,
			page_count: pageCount,
			...saturationMeta,
		};
		return merged;
	});
}

function fetchBirdCollectionEffect({
	kind,
	limit,
	all,
	maxPages,
}: {
	kind: TimelineCollectionKind;
	limit: number;
	all: boolean;
	maxPages: number | null;
}) {
	return kind === "likes"
		? listLikedTweetsViaBirdEffect({
				maxResults: limit,
				all,
				maxPages: maxPages ?? undefined,
			})
		: listBookmarkedTweetsViaBirdEffect({
				maxResults: limit,
				all,
				maxPages: maxPages ?? undefined,
			});
}

export function syncTimelineCollectionEffect({
	kind,
	account,
	mode = "auto",
	limit = 20,
	all = false,
	maxPages,
	refresh = false,
	cacheTtlMs,
	earlyStop = false,
}: SyncTimelineCollectionOptions) {
	return Effect.gen(function* () {
		yield* trySync(() => assertLimit(limit));
		const parsedMaxPages = yield* trySync(() => parseMaxPages(maxPages));
		const shouldApplyEarlyStopCap =
			earlyStop && !all && parsedMaxPages === null && mode !== "bird";
		const xurlMaxPages = shouldApplyEarlyStopCap
			? DEFAULT_EARLY_STOP_MAX_PAGES
			: parsedMaxPages;
		if (mode === "xurl" || mode === "auto") {
			yield* trySync(() => assertXurlLimit(limit));
		}

		const db = yield* trySync(() => getNativeDb());
		const resolvedAccount = yield* trySync(() => resolveAccount(db, account));
		const cacheMaxPages = mode === "bird" ? parsedMaxPages : xurlMaxPages;
		const cacheKey = `${kind}:${mode}:${resolvedAccount.accountId}:${String(limit)}:${all ? "all" : "single"}:${cacheMaxPages === null ? "all-pages" : String(cacheMaxPages)}${earlyStop ? ":early-stop" : ""}`;
		const ttlMs = parseCacheTtlMs(cacheTtlMs);
		const cached = yield* trySync(() =>
			readSyncCache<XurlMentionsResponse>(cacheKey, db),
		);
		const cacheAgeMs = cached
			? Date.now() - new Date(cached.updatedAt).getTime()
			: Number.POSITIVE_INFINITY;

		if (!refresh && cached && cacheAgeMs <= ttlMs) {
			const saturatedAtPage = readSaturatedAtPage(cached.value);
			return {
				ok: true,
				source: "cache",
				kind,
				accountId: resolvedAccount.accountId,
				count: cached.value.data.length,
				payload: cached.value,
				...(saturatedAtPage === undefined
					? {}
					: { saturated_at_page: saturatedAtPage }),
			};
		}

		if (shouldApplyEarlyStopCap) {
			console.error(
				`${kind} early-stop capped at ${DEFAULT_EARLY_STOP_MAX_PAGES} pages by default; pass --max-pages or --all to override`,
			);
		}

		let source: "xurl" | "bird";
		let payload: XurlMentionsResponse;
		if (mode === "bird") {
			payload = yield* fetchBirdCollectionEffect({
				kind,
				limit,
				all,
				maxPages: parsedMaxPages,
			});
			source = "bird";
		} else {
			const xurlPayload = yield* fetchXurlCollectionEffect({
				db,
				kind,
				accountId: resolvedAccount.accountId,
				username: resolvedAccount.username,
				userId: resolvedAccount.externalUserId,
				limit,
				all,
				maxPages: xurlMaxPages,
				earlyStop,
			}).pipe(
				Effect.map((value) => ({ ok: true as const, value })),
				Effect.catchAll((error) => {
					if (mode === "xurl") {
						return Effect.fail(error);
					}
					return Effect.succeed({ ok: false as const });
				}),
			);
			if (xurlPayload.ok) {
				payload = xurlPayload.value;
				source = "xurl";
			} else {
				payload = yield* fetchBirdCollectionEffect({
					kind,
					limit,
					all,
					maxPages: parsedMaxPages,
				});
				source = "bird";
			}
		}

		yield* trySync(() =>
			mergeTimelineCollectionIntoLocalStore(
				db,
				resolvedAccount.accountId,
				kind,
				payload,
				source,
			),
		);
		yield* trySync(() => writeSyncCache(cacheKey, payload, db));
		const saturatedAtPage = readSaturatedAtPage(payload);

		return {
			ok: true,
			source,
			kind,
			accountId: resolvedAccount.accountId,
			count: payload.data.length,
			payload,
			...(saturatedAtPage === undefined
				? {}
				: { saturated_at_page: saturatedAtPage }),
		};
	});
}

export function syncTimelineCollection(options: SyncTimelineCollectionOptions) {
	return runEffectPromise(syncTimelineCollectionEffect(options));
}

const TWEET_LOOKUP_BATCH_SIZE = 100;

export interface BackfillBookmarkParentsOptions {
	mode?: TweetLookupMode;
	batchSize?: number;
	db?: Database;
}

export interface BackfillBookmarkParentsResult {
	scannedBookmarks: number;
	missingParents: number;
	fetched: number;
	persisted: number;
}

function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}

// Backfill indexed parents for bookmarks that were synced before parent indexing existed.
// The bookmarks API can no longer page back over the full history (pagination bug, see
// xurl.ts), so we resolve the missing parents by id from the referenced ids already stored
// on each bookmark and persist them via the same writer the live sync uses. Idempotent:
// reruns skip parents whose rows now exist.
export function backfillBookmarkReferenceParentsEffect({
	mode = "auto",
	batchSize = TWEET_LOOKUP_BATCH_SIZE,
	db,
}: BackfillBookmarkParentsOptions = {}): Effect.Effect<
	BackfillBookmarkParentsResult,
	unknown
> {
	return Effect.gen(function* () {
		const database = db ?? (yield* trySync(() => getNativeDb()));
		const effectiveBatchSize = Math.max(
			1,
			Math.min(TWEET_LOOKUP_BATCH_SIZE, Math.floor(batchSize)),
		);
		const rows = yield* trySync(
			() =>
				database
					.prepare(
						`
            select c.tweet_id, c.account_id, c.raw_json, t.quoted_tweet_id
            from tweet_collections c
            join tweets t on t.id = c.tweet_id
            where c.kind = 'bookmarks'
            `,
					)
					.all() as Array<{
					tweet_id: string;
					account_id: string;
					raw_json: string;
					quoted_tweet_id: string | null;
				}>,
		);

		// The "top" parent to index = the bookmark's immediate retweeted target, else its
		// quoted target (matching the live sync priority). Retweet ids live only in the
		// stored raw_json; quote ids are also mirrored on the quoted_tweet_id column.
		const parentAccountById = new Map<string, string>();
		for (const row of rows) {
			let referencedRetweetId: string | null = null;
			let referencedQuoteId: string | null = null;
			try {
				const raw = JSON.parse(row.raw_json) as {
					referenced_tweets?: XurlReferencedTweet[];
				};
				referencedRetweetId = getReferencedTweetId(raw, "retweeted");
				referencedQuoteId = getReferencedTweetId(raw, "quoted");
			} catch {
				// Malformed raw_json: fall back to the quoted_tweet_id column below.
			}
			const parentId =
				referencedRetweetId ?? referencedQuoteId ?? row.quoted_tweet_id;
			if (!parentId || parentId === row.tweet_id) {
				continue;
			}
			if (!parentAccountById.has(parentId)) {
				parentAccountById.set(parentId, row.account_id);
			}
		}

		const candidateIds = [...parentAccountById.keys()];
		const missingIds = yield* trySync(() =>
			candidateIds.filter(
				(id) => !database.prepare("select 1 from tweets where id = ?").get(id),
			),
		);

		const writeReferenceParent = createReferenceParentWriter(database);
		let fetched = 0;
		let persisted = 0;
		for (const ids of chunk(missingIds, effectiveBatchSize)) {
			const response = yield* lookupTweetsByIdsEffect(ids, mode);
			fetched += response.data.length;
			const usersById = new Map(
				(response.includes?.users ?? []).map((user) => [user.id, user]),
			);
			yield* trySync(() =>
				database.transaction(() => {
					for (const parent of response.data) {
						const accountId = parentAccountById.get(parent.id);
						if (!accountId) {
							continue;
						}
						writeReferenceParent(
							accountId,
							parent,
							usersById,
							response.includes?.media,
						);
						persisted += 1;
					}
				})(),
			);
		}

		return {
			scannedBookmarks: rows.length,
			missingParents: missingIds.length,
			fetched,
			persisted,
		};
	});
}

export function backfillBookmarkReferenceParents(
	options: BackfillBookmarkParentsOptions = {},
): Promise<BackfillBookmarkParentsResult> {
	return runEffectPromise(backfillBookmarkReferenceParentsEffect(options));
}

import type {
	XurlMentionData,
	XurlMentionsResponse,
	XurlMentionUser,
	XurlMediaItem,
} from "./types";

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function at(value: unknown, ...keys: string[]): unknown {
	return keys.reduce<unknown>((current, key) => record(current)[key], value);
}
function string(value: unknown) {
	return typeof value === "string" ? value : "";
}
function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export function parseBrowserBookmarks(value: unknown): XurlMentionsResponse {
	if (array(at(value, "errors")).length)
		throw new Error("X returned an error while loading bookmarks");
	const data = record(at(value, "data"));
	const timeline = at(
		data.bookmark_timeline_v2 ?? data.bookmark_timeline,
		"timeline",
	);
	if (!Array.isArray(at(timeline, "instructions"))) {
		throw new Error(
			"X bookmark response format changed: missing timeline instructions",
		);
	}
	const tweets = new Map<string, XurlMentionData>();
	const users = new Map<string, XurlMentionUser>();
	const media = new Map<string, XurlMediaItem>();
	const contextTweets = new Map<string, XurlMentionData>();
	function addTweet(rawResult: unknown, bookmarked: boolean, depth = 0) {
		const result = record(rawResult);
		const tweet = record(result.tweet ?? result);
		const legacy = record(tweet.legacy);
		const id = string(tweet.rest_id ?? legacy.id_str);
		const author = record(at(tweet, "core", "user_results", "result"));
		const authorLegacy = record(author.legacy);
		const authorCore = record(author.core);
		const authorId = string(author.rest_id ?? legacy.user_id_str);
		const username = string(authorCore.screen_name ?? authorLegacy.screen_name);
		const createdAt = new Date(string(legacy.created_at));
		if (
			!id ||
			!authorId ||
			!username ||
			!Number.isFinite(createdAt.getTime())
		) {
			if (id && bookmarked)
				throw new Error(`Incomplete X bookmark data for post ${id}`);
			return;
		}
		users.set(authorId, {
			id: authorId,
			username,
			name: string(authorCore.name ?? authorLegacy.name) || username,
			description: string(
				at(author, "profile_bio", "description") ?? authorLegacy.description,
			),
			profile_image_url: string(
				at(author, "avatar", "image_url") ??
					authorLegacy.profile_image_url_https,
			),
			public_metrics: {
				followers_count: Number(
					at(author, "relationship_counts", "followers") ??
						authorLegacy.followers_count ??
						0,
				),
				following_count: Number(
					at(author, "relationship_counts", "following") ??
						authorLegacy.friends_count ??
						0,
				),
			},
		});
		const mediaKeys: string[] = [];
		for (const raw of array(at(legacy, "extended_entities", "media"))) {
			const m = record(raw);
			const key = string(m.media_key);
			if (!key) continue;
			mediaKeys.push(key);
			media.set(key, {
				media_key: key,
				type: string(m.type),
				url: string(m.media_url_https),
				preview_image_url: string(m.media_url_https),
				variants: array(at(m, "video_info", "variants")).map((rawVariant) => {
					const variant = record(rawVariant);
					return {
						url: string(variant.url),
						content_type: string(variant.content_type),
						bit_rate: Number(variant.bitrate ?? 0),
					};
				}),
			});
		}
		const references: NonNullable<XurlMentionData["referenced_tweets"]> = [];
		if (legacy.in_reply_to_status_id_str)
			references.push({
				type: "replied_to",
				id: string(legacy.in_reply_to_status_id_str),
			});
		if (legacy.quoted_status_id_str)
			references.push({
				type: "quoted",
				id: string(legacy.quoted_status_id_str),
			});
		const note = at(
			tweet,
			"note_tweet",
			"note_tweet_results",
			"result",
			"text",
		);
		const article = record(at(tweet, "article", "article_results", "result"));
		const text = string(note ?? legacy.full_text);
		if (!text) {
			if (bookmarked) throw new Error(`Missing X bookmark text for post ${id}`);
			return;
		}
		(bookmarked ? tweets : contextTweets).set(id, {
			id,
			author_id: authorId,
			created_at: createdAt.toISOString(),
			text: [text, string(article.title), string(article.preview_text)]
				.filter(Boolean)
				.join("\n\n"),
			entities: record(legacy.entities),
			conversation_id: string(legacy.conversation_id_str) || id,
			attachments: { media_keys: mediaKeys },
			referenced_tweets: references,
			public_metrics: {
				like_count: Number(legacy.favorite_count ?? 0),
				reply_count: Number(legacy.reply_count ?? 0),
				retweet_count: Number(legacy.retweet_count ?? 0),
			},
		});
		if (depth < 3)
			addTweet(at(tweet, "quoted_status_result", "result"), false, depth + 1);
	}
	let cursor: string | null = null;
	for (const instruction of array(at(timeline, "instructions"))) {
		for (const entry of array(at(instruction, "entries"))) {
			const content = record(at(entry, "content"));
			if (content.cursorType === "Bottom")
				cursor = string(content.value) || null;
			const items = [
				content.itemContent,
				...array(content.items).map((item) => at(item, "item", "itemContent")),
			];
			for (const item of items) {
				addTweet(at(item, "tweet_results", "result"), true);
			}
		}
	}
	return {
		data: [...tweets.values()],
		includes: {
			users: [...users.values()],
			media: [...media.values()],
			tweets: [...contextTweets.values()],
		},
		meta: { result_count: tweets.size, next_token: cursor },
	};
}

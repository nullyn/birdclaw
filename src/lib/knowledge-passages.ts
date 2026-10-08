import { createHash } from "node:crypto";
import { getNativeDb } from "./db";

export interface KnowledgeDocument {
	id: string;
	source: "x" | "github" | "instagram";
	account: string;
	externalId: string;
	url: string;
	title: string;
	author: string;
	text: string;
	publishedAt: string | null;
	publishedAtSource: string | null;
	savedAt: string | null;
	savedAtSource: string | null;
	fetchedAt: string;
}

const CHUNKER_VERSION = "knowledge-passages-v1";
const MAX_PASSAGE_LENGTH = 1600;
const PASSAGE_OVERLAP = 200;

function nullableString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function metadataFromJson(value: unknown): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(String(value ?? "{}"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function documentId(source: string, account: string, externalId: string) {
	return JSON.stringify([source, account, externalId]);
}

export function loadKnowledgeDocuments(): KnowledgeDocument[] {
	const db = getNativeDb({ seedDemoData: false });
	const bookmarks = db
		.prepare(
			`select c.account_id, c.tweet_id, c.collected_at, c.updated_at,
			        t.text, t.created_at, t.quoted_tweet_id,
			        p.handle, p.display_name, q.text as quoted_text
			 from tweet_collections c
			 join tweets t on t.id = c.tweet_id
			 left join profiles p on p.id = t.author_profile_id
			 left join tweets q on q.id = t.quoted_tweet_id
			 where c.kind = 'bookmarks'
			 order by c.account_id, c.collected_at, c.tweet_id`,
		)
		.all() as Record<string, unknown>[];
	const savedResources = db
		.prepare(
			"select * from saved_resources where source in ('github', 'instagram') order by source, account, saved_at, external_id",
		)
		.all() as Record<string, unknown>[];

	const documents: KnowledgeDocument[] = bookmarks.map((row) => {
		const account = String(row.account_id);
		const externalId = String(row.tweet_id);
		const handle = String(row.handle ?? "").replace(/^@/, "");
		const parts = [String(row.text ?? "")];
		if (typeof row.quoted_text === "string" && row.quoted_text.length > 0) {
			parts.push(`Quoted post: ${row.quoted_text}`);
		}
		return {
			id: documentId("x", account, externalId),
			source: "x",
			account,
			externalId,
			url: handle
				? `https://x.com/${handle}/status/${externalId}`
				: `https://x.com/i/web/status/${externalId}`,
			title: String(row.text ?? "").slice(0, 180),
			author: String(row.display_name || (handle ? `@${handle}` : "")),
			text: parts.filter(Boolean).join("\n\n"),
			publishedAt: nullableString(row.created_at),
			publishedAtSource: row.created_at ? "tweet.created_at" : null,
			savedAt: nullableString(row.collected_at),
			savedAtSource: row.collected_at ? "tweet_collections.collected_at" : null,
			fetchedAt: String(row.updated_at ?? ""),
		};
	});

	for (const row of savedResources) {
		const source = String(row.source) as "github" | "instagram";
		const account = String(row.account);
		const externalId = String(row.external_id);
		const metadata = metadataFromJson(row.metadata_json);
		const githubStarredAt =
			source === "github" ? nullableString(metadata.starredAt) : null;
		const savedAt =
			githubStarredAt ??
			nullableString(row.saved_at) ??
			(source === "instagram" ? nullableString(metadata.firstSeenAt) : null);
		const savedAtSource =
			source === "github"
				? savedAt
					? "starred-at"
					: null
				: (nullableString(metadata.savedAtSource) ??
					(row.saved_at ? "saved_resources.saved_at" : null));
		const publishedAt = nullableString(metadata.publishedAt);
		documents.push({
			id: documentId(source, account, externalId),
			source,
			account,
			externalId,
			url: String(row.url),
			title: String(row.title),
			author: String(row.author),
			text: String(row.text),
			publishedAt,
			publishedAtSource: publishedAt
				? nullableString(metadata.publishedAtSource)
				: null,
			savedAt,
			savedAtSource,
			fetchedAt: String(row.fetched_at),
		});
	}
	return documents;
}

export function splitKnowledgePassages(
	text: string,
): { text: string; start: number; end: number }[] {
	if (!text.trim()) return [];
	if (text.length <= MAX_PASSAGE_LENGTH) {
		return [{ text, start: 0, end: text.length }];
	}
	const passages: { text: string; start: number; end: number }[] = [];
	let start = 0;
	while (start < text.length) {
		let end = Math.min(start + MAX_PASSAGE_LENGTH, text.length);
		if (end < text.length) {
			const boundary = text.lastIndexOf(" ", end);
			const newlineBoundary = text.lastIndexOf("\n", end);
			const preferred = Math.max(boundary, newlineBoundary);
			if (preferred > start + Math.floor(MAX_PASSAGE_LENGTH / 2))
				end = preferred;
		}
		passages.push({ text: text.slice(start, end), start, end });
		if (end === text.length) break;
		const nextStart = Math.max(start + 1, end - PASSAGE_OVERLAP);
		start = nextStart;
	}
	return passages;
}

export function knowledgeContentHash(document: KnowledgeDocument): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				CHUNKER_VERSION,
				document.source,
				document.id,
				document.title,
				document.author,
				document.text,
			]),
		)
		.digest("hex");
}

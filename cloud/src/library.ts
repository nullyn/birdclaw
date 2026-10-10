import { createHash } from "node:crypto";
import {
	knowledgeContentHash,
	splitKnowledgePassages,
	type KnowledgeDocument,
} from "../../src/lib/knowledge-document";
import type { Env } from "./env";

export const MODEL = "@cf/google/embeddinggemma-300m";
export const DIMENSIONS = 512;
export const SIGNATURE = `${MODEL}:${DIMENSIONS}:retrieval-v1`;
export type Document = KnowledgeDocument & {
	metadata?: Record<string, unknown>;
	firstSeenAt?: string;
};
export function retrievalText(doc: Document) {
	const enrichment = doc.metadata?.enrichment as
		| { summary?: unknown; keywords?: unknown }
		| undefined;
	const summary =
		typeof enrichment?.summary === "string" ? enrichment.summary : "";
	const keywords = Array.isArray(enrichment?.keywords)
		? enrichment.keywords.filter(
				(value): value is string => typeof value === "string",
			)
		: [];
	return [
		doc.text,
		summary ? `Inferred summary: ${summary}` : "",
		keywords.length ? `Keywords: ${keywords.join(", ")}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
}
export function vector512(vector: number[]) {
	if (vector.length < DIMENSIONS || !vector.every(Number.isFinite))
		throw new Error("Invalid embedding response");
	const result = vector.slice(0, DIMENSIONS);
	const norm = Math.hypot(...result);
	if (!norm) throw new Error("Zero embedding vector");
	return result.map((value) => value / norm);
}
export async function embed(env: Env, text: string[]) {
	const result = (await env.AI.run(MODEL, { text })) as { data: number[][] };
	if (result.data?.length !== text.length)
		throw new Error("Embedding response count differs");
	return result.data.map(vector512);
}
export async function readDocument(
	env: Env,
	id: string,
): Promise<Document | null> {
	const row = await env.DB.prepare(
		"SELECT document_json,text,first_seen_at FROM documents WHERE id=?",
	)
		.bind(id)
		.first<{ document_json: string; text: string; first_seen_at: string }>();
	return row
		? {
				...JSON.parse(row.document_json),
				text: row.text,
				firstSeenAt: row.first_seen_at,
			}
		: null;
}
export async function storeDocument(env: Env, incoming: Document) {
	const previous = await env.DB.prepare(
		"SELECT document_json,text,content_hash,first_seen_at FROM documents WHERE id=?",
	)
		.bind(incoming.id)
		.first<{
			document_json: string;
			text: string;
			content_hash: string;
			first_seen_at: string;
		}>();
	const old = previous
		? (JSON.parse(previous.document_json) as Document)
		: null;
	const firstSeenSource = (value: string | null) =>
		/first[-_ ]?seen|collected_at|saved_resources\.saved_at/i.test(value ?? "");
	const preferIncomingSave = Boolean(
		incoming.savedAt &&
		(!old?.savedAt ||
			(firstSeenSource(old.savedAtSource) &&
				incoming.savedAtSource &&
				!firstSeenSource(incoming.savedAtSource))),
	);
	const savedAt = preferIncomingSave
		? incoming.savedAt
		: (old?.savedAt ?? incoming.savedAt);
	const savedAtSource = preferIncomingSave
		? incoming.savedAtSource
		: (old?.savedAtSource ?? incoming.savedAtSource);
	if (old && old.fetchedAt > incoming.fetchedAt) {
		const proposed = incoming.metadata?.enrichment as
			| { generatedAt?: string }
			| undefined;
		const current = old.metadata?.enrichment as
			| { generatedAt?: string }
			| undefined;
		if (
			proposed?.generatedAt &&
			proposed.generatedAt > (current?.generatedAt ?? "")
		) {
			incoming = {
				...old,
				text: previous!.text,
				metadata: { ...old.metadata, enrichment: proposed },
			};
		} else {
			if (savedAt !== old.savedAt || savedAtSource !== old.savedAtSource)
				await env.DB.prepare("UPDATE documents SET document_json=? WHERE id=?")
					.bind(JSON.stringify({ ...old, savedAt, savedAtSource }), incoming.id)
					.run();
			return { added: false, changed: false };
		}
	}
	const doc = {
		...incoming,
		metadata: { ...old?.metadata, ...incoming.metadata },
		savedAt,
		savedAtSource,
	};
	const indexedText = retrievalText(doc);
	const hash = knowledgeContentHash({ ...doc, text: indexedText });
	const { text, ...metadata } = doc;
	const firstSeen = previous?.first_seen_at ?? incoming.fetchedAt;
	const save =
		env.DB.prepare(`INSERT INTO documents(id,source,account,text,document_json,content_hash,first_seen_at,fetched_at) VALUES(?,?,?,?,?,?,?,?)
	 ON CONFLICT(id) DO UPDATE SET text=excluded.text,document_json=excluded.document_json,content_hash=excluded.content_hash,fetched_at=excluded.fetched_at`).bind(
			doc.id,
			doc.source,
			doc.account,
			text,
			JSON.stringify(metadata),
			hash,
			firstSeen,
			doc.fetchedAt,
		);
	if (previous?.content_hash === hash) {
		await save.run();
		return { added: false, changed: false };
	}
	const passages = splitKnowledgePassages(indexedText).map((p, ordinal) => ({
		id: createHash("sha256")
			.update(JSON.stringify([SIGNATURE, doc.id, ordinal]))
			.digest("hex"),
		ordinal,
		hash: createHash("sha256")
			.update(JSON.stringify([SIGNATURE, doc.title, p.text]))
			.digest("hex"),
		...p,
	}));
	await env.DB.batch([
		save,
		env.DB.prepare(
			"INSERT OR IGNORE INTO vector_tombstones SELECT id FROM passages WHERE document_id=? AND ordinal>=?",
		).bind(doc.id, passages.length),
		env.DB.prepare(
			"DELETE FROM passages WHERE document_id=? AND ordinal>=?",
		).bind(doc.id, passages.length),
		env.DB.prepare(
			"DELETE FROM vector_tombstones WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?))",
		).bind(JSON.stringify(passages)),
		env.DB.prepare(`INSERT INTO passages(id,document_id,ordinal,title,text,start_offset,end_offset,content_hash)
		 SELECT json_extract(value,'$.id'),?,json_extract(value,'$.ordinal'),?,json_extract(value,'$.text'),json_extract(value,'$.start'),json_extract(value,'$.end'),json_extract(value,'$.hash') FROM json_each(?) WHERE true
		 ON CONFLICT(id) DO UPDATE SET title=excluded.title,text=excluded.text,start_offset=excluded.start_offset,end_offset=excluded.end_offset,
		 indexed_hash=CASE WHEN passages.content_hash=excluded.content_hash THEN passages.indexed_hash ELSE NULL END,content_hash=excluded.content_hash`).bind(
			doc.id,
			doc.title,
			JSON.stringify(passages),
		),
	]);
	return { added: !previous, changed: true };
}
export async function indexBatch(env: Env) {
	const dead = await env.DB.prepare(
		"SELECT id FROM vector_tombstones LIMIT 20",
	).all<{ id: string }>();
	if (dead.results.length) {
		await env.VECTORS.deleteByIds(dead.results.map((r) => r.id));
		await env.DB.prepare(
			"DELETE FROM vector_tombstones WHERE id IN (SELECT value FROM json_each(?))",
		)
			.bind(JSON.stringify(dead.results.map((r) => r.id)))
			.run();
	}
	const rows = await env.DB.prepare(
		`SELECT p.id,p.title,p.text,p.content_hash,d.source,d.account FROM passages p JOIN documents d ON d.id=p.document_id WHERE p.indexed_hash IS NULL LIMIT 8`,
	).all<{
		id: string;
		title: string;
		text: string;
		content_hash: string;
		source: string;
		account: string;
	}>();
	if (!rows.results.length)
		return { count: 0, more: dead.results.length === 20 };
	const vectors = await embed(
		env,
		rows.results.map(
			(r) => `title: ${r.title.slice(0, 256) || "none"} | text: ${r.text}`,
		),
	);
	await env.VECTORS.upsert(
		rows.results.map((r, i) => ({
			id: r.id,
			values: vectors[i]!,
			metadata: {
				source: r.source,
				account: r.account,
				contentHash: r.content_hash,
				model: SIGNATURE,
			},
		})),
	);
	await env.DB.batch(
		rows.results.map((r) =>
			env.DB.prepare(
				"UPDATE passages SET indexed_hash=? WHERE id=? AND content_hash=?",
			).bind(r.content_hash, r.id, r.content_hash),
		),
	);
	return { count: rows.results.length, more: true };
}
export async function search(
	env: Env,
	query: string,
	options: {
		source?: string;
		account?: string;
		limit: number;
		mode: "hybrid" | "keyword" | "semantic";
	},
) {
	const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 20) ?? [];
	const filters = `${options.source ? " AND d.source=?" : ""}${options.account ? " AND d.account=?" : ""}`;
	const bindings = [
		...(options.source ? [options.source] : []),
		...(options.account ? [options.account] : []),
	];
	const ids = new Map<
		string,
		{ id: string; keyword: number; semantic: number; vectorHash?: string }
	>();
	const warnings: string[] = [];
	if (options.mode !== "semantic" && terms.length) {
		const keyword = await env.DB.prepare(
			`SELECT p.id FROM passages_fts JOIN passages p ON p.rowid=passages_fts.rowid JOIN documents d ON d.id=p.document_id WHERE passages_fts MATCH ?${filters} ORDER BY bm25(passages_fts,4,1) LIMIT 40`,
		)
			.bind(terms.map((t) => `"${t}"`).join(" OR "), ...bindings)
			.all<{ id: string }>();
		keyword.results.forEach((r, i) =>
			ids.set(r.id, { id: r.id, keyword: 1 / (60 + i + 1), semantic: 0 }),
		);
	}
	if (options.mode !== "keyword") {
		try {
			const [vector] = await embed(env, [
				`task: search result | query: ${query}`,
			]);
			const filter = {
				...(options.source ? { source: options.source } : {}),
				...(options.account ? { account: options.account } : {}),
			};
			const results = await env.VECTORS.query(vector!, {
				topK: 20,
				returnMetadata: "all",
				...(Object.keys(filter).length ? { filter } : {}),
			});
			results.matches.forEach((r, i) => {
				if (r.metadata?.model === SIGNATURE)
					ids.set(r.id, {
						id: r.id,
						keyword: ids.get(r.id)?.keyword ?? 0,
						semantic: 1 / (60 + i + 1),
						vectorHash: String(r.metadata.contentHash ?? ""),
					});
			});
		} catch {
			if (options.mode === "semantic")
				throw new Error("Semantic retrieval unavailable");
			warnings.push(
				"Semantic retrieval unavailable; returning keyword evidence",
			);
		}
	}
	const candidates = [...ids.values()];
	const rows = candidates.length
		? await env.DB.prepare(
				`SELECT p.*,d.document_json,d.first_seen_at FROM passages p JOIN documents d ON d.id=p.document_id WHERE p.id IN (SELECT value FROM json_each(?))${filters}`,
			)
				.bind(JSON.stringify(candidates.map((r) => r.id)), ...bindings)
				.all<Record<string, unknown>>()
		: { results: [] };
	const byId = new Map(rows.results.map((r) => [r.id, r]));
	const ranked = candidates
		.map((candidate) => {
			const row = byId.get(candidate.id);
			const valid =
				row &&
				row.indexed_hash === row.content_hash &&
				candidate.vectorHash === row.content_hash;
			return {
				id: candidate.id,
				score: candidate.keyword + (valid ? candidate.semantic : 0),
			};
		})
		.filter((r) => r.score > 0)
		.sort((a, b) => b.score - a.score);
	const perDocument = new Map<string, number>();
	const items = [];
	for (const rankedRow of ranked) {
		const row = byId.get(rankedRow.id);
		if (!row) continue;
		// Outdated Vectorize matches must not become evidence for new content.
		if (options.mode === "semantic" && row.indexed_hash !== row.content_hash)
			continue;
		const count = perDocument.get(String(row.document_id)) ?? 0;
		if (count >= 2) continue;
		perDocument.set(String(row.document_id), count + 1);
		items.push({
			...JSON.parse(String(row.document_json)),
			text: String(row.text),
			passageId: row.id,
			startOffset: row.start_offset,
			endOffset: row.end_offset,
			firstSeenAt: row.first_seen_at,
			score: rankedRow.score,
			semanticIndexed: row.indexed_hash === row.content_hash,
		});
		if (items.length >= options.limit) break;
	}
	const pending = await env.DB.prepare(
		"SELECT count(*) AS count FROM passages WHERE indexed_hash IS NULL",
	).first<{ count: number }>();
	const imports = Boolean(
		await env.DB.prepare("SELECT id FROM import_staging LIMIT 1").first(),
	);
	if (imports)
		warnings.push(
			"Captured imports are processing; search coverage is partial",
		);
	return {
		items,
		warnings,
		indexIncomplete: imports || (pending?.count ?? 0) > 0,
		importIncomplete: imports,
		embeddingModel: SIGNATURE,
	};
}

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { getNativeDb } from "./db";
import {
	knowledgeContentHash,
	loadKnowledgeDocuments,
	splitKnowledgePassages,
	type KnowledgeDocument,
} from "./knowledge-passages";
import {
	rerankKnowledgePassages,
	type KnowledgeRelevance,
} from "./knowledge-rerank";
import {
	documentEmbeddingText,
	embedTexts,
	queryEmbeddingText,
	resolveEmbeddingModel,
} from "./local-embeddings";
import { readSyncCache, writeSyncCache } from "./sync-cache";

interface IndexedDocument {
	id: string;
	content_hash: string;
}
interface PassageRow {
	id: string;
	document_id: string;
	ordinal: number;
	start_offset: number;
	end_offset: number;
	title: string;
	text: string;
	embedding_model: string;
	dimensions: number;
	embedding: Uint8Array;
	content_hash: string;
}

function digest(value: string) {
	return createHash("sha256").update(value).digest("hex");
}
function passageIdentity(
	documentId: string,
	ordinal: number,
	passage: { start: number; end: number; text: string },
) {
	return digest(
		JSON.stringify([
			documentId,
			ordinal,
			passage.start,
			passage.end,
			passage.text,
		]),
	);
}
function vectorBuffer(vector: number[]) {
	const buffer = Buffer.alloc(vector.length * 4);
	vector.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
	return buffer;
}
function cosine(vector: number[], data: Uint8Array, dimensions: number) {
	if (dimensions !== vector.length || data.byteLength !== dimensions * 4)
		throw new Error(
			"Embedding dimensions differ; rerun: nalanda index knowledge",
		);
	const buffer = Buffer.from(data);
	let value = 0;
	for (let i = 0; i < dimensions; i++)
		value += vector[i]! * buffer.readFloatLE(i * 4);
	if (!Number.isFinite(value))
		throw new Error("Invalid stored embedding; rebuild the knowledge index");
	return Math.max(-1, Math.min(1, value));
}
function transact(action: () => void) {
	const db = getNativeDb({ seedDemoData: false });
	db.exec("begin immediate");
	try {
		action();
		db.exec("commit");
	} catch (error) {
		db.exec("rollback");
		throw error;
	}
}

export async function indexKnowledge(
	options: {
		onProgress?: (progress: {
			completed: number;
			total: number;
			embeddedPassages: number;
		}) => void;
	} = {},
) {
	const db = getNativeDb({ seedDemoData: false });
	const owner = randomUUID();
	const now = Date.now();
	const lease = db
		.prepare(`insert into knowledge_index_lock(id, owner, expires_at) values(1, ?, ?)
		on conflict(id) do update set owner=excluded.owner, expires_at=excluded.expires_at
		where knowledge_index_lock.expires_at <= ? returning owner`)
		.get(owner, now + 300_000, now) as { owner: string } | undefined;
	if (!lease)
		throw new Error(
			"Knowledge indexing is already running. Wait for it to finish; an abandoned lease expires after five minutes.",
		);
	const renew = () => {
		const result = db
			.prepare(
				"update knowledge_index_lock set expires_at=? where id=1 and owner=? and expires_at > ?",
			)
			.run(Date.now() + 300_000, owner, Date.now());
		if (!result.changes)
			throw new Error("Knowledge index lease expired; rerun indexing");
	};
	try {
		const model = await resolveEmbeddingModel();
		const documents = loadKnowledgeDocuments();
		const existing = new Map(
			(
				db
					.prepare("select id, content_hash from knowledge_documents")
					.all() as unknown as IndexedDocument[]
			).map((item) => [item.id, item]),
		);
		let embeddedPassages = 0;
		let reusedDocuments = 0;
		let indexedDocuments = 0;
		let completed = 0;
		for (let offset = 0; offset < documents.length; offset += 16) {
			renew();
			const jobs = documents.slice(offset, offset + 16).map((document) => {
				const hash = knowledgeContentHash(document);
				const passages = splitKnowledgePassages(document.text);
				const stored = db
					.prepare(
						"select id, embedding_model from knowledge_passages where document_id=? order by ordinal",
					)
					.all(document.id) as { id: string; embedding_model: string }[];
				const reuse =
					existing.get(document.id)?.content_hash === hash &&
					stored.length === passages.length &&
					passages.every(
						(passage, ordinal) =>
							stored[ordinal]?.embedding_model === model.signature &&
							stored[ordinal]?.id ===
								passageIdentity(document.id, ordinal, passage),
					);
				return { document, hash, passages, reuse };
			});
			const inputs = jobs
				.filter((job) => !job.reuse)
				.flatMap((job) =>
					job.passages.map((passage) =>
						documentEmbeddingText(job.document.title, passage.text),
					),
				);
			const vectors: number[][] = [];
			for (let start = 0; start < inputs.length; start += 16) {
				renew();
				vectors.push(
					...(await embedTexts(model, inputs.slice(start, start + 16))),
				);
			}
			renew();
			let vectorIndex = 0;
			for (const { document, hash, passages, reuse } of jobs) {
				if (reuse) {
					db.prepare(
						"update knowledge_documents set document_json=? where id=?",
					).run(JSON.stringify(document), document.id);
					reusedDocuments++;
				} else {
					transact(() => {
						db.prepare("delete from knowledge_documents where id=?").run(
							document.id,
						);
						db.prepare(
							"insert into knowledge_documents(id, source, account, content_hash, document_json, indexed_at) values(?,?,?,?,?,?)",
						).run(
							document.id,
							document.source,
							document.account,
							hash,
							JSON.stringify(document),
							new Date().toISOString(),
						);
						const insert = db.prepare(
							"insert into knowledge_passages(id, document_id, ordinal, start_offset, end_offset, title, text, embedding_model, dimensions, embedding) values(?,?,?,?,?,?,?,?,?,?)",
						);
						passages.forEach((passage, ordinal) => {
							const vector = vectors[vectorIndex++]!;
							insert.run(
								passageIdentity(document.id, ordinal, passage),
								document.id,
								ordinal,
								passage.start,
								passage.end,
								document.title,
								passage.text,
								model.signature,
								vector.length,
								vectorBuffer(vector),
							);
						});
					});
					embeddedPassages += passages.length;
					indexedDocuments++;
				}
				completed++;
				options.onProgress?.({
					completed,
					total: documents.length,
					embeddedPassages,
				});
			}
		}
		renew();
		let removedDocuments = 0;
		const liveIds = new Set(documents.map((document) => document.id));
		transact(() => {
			for (const id of existing.keys())
				if (!liveIds.has(id)) {
					removedDocuments += Number(
						db.prepare("delete from knowledge_documents where id=?").run(id)
							.changes,
					);
				}
		});
		return {
			model: model.name,
			modelSignature: model.signature,
			documents: documents.length,
			indexedDocuments,
			reusedDocuments,
			embeddedPassages,
			removedDocuments,
			indexedAt: new Date().toISOString(),
		};
	} finally {
		db.prepare("delete from knowledge_index_lock where id=1 and owner=?").run(
			owner,
		);
	}
}

export interface KnowledgeSearchOptions {
	query: string;
	source?: "x" | "github" | "instagram";
	account?: string;
	limit?: number;
	mode?: "hybrid" | "semantic" | "keyword";
	rerank?: boolean;
}
export interface KnowledgeMatch {
	passageId: string;
	documentId: string;
	source: KnowledgeDocument["source"];
	account: string;
	externalId: string;
	url: string;
	title: string;
	author: string;
	text: string;
	startOffset: number;
	endOffset: number;
	publishedAt: string | null;
	publishedAtSource: string | null;
	savedAt: string | null;
	savedAtSource: string | null;
	fetchedAt: string;
	semanticSimilarity: number | null;
	hybridScore: number;
	relevance: KnowledgeRelevance | null;
}

export async function searchKnowledge(options: KnowledgeSearchOptions) {
	const query = options.query.trim();
	if (!query || query.length > 1000)
		throw new Error("Search query must contain 1–1000 characters");
	const limit = options.limit ?? 10;
	if (!Number.isInteger(limit) || limit < 1 || limit > 50)
		throw new Error("Search limit must be between 1 and 50");
	if (options.source && !["x", "github", "instagram"].includes(options.source))
		throw new Error("Unknown knowledge source");
	const mode = options.mode ?? "hybrid";
	if (!["hybrid", "semantic", "keyword"].includes(mode))
		throw new Error("Search mode must be hybrid, semantic, or keyword");
	const db = getNativeDb({ seedDemoData: false });
	const documents = loadKnowledgeDocuments().filter(
		(document) =>
			(!options.source || document.source === options.source) &&
			(!options.account || document.account === options.account),
	);
	const byId = new Map(documents.map((document) => [document.id, document]));
	const hashes = new Map(
		documents.map((document) => [document.id, knowledgeContentHash(document)]),
	);
	const expectedPassages = new Map(
		documents.map((document) => [
			document.id,
			new Set(
				splitKnowledgePassages(document.text).map((passage, ordinal) =>
					passageIdentity(document.id, ordinal, passage),
				),
			),
		]),
	);
	const model = mode === "keyword" ? null : await resolveEmbeddingModel();
	const filters: string[] = [];
	const params: string[] = [];
	if (options.source) {
		filters.push("d.source=?");
		params.push(options.source);
	}
	if (options.account) {
		filters.push("d.account=?");
		params.push(options.account);
	}
	if (model) {
		filters.push("p.embedding_model=?");
		params.push(model.signature);
	}
	const where = filters.length ? `where ${filters.join(" and ")}` : "";
	const rows = (
		db
			.prepare(
				`select p.*, d.content_hash from knowledge_passages p join knowledge_documents d on d.id=p.document_id ${where}`,
			)
			.all(...params) as unknown as PassageRow[]
	).filter(
		(row) =>
			hashes.get(row.document_id) === row.content_hash &&
			expectedPassages.get(row.document_id)?.has(row.id),
	);
	const passageCounts = new Map<string, number>();
	for (const row of rows)
		passageCounts.set(
			row.document_id,
			(passageCounts.get(row.document_id) ?? 0) + 1,
		);
	const indexedDocuments = documents.filter((document) => {
		const expected = expectedPassages.get(document.id)!.size;
		return expected > 0 && passageCounts.get(document.id) === expected;
	}).length;
	const searchableDocuments = documents.filter((document) =>
		document.text.trim(),
	).length;
	const warnings: string[] = [];
	if (indexedDocuments < searchableDocuments)
		warnings.push(
			`${searchableDocuments - indexedDocuments} documents are missing or outdated in this index. Run: nalanda index knowledge`,
		);
	const stats = {
		documents: documents.length,
		searchableDocuments,
		indexedDocuments,
		indexedPassages: rows.length,
		embeddingModel: model?.name ?? null,
		indexIncomplete: indexedDocuments < searchableDocuments,
	};
	if (!rows.length)
		return {
			query,
			mode,
			items: [] as KnowledgeMatch[],
			stats,
			reranking: {
				enabled: options.rerank !== false,
				complete: false,
				requests: 0,
				inputTokens: 0,
			},
			warnings,
		};
	const candidates = new Map<
		string,
		{ row: PassageRow; semanticSimilarity: number | null; hybridScore: number }
	>();
	const shortlistSize = Math.max(30, limit);
	const recallSize = shortlistSize * 4;
	if (model) {
		const key = `embedding:query:${digest(JSON.stringify([model.signature, query]))}`;
		const cached = z
			.array(z.number().finite())
			.min(1)
			.safeParse(readSyncCache<unknown>(key, db)?.value);
		const vector = cached.success
			? cached.data
			: (await embedTexts(model, [queryEmbeddingText(query)]))[0]!;
		if (!cached.success) writeSyncCache(key, vector, db);
		const semantic = rows
			.map((row) => ({
				row,
				similarity: cosine(vector, row.embedding, row.dimensions),
			}))
			.sort(
				(a, b) =>
					b.similarity - a.similarity || a.row.id.localeCompare(b.row.id),
			);
		for (const [rank, item] of semantic.slice(0, recallSize).entries())
			candidates.set(item.row.id, {
				row: item.row,
				semanticSimilarity: item.similarity,
				hybridScore: 1 / (60 + rank + 1),
			});
	}
	if (mode !== "semantic") {
		const stopwords = new Set(
			"a an the and or of to in on for with from by is are was were be been being i me my you your we our it its this that these those how what which who where when why can could would should do does did some any".split(
				" ",
			),
		);
		const terms = [...new Set(query.match(/[\p{L}\p{N}_]+/gu) ?? [])].filter(
			(term) => !stopwords.has(term.toLowerCase()),
		);
		if (terms.length) {
			const match = terms
				.slice(0, 64)
				.map((term) => `"${term}"`)
				.join(" OR ");
			const eligible = new Map(rows.map((row) => [row.id, row]));
			const keywordRows = db
				.prepare(
					`select p.id from knowledge_passages_fts join knowledge_passages p on p.rowid=knowledge_passages_fts.rowid join knowledge_documents d on d.id=p.document_id where knowledge_passages_fts match ? ${filters.length ? `and ${filters.join(" and ")}` : ""} order by bm25(knowledge_passages_fts), p.id`,
				)
				.all(match, ...params) as { id: string }[];
			const keyword = keywordRows
				.filter((row) => eligible.has(row.id))
				.slice(0, recallSize);
			for (const [rank, item] of keyword.entries()) {
				const candidate = candidates.get(item.id);
				if (candidate) candidate.hybridScore += 1 / (60 + rank + 1);
				else
					candidates.set(item.id, {
						row: eligible.get(item.id)!,
						semanticSimilarity: null,
						hybridScore: 1 / (60 + rank + 1),
					});
			}
		}
	}
	const ordered = [...candidates.values()].sort(
		(a, b) => b.hybridScore - a.hybridScore || a.row.id.localeCompare(b.row.id),
	);
	// Keep at most two passages per source record so a long README cannot consume the shortlist.
	const counts = new Map<string, number>();
	const shortlist = ordered
		.filter(({ row }) => {
			const count = counts.get(row.document_id) ?? 0;
			if (count >= 2) return false;
			counts.set(row.document_id, count + 1);
			return true;
		})
		.slice(0, shortlistSize);
	const enabled = options.rerank !== false;
	const ranking = enabled
		? await rerankKnowledgePassages(
				query,
				shortlist.map(({ row }) => {
					const document = byId.get(row.document_id)!;
					return {
						id: row.id,
						text: row.text,
						title: document.title,
						author: document.author,
						source: document.source,
					};
				}),
			)
		: {
				judgments: new Map<string, KnowledgeRelevance>(),
				complete: false,
				requests: 0,
				inputTokens: 0,
				warnings: [],
			};
	warnings.push(...ranking.warnings);
	if (ranking.complete)
		shortlist.sort(
			(a, b) =>
				ranking.judgments.get(b.row.id)!.score -
					ranking.judgments.get(a.row.id)!.score ||
				b.hybridScore - a.hybridScore,
		);
	const items: KnowledgeMatch[] = shortlist
		.slice(0, limit)
		.map(({ row, semanticSimilarity, hybridScore }) => {
			const document = byId.get(row.document_id)!;
			return {
				passageId: row.id,
				documentId: document.id,
				source: document.source,
				account: document.account,
				externalId: document.externalId,
				url: document.url,
				title: document.title,
				author: document.author,
				text: row.text,
				startOffset: row.start_offset,
				endOffset: row.end_offset,
				publishedAt: document.publishedAt,
				publishedAtSource: document.publishedAtSource,
				savedAt: document.savedAt,
				savedAtSource: document.savedAtSource,
				fetchedAt: document.fetchedAt,
				semanticSimilarity,
				hybridScore,
				relevance: ranking.judgments.get(row.id) ?? null,
			};
		});
	return {
		query,
		mode,
		items,
		stats,
		reranking: {
			enabled,
			complete: ranking.complete,
			requests: ranking.requests,
			inputTokens: ranking.inputTokens,
		},
		warnings,
	};
}

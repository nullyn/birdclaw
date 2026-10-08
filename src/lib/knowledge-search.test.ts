// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolveEmbeddingModel: vi.fn(async () => ({
		name: "test-model",
		signature: "test-model:digest-a",
	})),
	embedTexts: vi.fn(async (_model: unknown, texts: string[]) =>
		texts.map(() => [1, 0]),
	),
	rerankKnowledgePassages: vi.fn(
		async (_query: string, passages: { id: string }[]) => ({
			judgments: new Map(
				passages.map((passage, index) => [
					passage.id,
					{ score: 2 + (index % 3), confidence: 1 },
				]),
			),
			complete: true,
			requests: passages.length,
			inputTokens: 10,
			warnings: [] as string[],
		}),
	),
}));

vi.mock("./local-embeddings", () => ({
	resolveEmbeddingModel: mocks.resolveEmbeddingModel,
	embedTexts: mocks.embedTexts,
	documentEmbeddingText: (_title: string, text: string) => text,
	queryEmbeddingText: (query: string) => query,
}));
vi.mock("./knowledge-rerank", () => ({
	rerankKnowledgePassages: mocks.rerankKnowledgePassages,
}));

import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { indexKnowledge, searchKnowledge } from "./knowledge-search";

const tempDirs: string[] = [];

function setTestHome() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-knowledge-search-"));
	tempDirs.push(dir);
	process.env.BIRDCLAW_HOME = dir;
	resetBirdclawPathsForTests();
	return getNativeDb({ seedDemoData: false });
}

function addResource(
	source: "github" | "instagram",
	account: string,
	id: string,
	text: string,
	metadata: Record<string, unknown> = {},
) {
	getNativeDb({ seedDemoData: false })
		.prepare(
			`insert into saved_resources(source, account, external_id, url, title, author, text, saved_at, fetched_at, metadata_json, content_hash)
			 values(?,?,?,?,?,?,?,?,?,?,?)`,
		)
		.run(
			source,
			account,
			id,
			`https://example.com/${source}/${id}`,
			`${source} ${id}`,
			`${source}-author`,
			text,
			"2026-03-01T00:00:00.000Z",
			"2026-03-02T00:00:00.000Z",
			JSON.stringify(metadata),
			"source-hash",
		);
}

function addXBookmark(account: string, id: string, text: string) {
	const db = getNativeDb({ seedDemoData: false });
	db.prepare(
		"insert into profiles(id, handle, display_name, bio, created_at) values(?,?,?,?,?)",
	).run(`profile-${id}`, `user-${id}`, `User ${id}`, "", "2020-01-01");
	db.prepare(
		"insert into tweets(id, account_id, author_profile_id, kind, text, created_at) values(?,?,?,?,?,?)",
	).run(
		id,
		account,
		`profile-${id}`,
		"tweet",
		text,
		"2026-01-01T00:00:00.000Z",
	);
	db.prepare(
		"insert into tweet_collections(account_id, tweet_id, kind, collected_at, source, updated_at) values(?,?,?,?,?,?)",
	).run(
		account,
		id,
		"bookmarks",
		"2026-01-04T00:00:00.000Z",
		"archive",
		"2026-01-05T00:00:00.000Z",
	);
}

function setDefaultReranker() {
	mocks.rerankKnowledgePassages.mockImplementation(
		async (_query, passages) => ({
			judgments: new Map(
				passages.map((passage, index) => [
					passage.id,
					{ score: 2 + (index % 3), confidence: 1 },
				]),
			),
			complete: true,
			requests: passages.length,
			inputTokens: 10,
			warnings: [] as string[],
		}),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.resolveEmbeddingModel.mockResolvedValue({
		name: "test-model",
		signature: "test-model:digest-a",
	});
	mocks.embedTexts.mockImplementation(async (_model, texts) =>
		texts.map(() => [1, 0]),
	);
	setDefaultReranker();
});

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	for (const dir of tempDirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("knowledge index and search", () => {
	it("returns citations and source timestamps for X, GitHub, and Instagram", async () => {
		setTestHome();
		addXBookmark("x-account", "post", "A bookmarked field note about forests.");
		addResource(
			"github",
			"dev",
			"repo",
			"A repository field note about forests.",
			{ pushedAt: "2026-02-02" },
		);
		addResource(
			"instagram",
			"photo-user",
			"reel",
			"A saved field note about forests.",
			{
				publishedAt: "2026-02-03",
				publishedAtSource: "visible-time",
				savedAtSource: "first-seen",
			},
		);
		await indexKnowledge();
		const result = await searchKnowledge({
			query: "forests",
			limit: 10,
			rerank: false,
		});
		expect(new Set(result.items.map((item) => item.source))).toEqual(
			new Set(["x", "github", "instagram"]),
		);
		expect(result.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: "x",
					url: "https://x.com/user-post/status/post",
					savedAt: "2026-01-04T00:00:00.000Z",
					fetchedAt: "2026-01-05T00:00:00.000Z",
				}),
				expect.objectContaining({
					source: "github",
					publishedAt: null,
					savedAtSource: "starred-at",
				}),
				expect.objectContaining({
					source: "instagram",
					publishedAt: "2026-02-03",
					publishedAtSource: "visible-time",
				}),
			]),
		);
	});

	it("finds a semantic paraphrase without a lexical match", async () => {
		setTestHome();
		mocks.embedTexts.mockImplementation(async (_model, texts) =>
			texts.map((text) =>
				text.includes("vehicle maintenance") ||
				text.includes("ways of getting around")
					? [1, 0]
					: [0, 1],
			),
		);
		addResource(
			"github",
			"dev",
			"transport",
			"A practical guide to vehicle maintenance and road travel.",
		);
		addResource(
			"github",
			"dev",
			"planting",
			"A practical guide to flower planting and soil care.",
		);
		await indexKnowledge();
		const result = await searchKnowledge({
			query: "ways of getting around",
			mode: "semantic",
			limit: 1,
			rerank: false,
		});
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.externalId).toBe("transport");
		expect(result.items[0]?.semanticSimilarity).toBe(1);
	});

	it("handles punctuation safely and applies source/account filters before reranking", async () => {
		setTestHome();
		addResource("github", "alice", "one", "A field guide to birds.");
		addResource("github", "bob", "two", "A field guide to birds.");
		addResource("instagram", "alice", "three", "A field guide to birds.");
		await indexKnowledge();
		const result = await searchKnowledge({
			query: `birds " ( ) : * {} /`,
			source: "github",
			account: "alice",
			mode: "keyword",
			rerank: true,
		});
		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({
			source: "github",
			account: "alice",
			externalId: "one",
		});
		expect(
			mocks.rerankKnowledgePassages.mock.calls
				.at(-1)?.[1]
				.map((item) => item.id),
		).toEqual([result.items[0]?.passageId]);
	});

	it("caps long-document results at two passages and reuses cached embeddings", async () => {
		setTestHome();
		addResource("github", "alice", "long", "orchid knowledge. ".repeat(240));
		addResource(
			"instagram",
			"alice",
			"short",
			"orchid knowledge in one small note.",
		);
		const first = await indexKnowledge();
		expect(first.embeddedPassages).toBeGreaterThan(2);
		const callsAfterFirst = mocks.embedTexts.mock.calls.length;
		const second = await indexKnowledge();
		expect(second.reusedDocuments).toBe(2);
		expect(second.embeddedPassages).toBe(0);
		expect(mocks.embedTexts.mock.calls.length).toBe(callsAfterFirst);
		const longId = JSON.stringify(["github", "alice", "long"]);
		const indexedChunks = getNativeDb({ seedDemoData: false })
			.prepare(
				"select start_offset, end_offset from knowledge_passages where document_id=? order by ordinal",
			)
			.all(longId) as { start_offset: number; end_offset: number }[];
		expect(indexedChunks.length).toBeGreaterThan(1);
		for (let index = 1; index < indexedChunks.length; index += 1) {
			expect(indexedChunks[index]!.start_offset).toBeLessThan(
				indexedChunks[index - 1]!.end_offset,
			);
			expect(
				indexedChunks[index]!.end_offset - indexedChunks[index]!.start_offset,
			).toBeLessThanOrEqual(1600);
		}
		const result = await searchKnowledge({
			query: "orchid",
			limit: 10,
			rerank: false,
		});
		expect(
			result.items.filter((item) => item.externalId === "long").length,
		).toBeLessThanOrEqual(2);
	});

	it("reports an incomplete index when a multi-passage document is missing a passage", async () => {
		setTestHome();
		addResource("github", "alice", "partial", "orchid evidence. ".repeat(220));
		await indexKnowledge();
		const db = getNativeDb({ seedDemoData: false });
		const documentId = JSON.stringify(["github", "alice", "partial"]);
		expect(
			(
				db
					.prepare(
						"select count(*) as count from knowledge_passages where document_id=?",
					)
					.get(documentId) as { count: number }
			).count,
		).toBeGreaterThan(1);
		db.prepare(
			"delete from knowledge_passages where document_id=? and ordinal=0",
		).run(documentId);

		const result = await searchKnowledge({
			query: "orchid",
			mode: "keyword",
			rerank: false,
		});
		expect(result.stats.indexIncomplete).toBe(true);
		expect(result.stats.indexedDocuments).toBe(0);
		expect(result.warnings.join(" ")).toContain("missing or outdated");
	});

	it("excludes changed content until reindexing, then refreshes timestamps without embedding", async () => {
		setTestHome();
		addResource("github", "alice", "note", "current token appears here.");
		await indexKnowledge();
		const db = getNativeDb({ seedDemoData: false });
		db.prepare(
			"update saved_resources set saved_at=?, fetched_at=? where external_id=?",
		).run("2026-04-01", "2026-04-02", "note");
		const beforeRefresh = mocks.embedTexts.mock.calls.length;
		const refreshIndex = await indexKnowledge();
		expect(refreshIndex.reusedDocuments).toBeGreaterThanOrEqual(1);
		expect(refreshIndex.embeddedPassages).toBe(0);
		expect(mocks.embedTexts).toHaveBeenCalledTimes(beforeRefresh);
		const refreshed = await searchKnowledge({
			query: "current",
			rerank: false,
		});
		expect(refreshed.items[0]).toMatchObject({
			savedAt: "2026-04-01",
			fetchedAt: "2026-04-02",
		});
		db.prepare("update saved_resources set text=? where external_id=?").run(
			"replacement content only.",
			"note",
		);
		const stale = await searchKnowledge({ query: "current", rerank: false });
		expect(stale.items).toEqual([]);
		expect(stale.stats.indexIncomplete).toBe(true);
		expect(
			(
				await searchKnowledge({
					query: "replacement",
					mode: "keyword",
					rerank: false,
				})
			).items,
		).toEqual([]);
		await indexKnowledge();
		expect(
			(
				await searchKnowledge({
					query: "replacement",
					mode: "keyword",
					rerank: false,
				})
			).items,
		).toHaveLength(1);
	});

	it("filters old model vectors, reindexes for the new digest, and prunes removed records", async () => {
		setTestHome();
		addResource("github", "alice", "remove", "prunable orchid note.");
		await indexKnowledge();
		const db = getNativeDb({ seedDemoData: false });
		mocks.resolveEmbeddingModel.mockResolvedValue({
			name: "test-model",
			signature: "test-model:digest-b",
		});
		const staleModel = await searchKnowledge({
			query: "orchid",
			rerank: false,
		});
		expect(staleModel.items).toEqual([]);
		expect(staleModel.stats.indexIncomplete).toBe(true);
		const reindexed = await indexKnowledge();
		expect(reindexed.indexedDocuments).toBeGreaterThanOrEqual(1);
		expect(
			db
				.prepare("select distinct embedding_model from knowledge_passages")
				.all(),
		).toEqual([{ embedding_model: "test-model:digest-b" }]);
		db.prepare("delete from saved_resources where external_id=?").run("remove");
		const pruned = await indexKnowledge();
		expect(pruned.removedDocuments).toBeGreaterThanOrEqual(1);
		expect(
			db
				.prepare("select id from knowledge_documents where id like '%remove%'")
				.all(),
		).toEqual([]);
	});

	it("keeps previously committed documents intact when a changed document fails to embed", async () => {
		setTestHome();
		addResource("github", "alice", "one", "committed original. ".repeat(1900));
		await indexKnowledge();
		const db = getNativeDb({ seedDemoData: false });
		const original = db
			.prepare("select content_hash from knowledge_documents")
			.get();
		db.prepare("update saved_resources set text=? where external_id=?").run(
			"changed replacement. ".repeat(1900),
			"one",
		);
		mocks.embedTexts
			.mockImplementationOnce(async (_model, texts) => texts.map(() => [1, 0]))
			.mockRejectedValueOnce(new Error("mocked embedding failure"));
		await expect(indexKnowledge()).rejects.toThrow("mocked embedding failure");
		expect(
			db.prepare("select content_hash from knowledge_documents").get(),
		).toEqual(original);
		expect(
			db.prepare("select count(*) as n from knowledge_passages").get(),
		).toMatchObject({ n: expect.any(Number) });
		expect(
			(
				await searchKnowledge({
					query: "changed",
					mode: "keyword",
					rerank: false,
				})
			).items,
		).toEqual([]);
	});

	it("rejects a concurrent lease and recovers an expired lease", async () => {
		setTestHome();
		addResource("github", "alice", "one", "lease test.");
		let release!: () => void;
		let started!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const entered = new Promise<void>((resolve) => (started = resolve));
		mocks.embedTexts.mockImplementationOnce(async (_model, texts) => {
			started();
			await gate;
			return texts.map(() => [1, 0]);
		});
		const running = indexKnowledge();
		await entered;
		await expect(indexKnowledge()).rejects.toThrow("already running");
		release();
		await running;
		const db = getNativeDb({ seedDemoData: false });
		db.prepare(
			"insert into knowledge_index_lock(id, owner, expires_at) values(1, 'abandoned', 0)",
		).run();
		expect((await indexKnowledge()).reusedDocuments).toBe(1);
	});

	it("uses complete reranker order and falls back to hybrid order when judgments are partial", async () => {
		setTestHome();
		addResource("github", "alice", "a", "shared evidence.");
		addResource("github", "alice", "b", "shared evidence.");
		await indexKnowledge();
		mocks.rerankKnowledgePassages.mockImplementationOnce(
			async (_query, passages) => ({
				judgments: new Map(
					passages.map((passage) => [
						passage.id,
						{ score: passage.id === passages[0]?.id ? 0 : 4, confidence: 1 },
					]),
				),
				complete: true,
				requests: passages.length,
				inputTokens: 5,
				warnings: [] as string[],
			}),
		);
		const reranked = await searchKnowledge({ query: "shared", limit: 10 });
		expect(reranked.reranking.complete).toBe(true);
		expect(reranked.items[0]?.passageId).not.toBe(
			mocks.rerankKnowledgePassages.mock.calls.at(-1)?.[1][0]?.id,
		);
		const hybrid = await searchKnowledge({
			query: "shared",
			limit: 10,
			rerank: false,
		});
		mocks.rerankKnowledgePassages.mockImplementationOnce(
			async (_query, passages) => ({
				judgments: new Map([[passages[0]!.id, { score: 4, confidence: 1 }]]),
				complete: false,
				requests: 1,
				inputTokens: 5,
				warnings: ["partial"],
			}),
		);
		const partial = await searchKnowledge({ query: "shared", limit: 10 });
		expect(partial.reranking.complete).toBe(false);
		expect(partial.items.map((item) => item.passageId)).toEqual(
			hybrid.items.map((item) => item.passageId),
		);
	});

	it("validates blank queries and limits", async () => {
		setTestHome();
		await expect(searchKnowledge({ query: "   " })).rejects.toThrow(
			"1–1000 characters",
		);
		await expect(searchKnowledge({ query: "valid", limit: 0 })).rejects.toThrow(
			"between 1 and 50",
		);
		await expect(
			searchKnowledge({ query: "valid", limit: 1.5 }),
		).rejects.toThrow("between 1 and 50");
	});
});

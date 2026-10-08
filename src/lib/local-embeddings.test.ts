import { afterEach, describe, expect, it, vi } from "vitest";
import {
	EMBEDDING_MODEL,
	embedTexts,
	queryEmbeddingText,
	resolveEmbeddingModel,
	documentEmbeddingText,
	type EmbeddingModel,
} from "./local-embeddings";

const model: EmbeddingModel = {
	name: EMBEDDING_MODEL,
	signature: `${EMBEDDING_MODEL}:digest-a:retrieval-v1`,
};

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function tags(digest = "digest-a") {
	return response({ models: [{ name: EMBEDDING_MODEL, digest }] });
}

afterEach(() => vi.unstubAllGlobals());

describe("local embeddings", () => {
	it("requires EmbeddingGemma 2 even when the older model is installed", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				response({
					models: [{ name: "embeddinggemma:latest", digest: "legacy-digest" }],
				}),
			),
		);
		await expect(resolveEmbeddingModel()).rejects.toThrow(
			"ollama pull embeddinggemma-2",
		);
	});
	it("reports an actionable command when the model is missing", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response({ models: [] })),
		);
		await expect(resolveEmbeddingModel()).rejects.toThrow(
			"ollama pull embeddinggemma-2",
		);
	});

	it("turns network failures into actionable local service guidance", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("offline");
			}),
		);
		await expect(resolveEmbeddingModel()).rejects.toThrow("Start Ollama");
		await expect(resolveEmbeddingModel()).rejects.toThrow(
			"ollama pull embeddinggemma-2",
		);
	});

	it("uses retrieval prompts, batches inputs, disables truncation, and normalizes vectors", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({
					embeddings: [
						[3, 4],
						[0, 2],
					],
				}),
			)
			.mockResolvedValueOnce(tags());
		vi.stubGlobal("fetch", fetchMock);
		const vectors = await embedTexts(model, [
			documentEmbeddingText("A title", "body"),
			queryEmbeddingText("find it"),
		]);
		expect(vectors[0]).toEqual([0.6, 0.8]);
		expect(vectors[1]).toEqual([0, 1]);
		const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(request).toMatchObject({
			model: EMBEDDING_MODEL,
			input: [
				"title: A title | text: body",
				"task: search result | query: find it",
			],
			truncate: false,
			keep_alive: "10m",
		});
	});

	it("rejects a response with the wrong number of vectors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce(response({ embeddings: [[1, 0]] })),
		);
		await expect(embedTexts(model, ["one", "two"])).rejects.toThrow(
			"wrong number of embeddings",
		);
	});

	it.each([
		{ vector: [0, 0] },
		{ vector: [Number.NaN, 1] },
		{ vector: [Number.POSITIVE_INFINITY, 1] },
	])("rejects zero or non-finite vectors: %j", async ({ vector }) => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ embeddings: [vector] }),
				})
				.mockResolvedValueOnce(tags()),
		);
		await expect(embedTexts(model, ["text"])).rejects.toThrow(
			/invalid embedding|Invalid input/i,
		);
	});

	it("rejects vectors with inconsistent dimensions", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(response({ embeddings: [[1, 0], [1]] }))
				.mockResolvedValueOnce(tags()),
		);
		await expect(embedTexts(model, ["one", "two"])).rejects.toThrow(
			"invalid embedding",
		);
	});

	it("rejects results if the model digest changed while embedding", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(response({ embeddings: [[1, 0]] }))
				.mockResolvedValueOnce(tags("digest-b")),
		);
		await expect(embedTexts(model, ["text"])).rejects.toThrow(
			"Embedding model changed",
		);
	});
});

import { z } from "zod";

const OLLAMA = "http://127.0.0.1:11434";
export const EMBEDDING_MODEL = "embeddinggemma-2:latest";
export interface EmbeddingModel {
	name: string;
	signature: string;
}

async function ollama(path: string, body?: unknown) {
	let response: Response;
	try {
		response = await fetch(`${OLLAMA}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers:
				body === undefined ? undefined : { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(120_000),
		});
	} catch {
		throw new Error(
			"Local embedding service unavailable. Start Ollama, then run: ollama pull embeddinggemma-2",
		);
	}
	if (!response.ok)
		throw new Error(
			`Ollama ${path} failed (${response.status}): ${(await response.text()).slice(0, 300)}`,
		);
	return response.json() as Promise<unknown>;
}

export async function resolveEmbeddingModel(): Promise<EmbeddingModel> {
	const result = z
		.object({
			models: z.array(
				z.object({ name: z.string(), digest: z.string().min(1) }),
			),
		})
		.parse(await ollama("/api/tags"));
	const model = result.models.find((item) => item.name === EMBEDDING_MODEL);
	if (!model)
		throw new Error(
			"Missing local embedding model. Run: ollama pull embeddinggemma-2",
		);
	return {
		name: model.name,
		signature: `${model.name}:${model.digest}:retrieval-v1`,
	};
}

export async function embedTexts(
	model: EmbeddingModel,
	texts: string[],
): Promise<number[][]> {
	if (!texts.length) return [];
	const response = z
		.object({ embeddings: z.array(z.array(z.number().finite()).min(1)) })
		.parse(
			await ollama("/api/embed", {
				model: model.name,
				input: texts,
				truncate: false,
				keep_alive: "10m",
			}),
		);
	if (response.embeddings.length !== texts.length)
		throw new Error("Ollama returned the wrong number of embeddings");
	if ((await resolveEmbeddingModel()).signature !== model.signature)
		throw new Error(
			"Embedding model changed during the request; rerun indexing",
		);
	const dimensions = response.embeddings[0]!.length;
	return response.embeddings.map((vector) => {
		const norm = Math.hypot(...vector);
		if (!norm || vector.length !== dimensions)
			throw new Error("Ollama returned an invalid embedding");
		return vector.map((value) => value / norm);
	});
}

export function documentEmbeddingText(title: string, text: string) {
	return `title: ${title.slice(0, 256) || "none"} | text: ${text}`;
}
export function queryEmbeddingText(query: string) {
	return `task: search result | query: ${query}`;
}

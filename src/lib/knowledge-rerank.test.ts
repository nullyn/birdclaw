// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { resetDatabaseForTests } from "./db";
import {
	rerankKnowledgePassages,
	type RerankPassage,
} from "./knowledge-rerank";

const systemOneMock = vi.hoisted(() => vi.fn());
vi.mock("./typesafe-key", () => ({
	getTypeSafeApiKey: () => process.env.TYPESAFE_API_KEY,
}));
vi.mock("@typesafe-ai/sdk", () => ({
	TypeSafeClient: class {
		systemOne = systemOneMock;
		constructor(_options: unknown) {}
	},
	score: (question: string, labels: readonly string[]) => ({
		type: "score",
		question,
		labels,
	}),
}));

let tempDir = "";
let originalCwd = "";
const passage: RerankPassage = {
	id: "p1",
	title: "Evidence",
	author: "Writer",
	text: "The passage supports the query with details.",
	source: "saved resource",
};

function answer(score = 3, confidence = 0.8) {
	return {
		model: "jev-1.13.0",
		usage: { input_tokens: 11 },
		answers: { relevance: { type: "score", score, confidence } },
	};
}

beforeEach(() => {
	tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-knowledge-rerank-"));
	originalCwd = process.cwd();
	process.chdir(tempDir);
	process.env.BIRDCLAW_HOME = tempDir;
	process.env.TYPESAFE_API_KEY = "unit-test-key";
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
	systemOneMock.mockReset().mockResolvedValue(answer());
});

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	process.chdir(originalCwd);
	delete process.env.BIRDCLAW_HOME;
	delete process.env.TYPESAFE_API_KEY;
	rmSync(tempDir, { recursive: true, force: true });
});

describe("knowledge reranking", () => {
	it("reuses a cached judgment without another paid request", async () => {
		const first = await rerankKnowledgePassages("find evidence", [passage]);
		const second = await rerankKnowledgePassages("find evidence", [passage]);
		expect(systemOneMock).toHaveBeenCalledTimes(1);
		expect(first.judgments).toEqual(second.judgments);
		expect(second.requests).toBe(0);
		expect(second.inputTokens).toBe(0);
	});

	it("invalidates the cache when query or evidence changes", async () => {
		await rerankKnowledgePassages("find evidence", [passage]);
		await rerankKnowledgePassages("find other evidence", [passage]);
		await rerankKnowledgePassages("find evidence", [
			{ ...passage, text: "Updated evidence." },
		]);
		expect(systemOneMock).toHaveBeenCalledTimes(3);
	});

	it("returns a partial shortlist with an actionable warning when the key is missing", async () => {
		delete process.env.TYPESAFE_API_KEY;
		const result = await rerankKnowledgePassages("query", [passage]);
		expect(result.complete).toBe(false);
		expect(result.judgments.size).toBe(0);
		expect(result.warnings.join(" ")).toContain("TYPESAFE_API_KEY is missing");
		expect(systemOneMock).not.toHaveBeenCalled();
	});

	it("keeps valid partial judgments when one service call fails", async () => {
		systemOneMock
			.mockResolvedValueOnce(answer(4, 1))
			.mockRejectedValueOnce(new Error("service down"));
		const result = await rerankKnowledgePassages("query", [
			passage,
			{ ...passage, id: "p2" },
		]);
		expect(result.complete).toBe(false);
		expect(result.judgments.get("p1")).toEqual({ score: 4, confidence: 1 });
		expect(result.judgments.has("p2")).toBe(false);
		expect(result.warnings.join(" ")).toContain("Some JEV judgments failed");
	});

	it.each([
		{ score: -1, confidence: 0.5 },
		{ score: 5, confidence: 0.5 },
		{ score: 2, confidence: -0.1 },
		{ score: 2, confidence: 1.1 },
	])(
		"does not cache out-of-range score/confidence $score/$confidence",
		async ({ score, confidence }) => {
			systemOneMock.mockResolvedValue(answer(score, confidence));
			const first = await rerankKnowledgePassages("query", [passage]);
			const second = await rerankKnowledgePassages("query", [passage]);
			expect(first.complete).toBe(false);
			expect(first.judgments.size).toBe(0);
			expect(first.warnings).toHaveLength(1);
			expect(second.requests).toBe(1);
			expect(systemOneMock).toHaveBeenCalledTimes(2);
		},
	);
});

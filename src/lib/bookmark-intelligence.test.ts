// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests, writeBirdclawConfig } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { analyzeBookmarks } from "./bookmark-intelligence";

const systemOneMock = vi.hoisted(() => vi.fn());
vi.mock("@typesafe-ai/sdk", () => ({
	TypeSafeClient: class {
		systemOne = systemOneMock;
		constructor(_options: unknown) {}
	},
	noul: (question: string) => ({ type: "noul", question }),
	score: (question: string, labels: readonly string[]) => ({
		type: "score",
		question,
		labels,
	}),
}));

let tempDir = "";
beforeEach(() => {
	tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-bookmark-intel-"));
	process.env.BIRDCLAW_HOME = tempDir;
	process.env.TYPESAFE_API_KEY = "unit-test-key";
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
	writeBirdclawConfig({ bookmarks: { topics: ["AI", "Design"] } });
	const db = getNativeDb({ seedDemoData: false });
	db.prepare(
		"insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at) values (?, ?, ?, ?, ?, ?, ?)",
	).run("acct_a", "A", "alice", "1", "bird", 1, "2026-01-01");
	db.prepare(
		"insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at) values (?, ?, ?, ?, ?, ?, ?)",
	).run("acct_b", "B", "bob", "2", "bird", 0, "2026-01-01");
	db.prepare(
		"insert into profiles (id, handle, display_name, bio, followers_count, following_count, avatar_hue, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
	).run("profile", "author", "Author", "", 0, 0, 1, "2026-01-01");
	systemOneMock.mockReset();
	systemOneMock.mockImplementation(
		async ({ questions }: { questions: Record<string, unknown> }) => ({
			model: "jev-1.13.0",
			usage: { input_tokens: 42 },
			answers: Object.fromEntries(
				Object.keys(questions).map((key) => [
					key,
					key.startsWith("topic_")
						? { type: "noul", noul: key === "topic_0" ? 0.9 : 0.2 }
						: {
								type: "score",
								score: 3,
								confidence: 0.8,
								probabilities: { "3": 0.8 },
							},
				]),
			),
		}),
	);
});
afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	delete process.env.TYPESAFE_API_KEY;
	rmSync(tempDir, { recursive: true, force: true });
});

function addBookmark(
	id: string,
	text: string,
	account = "acct_a",
	quotedTweetId: string | null = null,
) {
	const db = getNativeDb();
	db.prepare(
		"insert into tweets (id, account_id, author_profile_id, kind, text, created_at, quoted_tweet_id) values (?, ?, ?, ?, ?, ?, ?)",
	).run(id, account, "profile", "home", text, "2026-01-01", quotedTweetId);
	db.prepare(
		"insert into tweet_collections (account_id, tweet_id, kind, source, updated_at) values (?, ?, ?, ?, ?)",
	).run(account, id, "bookmarks", "test", "2026-01-01");
}

describe("bookmark intelligence", () => {
	it("does not seed demo bookmarks when analyzing a fresh empty library", async () => {
		const db = getNativeDb({ seedDemoData: false });
		db.exec("delete from profiles; delete from accounts");
		const result = await analyzeBookmarks({
			ids: ["unknown"],
			cachedOnly: true,
		});
		expect(result.items).toEqual([]);
		expect(db.prepare("select count(*) as count from accounts").get()).toEqual({
			count: 0,
		});
		expect(systemOneMock).not.toHaveBeenCalled();
	});

	it("reuses JEV cache for identical bookmark text and query", async () => {
		addBookmark("t1", "AI agents are useful");
		const first = await analyzeBookmarks({ ids: ["t1"], query: "find agents" });
		const second = await analyzeBookmarks({
			ids: ["t1"],
			query: "find agents",
		});
		expect(systemOneMock).toHaveBeenCalledTimes(1);
		expect(first.items).toEqual(second.items);
		expect(second.requests).toBe(0);
	});

	it("reuses topic judgments across queries and asks JEV only for relevance", async () => {
		addBookmark("t1", "AI agents are useful");
		await analyzeBookmarks({ ids: ["t1"], query: "find agents" });
		await analyzeBookmarks({ ids: ["t1"], query: "find tools" });
		expect(systemOneMock).toHaveBeenCalledTimes(2);
		expect(Object.keys(systemOneMock.mock.calls[0]![0].questions)).toEqual([
			"topic_0",
			"topic_1",
			"relevance",
		]);
		expect(Object.keys(systemOneMock.mock.calls[1]![0].questions)).toEqual([
			"relevance",
		]);
	});

	it("invalidates topic cache when quoted context changes", async () => {
		const db = getNativeDb();
		db.prepare(
			"insert into tweets (id, account_id, author_profile_id, kind, text, created_at) values (?, ?, ?, ?, ?, ?)",
		).run(
			"quote",
			"acct_a",
			"profile",
			"home",
			"Original quoted context",
			"2026-01-01",
		);
		addBookmark("t1", "A reply about that post", "acct_a", "quote");
		await analyzeBookmarks({ ids: ["t1"] });
		db.prepare("update tweets set text = ? where id = ?").run(
			"Changed quoted context",
			"quote",
		);
		await analyzeBookmarks({ ids: ["t1"] });
		expect(systemOneMock).toHaveBeenCalledTimes(2);
		expect(systemOneMock.mock.calls[0]![0].state.post.quotedText).toBe(
			"Original quoted context",
		);
		expect(systemOneMock.mock.calls[1]![0].state.post.quotedText).toBe(
			"Changed quoted context",
		);
	});

	it("invalidates cached analysis when content or query changes", async () => {
		addBookmark("t1", "AI agents are useful");
		await analyzeBookmarks({ ids: ["t1"], query: "find agents" });
		getNativeDb()
			.prepare("update tweets set text = ? where id = ?")
			.run("Design systems improve products", "t1");
		await analyzeBookmarks({ ids: ["t1"], query: "find agents" });
		await analyzeBookmarks({ ids: ["t1"], query: "find design" });
		expect(systemOneMock).toHaveBeenCalledTimes(3);
	});

	it("serves cached-only requests without calling the paid client", async () => {
		addBookmark("t1", "AI agents are useful");
		const empty = await analyzeBookmarks({ ids: ["t1"], cachedOnly: true });
		expect(empty.items).toEqual([]);
		expect(systemOneMock).not.toHaveBeenCalled();
		await analyzeBookmarks({ ids: ["t1"] });
		const cached = await analyzeBookmarks({ ids: ["t1"], cachedOnly: true });
		expect(cached.items).toHaveLength(1);
		expect(systemOneMock).toHaveBeenCalledTimes(1);
	});

	it("limits analysis to bookmarks belonging to the selected account", async () => {
		addBookmark("ta", "From account A", "acct_a");
		addBookmark("tb", "From account B", "acct_b");
		await analyzeBookmarks({ ids: ["ta"], account: "acct_a" });
		await analyzeBookmarks({ ids: ["tb"], account: "acct_b" });
		const selected = await analyzeBookmarks({
			ids: ["ta", "tb"],
			account: "acct_a",
			cachedOnly: true,
		});
		expect(selected.items.map((item) => item.id)).toEqual(["ta"]);
		expect(systemOneMock).toHaveBeenCalledTimes(2);
	});
});

// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	knowledgeContentHash,
	loadKnowledgeDocuments,
	splitKnowledgePassages,
	type KnowledgeDocument,
} from "./knowledge-passages";

const tempDirs: string[] = [];

function isWellFormedUtf16(text: string) {
	for (let offset = 0; offset < text.length; offset += 1) {
		const code = text.charCodeAt(offset);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(offset + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			offset += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function setTestHome() {
	const dir = mkdtempSync(
		path.join(os.tmpdir(), "birdclaw-knowledge-passages-"),
	);
	tempDirs.push(dir);
	process.env.BIRDCLAW_HOME = dir;
	resetBirdclawPathsForTests();
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	for (const dir of tempDirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("knowledge documents", () => {
	it("projects only account-scoped X bookmarks and includes available quote context", async () => {
		setTestHome();
		const db = getNativeDb({ seedDemoData: false });
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, created_at) values (?, ?, ?, ?, ?)",
		).run("author", "alice", "Alice", "", "2020-01-01");
		db.prepare(
			"insert into profiles (id, handle, display_name, bio, created_at) values (?, ?, ?, ?, ?)",
		).run("no-handle", "", "Unknown", "", "2020-01-01");
		const tweet = db.prepare(
			"insert into tweets (id, account_id, author_profile_id, kind, text, created_at, quoted_tweet_id) values (?, ?, ?, ?, ?, ?, ?)",
		);
		tweet.run(
			"bookmarked",
			"account-a",
			"author",
			"tweet",
			"Saved post with article preview",
			"2026-01-02",
			"quoted",
		);
		tweet.run(
			"quoted",
			"someone-else",
			"author",
			"tweet",
			"Quote body",
			"2026-01-01",
			null,
		);
		tweet.run(
			"unbookmarked",
			"account-a",
			"author",
			"tweet",
			"Not saved",
			"2026-01-03",
			null,
		);
		tweet.run(
			"handle-less",
			"account-a",
			"no-handle",
			"tweet",
			"No local author profile",
			"2026-01-06",
			null,
		);
		const collection = db.prepare(
			"insert into tweet_collections (account_id, tweet_id, kind, collected_at, source, updated_at) values (?, ?, ?, ?, ?, ?)",
		);
		collection.run(
			"account-a",
			"bookmarked",
			"bookmarks",
			"2026-01-04",
			"archive",
			"2026-01-05",
		);
		collection.run(
			"account-b",
			"unbookmarked",
			"likes",
			"2026-01-04",
			"archive",
			"2026-01-05",
		);
		collection.run(
			"account-b",
			"bookmarked",
			"bookmarks",
			null,
			"archive",
			"2026-02-01",
		);
		collection.run(
			"account-a",
			"handle-less",
			"bookmarks",
			null,
			"archive",
			"2026-02-02",
		);

		const docs = loadKnowledgeDocuments();
		expect(docs).toHaveLength(3);
		expect(docs.find((doc) => doc.externalId === "bookmarked")).toMatchObject({
			source: "x",
			account: "account-a",
			externalId: "bookmarked",
			url: "https://x.com/alice/status/bookmarked",
			text: "Saved post with article preview\n\nQuoted post: Quote body",
			publishedAt: "2026-01-02",
			publishedAtSource: "tweet.created_at",
			savedAt: "2026-01-04",
			savedAtSource: "tweet_collections.collected_at",
			fetchedAt: "2026-01-05",
		});
		expect(docs.find((doc) => doc.externalId === "handle-less")).toMatchObject({
			url: "https://x.com/i/web/status/handle-less",
			savedAt: null,
		});
		expect(docs.find((doc) => doc.account === "account-b")).toMatchObject({
			account: "account-b",
			savedAt: null,
			savedAtSource: null,
		});
	});

	it("projects saved-resource provenance and keeps IDs distinct across sources", async () => {
		setTestHome();
		const db = getNativeDb({ seedDemoData: false });
		const insert = db.prepare(
			`insert into saved_resources (source, account, external_id, url, title, author, text, saved_at, fetched_at, metadata_json, content_hash)
			 values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const [source, metadata] of [
			["github", { pushedAt: "2026-02-01" }],
			[
				"instagram",
				{
					firstSeenAt: "2026-03-02",
					savedAtSource: "first-seen",
					publishedAt: "2026-02-02",
					publishedAtSource: "visible-time",
					authorLinks: [
						"https://example.com/guide",
						"https://example.com/guide",
						null,
						"javascript:invalid",
					],
				},
			],
		] as const) {
			insert.run(
				source,
				"same-account",
				"same-id",
				`https://example.com/${source}`,
				`${source} title`,
				"author",
				`${source} body`,
				"2026-03-03",
				"2026-04-01",
				JSON.stringify(metadata),
				"unused",
			);
		}
		const docs = loadKnowledgeDocuments();
		expect(docs).toHaveLength(2);
		expect(docs[0]).toMatchObject({
			source: "github",
			savedAt: "2026-03-03",
			savedAtSource: "starred-at",
			publishedAt: null,
			publishedAtSource: null,
		});
		expect(docs[1]).toMatchObject({
			source: "instagram",
			savedAt: "2026-03-03",
			savedAtSource: "first-seen",
			publishedAt: "2026-02-02",
			publishedAtSource: "visible-time",
			text: "instagram body\n\nAuthor links: https://example.com/guide",
		});
		expect(docs[0]?.id).not.toBe(docs[1]?.id);
	});
});

describe("knowledge passages", () => {
	it("preserves offsets and covers long text with bounded overlapping chunks", () => {
		const input = `${"alpha beta gamma delta ".repeat(170)}終わり`;
		const chunks = splitKnowledgePassages(input);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0]?.start).toBe(0);
		expect(chunks.at(-1)?.end).toBe(input.length);
		for (const chunk of chunks) {
			expect(chunk.text.length).toBeLessThanOrEqual(1600);
			expect(input.slice(chunk.start, chunk.end)).toBe(chunk.text);
		}
		chunks.slice(1).forEach((chunk, index) => {
			expect(chunk.start).toBeLessThan(chunks[index]!.end);
		});
	});

	it("handles no-whitespace text, short text, and blanks", () => {
		const unbroken = "界🙂".repeat(1200);
		const chunks = splitKnowledgePassages(unbroken);
		expect(chunks.every((chunk) => chunk.text.length <= 1600)).toBe(true);
		expect(chunks.at(-1)?.end).toBe(unbroken.length);
		expect(splitKnowledgePassages(" short ")).toEqual([
			{ text: " short ", start: 0, end: 7 },
		]);
		expect(splitKnowledgePassages(" \n\t ")).toEqual([]);
	});

	it("keeps chunk boundaries outside UTF-16 surrogate pairs", () => {
		const input = `a${"😀".repeat(1800)}`;
		const chunks = splitKnowledgePassages(input);
		expect(chunks[0]?.start).toBe(0);
		expect(chunks.at(-1)?.end).toBe(input.length);
		chunks.forEach((chunk) => {
			expect(isWellFormedUtf16(chunk.text)).toBe(true);
			expect(input.slice(chunk.start, chunk.end)).toBe(chunk.text);
			expect(chunk.end - chunk.start).toBeLessThanOrEqual(1600);
		});
		chunks.slice(1).forEach((chunk, index) => {
			expect(chunk.start).toBeLessThan(chunks[index]!.end);
		});
	});

	it("does not rehash metadata timestamps", () => {
		const document: KnowledgeDocument = {
			id: JSON.stringify(["x", "account", "post"]),
			source: "x",
			account: "account",
			externalId: "post",
			url: "https://x.com/alice/status/post",
			title: "Title",
			author: "Alice",
			text: "Text",
			publishedAt: "2026-01-01",
			publishedAtSource: "tweet.created_at",
			savedAt: "2026-01-02",
			savedAtSource: "collection",
			fetchedAt: "2026-01-03",
		};
		expect(knowledgeContentHash(document)).toBe(
			knowledgeContentHash({
				...document,
				savedAt: "2026-02-02",
				fetchedAt: "2026-02-03",
			}),
		);
		expect(knowledgeContentHash(document)).not.toBe(
			knowledgeContentHash({ ...document, text: "Changed text" }),
		);
	});
});

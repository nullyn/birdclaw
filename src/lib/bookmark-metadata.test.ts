// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";

const mocks = vi.hoisted(() => ({
	generateTweetImageLabels: vi.fn(),
	generateTweetTextMetadata: vi.fn(),
	expandUrlsFromTexts: vi.fn(),
	detectAndTranslateTweet: vi.fn(),
}));

vi.mock("./openai", () => ({
	generateTweetImageLabelsEffect: (...args: unknown[]) =>
		Effect.tryPromise({
			try: () => mocks.generateTweetImageLabels(...args),
			catch: (error) => error,
		}),
	generateTweetTextMetadataEffect: (...args: unknown[]) =>
		Effect.tryPromise({
			try: () => mocks.generateTweetTextMetadata(...args),
			catch: (error) => error,
		}),
	detectAndTranslateTweetEffect: (...args: unknown[]) =>
		Effect.tryPromise({
			try: () => mocks.detectAndTranslateTweet(...args),
			catch: (error) => error,
		}),
}));

vi.mock("./url-expansion", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./url-expansion")>();
	return {
		...actual,
		expandUrlsFromTextsEffect: (...args: unknown[]) =>
			Effect.tryPromise({
				try: () => mocks.expandUrlsFromTexts(...args),
				catch: (error) => error,
			}),
	};
});

const tempRoots: string[] = [];

function setupTempHome() {
	const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-metadata-"));
	tempRoots.push(tempRoot);
	process.env.BIRDCLAW_HOME = tempRoot;
	resetBirdclawPathsForTests();
	resetDatabaseForTests();
}

function insertTweet({
	id,
	text,
	kind = "home",
	liked = 0,
	bookmarked = 0,
	mediaJson = "[]",
	entitiesJson = "{}",
}: {
	id: string;
	text: string;
	kind?: string;
	liked?: number;
	bookmarked?: number;
	mediaJson?: string;
	entitiesJson?: string;
}) {
	getNativeDb({ seedDemoData: false })
		.prepare(
			`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at, is_replied,
        reply_to_id, like_count, media_count, bookmarked, liked, entities_json,
        media_json, quoted_tweet_id
      ) values (?, 'acct_primary', 'profile_user_42', ?, ?, '2026-06-01T00:00:00.000Z',
        0, null, 0, 0, ?, ?, ?, ?, null)
      `,
		)
		.run(id, kind, text, bookmarked, liked, entitiesJson, mediaJson);
}

function insertCollection(tweetId: string, kind: "bookmarks" | "likes") {
	getNativeDb({ seedDemoData: false })
		.prepare(
			`
      insert into tweet_collections (
        account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
      ) values ('acct_primary', ?, ?, '2026-06-01T00:00:00.000Z', 'test', '{}',
        '2026-06-01T00:00:00.000Z')
      `,
		)
		.run(tweetId, kind);
}

function readMetadata(tweetId: string) {
	return getNativeDb({ seedDemoData: false })
		.prepare("select * from tweet_metadata where tweet_id = ?")
		.get(tweetId) as
		| {
				tweet_id: string;
				keywords_json: string;
				summary: string;
				image_labels_json: string;
				urls_json: string;
				model: string;
				generated_at: string;
		  }
		| undefined;
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	for (const mock of Object.values(mocks)) {
		mock.mockReset();
	}
	for (const tempRoot of tempRoots.splice(0)) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

describe("bookmark metadata generation", () => {
	it("generates and persists metadata for a bookmark", async () => {
		setupTempHome();
		insertTweet({
			id: "bookmark_1",
			text: "AI eval product https://t.co/eval",
			bookmarked: 1,
			mediaJson: JSON.stringify([
				{ type: "photo", url: "https://img.test/a.png" },
			]),
		});
		insertCollection("bookmark_1", "bookmarks");
		mocks.generateTweetTextMetadata.mockResolvedValue({
			keywords: ["ai evals", "testing"],
			summary: "AI eval product for testing agents.",
			model: "gpt-test",
		});
		mocks.generateTweetImageLabels.mockResolvedValue({
			labels: ["dashboard", "benchmark chart"],
			model: "gpt-test",
		});
		mocks.expandUrlsFromTexts.mockResolvedValue([
			{
				url: "https://t.co/eval",
				expandedUrl: "https://eval.example",
				finalUrl: "https://eval.example",
				status: "hit",
				source: "cache",
				updatedAt: "2026-06-01T00:00:00.000Z",
			},
		]);
		const { generateBookmarkMetadata } = await import("./bookmark-metadata");

		const result = await generateBookmarkMetadata({ limit: 10 });
		const row = readMetadata("bookmark_1");

		expect(result).toEqual({ scanned: 1, generated: 1, skipped: 0, failed: 0 });
		expect(row).toMatchObject({
			tweet_id: "bookmark_1",
			keywords_json: JSON.stringify(["ai evals", "testing"]),
			summary: "AI eval product for testing agents.",
			image_labels_json: JSON.stringify(["dashboard", "benchmark chart"]),
			urls_json: JSON.stringify(["https://eval.example"]),
			model: "gpt-test",
		});
		expect(row?.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(mocks.expandUrlsFromTexts).toHaveBeenCalledWith([
			"AI eval product https://t.co/eval",
		]);
	});

	it("generates for reference parents but not likes", async () => {
		setupTempHome();
		insertTweet({
			id: "parent_1",
			text: "Parent agent framework",
			kind: "reference",
		});
		insertTweet({ id: "liked_1", text: "Liked only", liked: 1 });
		insertCollection("liked_1", "likes");
		mocks.generateTweetTextMetadata.mockResolvedValue({
			keywords: ["agent framework"],
			summary: "Parent framework.",
			model: "gpt-test",
		});
		mocks.expandUrlsFromTexts.mockResolvedValue([]);
		const { generateBookmarkMetadata } = await import("./bookmark-metadata");

		const result = await generateBookmarkMetadata({ limit: 10 });

		expect(result).toEqual({ scanned: 1, generated: 1, skipped: 0, failed: 0 });
		expect(readMetadata("parent_1")).toBeTruthy();
		expect(readMetadata("liked_1")).toBeUndefined();
	});

	it("skips existing metadata unless refresh is requested", async () => {
		setupTempHome();
		insertTweet({ id: "bookmark_1", text: "AI app", bookmarked: 1 });
		insertCollection("bookmark_1", "bookmarks");
		getNativeDb({ seedDemoData: false })
			.prepare(
				`
        insert into tweet_metadata (
          tweet_id, keywords_json, summary, image_labels_json, urls_json, model,
          generated_at
        ) values ('bookmark_1', '["old"]', 'Old summary', '[]', '[]', 'old-model',
          '2026-06-01T00:00:00.000Z')
        `,
			)
			.run();
		mocks.generateTweetTextMetadata.mockResolvedValue({
			keywords: ["new"],
			summary: "New summary",
			model: "gpt-test",
		});
		mocks.expandUrlsFromTexts.mockResolvedValue([]);
		const { generateBookmarkMetadata } = await import("./bookmark-metadata");

		await expect(generateBookmarkMetadata({ limit: 10 })).resolves.toEqual({
			scanned: 1,
			generated: 0,
			skipped: 1,
			failed: 0,
		});
		expect(mocks.generateTweetTextMetadata).not.toHaveBeenCalled();

		await expect(
			generateBookmarkMetadata({ limit: 10, refresh: true }),
		).resolves.toMatchObject({
			scanned: 1,
			generated: 1,
			skipped: 0,
			failed: 0,
		});
		expect(readMetadata("bookmark_1")?.summary).toBe("New summary");
	});

	it("continues past already-complete rows to find older missing metadata", async () => {
		setupTempHome();
		insertTweet({ id: "new_complete", text: "Already done", bookmarked: 1 });
		insertTweet({
			id: "old_missing",
			text: "Older agent product",
			bookmarked: 1,
		});
		insertCollection("new_complete", "bookmarks");
		insertCollection("old_missing", "bookmarks");
		getNativeDb({ seedDemoData: false })
			.prepare(
				`
        insert into tweet_metadata (
          tweet_id, keywords_json, summary, image_labels_json, urls_json, model,
          generated_at
        ) values ('new_complete', '["old"]', 'Already generated', '[]', '[]',
          'old-model', '2026-06-01T00:00:00.000Z')
        `,
			)
			.run();
		getNativeDb({ seedDemoData: false })
			.prepare(
				"update tweets set lang = 'en', text_en = null where id = 'new_complete'",
			)
			.run();
		mocks.generateTweetTextMetadata.mockResolvedValue({
			keywords: ["agent product"],
			summary: "Older product.",
			model: "gpt-test",
		});
		mocks.detectAndTranslateTweet.mockResolvedValue({
			lang: "en",
			textEn: null,
			model: "gpt-test",
		});
		mocks.expandUrlsFromTexts.mockResolvedValue([]);
		const { generateBookmarkMetadata } = await import("./bookmark-metadata");

		await expect(generateBookmarkMetadata({ limit: 1 })).resolves.toEqual({
			scanned: 1,
			generated: 1,
			skipped: 0,
			failed: 0,
		});

		expect(readMetadata("old_missing")?.summary).toBe("Older product.");
		expect(mocks.generateTweetTextMetadata).toHaveBeenCalledWith(
			{ tweetId: "old_missing", text: "Older agent product" },
			{},
		);
	});

	it("prioritizes missing metadata over translation-only rows when limited", async () => {
		setupTempHome();
		insertTweet({
			id: "new_translation_only",
			text: "Needs language",
			bookmarked: 1,
		});
		insertTweet({
			id: "old_missing",
			text: "Older agent product",
			bookmarked: 1,
		});
		insertCollection("new_translation_only", "bookmarks");
		insertCollection("old_missing", "bookmarks");
		getNativeDb({ seedDemoData: false })
			.prepare(
				`
        insert into tweet_metadata (
          tweet_id, keywords_json, summary, image_labels_json, urls_json, model,
          generated_at
        ) values ('new_translation_only', '["old"]', 'Already generated', '[]', '[]',
          'old-model', '2026-06-01T00:00:00.000Z')
        `,
			)
			.run();
		mocks.generateTweetTextMetadata.mockResolvedValue({
			keywords: ["agent product"],
			summary: "Older product.",
			model: "gpt-test",
		});
		mocks.detectAndTranslateTweet.mockResolvedValue({
			lang: "en",
			textEn: null,
			model: "gpt-test",
		});
		mocks.expandUrlsFromTexts.mockResolvedValue([]);
		const { generateBookmarkMetadata } = await import("./bookmark-metadata");

		await generateBookmarkMetadata({ limit: 1 });

		expect(readMetadata("old_missing")?.summary).toBe("Older product.");
		expect(mocks.detectAndTranslateTweet).toHaveBeenCalledWith(
			{ tweetId: "old_missing", text: "Older agent product" },
			{},
		);
	});

	it("translation failures on existing metadata rows do not starve missing metadata", async () => {
		setupTempHome();
		insertTweet({
			id: "new_translation_only",
			text: "Needs language",
			bookmarked: 1,
		});
		insertTweet({
			id: "old_missing",
			text: "Older agent product",
			bookmarked: 1,
		});
		insertCollection("new_translation_only", "bookmarks");
		insertCollection("old_missing", "bookmarks");
		getNativeDb({ seedDemoData: false })
			.prepare(
				`
        insert into tweet_metadata (
          tweet_id, keywords_json, summary, image_labels_json, urls_json, model,
          generated_at
        ) values ('new_translation_only', '["old"]', 'Already generated', '[]', '[]',
          'old-model', '2026-06-01T00:00:00.000Z')
        `,
			)
			.run();
		mocks.detectAndTranslateTweet.mockRejectedValue(
			new Error("translation unavailable"),
		);
		mocks.generateTweetTextMetadata.mockResolvedValue({
			keywords: ["agent product"],
			summary: "Older product.",
			model: "gpt-test",
		});
		mocks.expandUrlsFromTexts.mockResolvedValue([]);
		const { generateBookmarkMetadata } = await import("./bookmark-metadata");

		await generateBookmarkMetadata({ limit: 1 });

		expect(readMetadata("old_missing")?.summary).toBe("Older product.");
		expect(mocks.detectAndTranslateTweet).toHaveBeenCalledWith(
			{ tweetId: "old_missing", text: "Older agent product" },
			{},
		);
	});

	it("writes text metadata when image labeling fails", async () => {
		setupTempHome();
		insertTweet({
			id: "bookmark_image_fail",
			text: "AI product screenshot",
			bookmarked: 1,
			mediaJson: JSON.stringify([
				{ type: "photo", url: "https://img.test/a.png" },
			]),
		});
		insertCollection("bookmark_image_fail", "bookmarks");
		mocks.generateTweetTextMetadata.mockResolvedValue({
			keywords: ["ai product"],
			summary: "Product with screenshot.",
			model: "gpt-test",
		});
		mocks.generateTweetImageLabels.mockRejectedValue(
			new Error("vision unsupported"),
		);
		mocks.detectAndTranslateTweet.mockResolvedValue({
			lang: "en",
			textEn: null,
			model: "gpt-test",
		});
		mocks.expandUrlsFromTexts.mockResolvedValue([]);
		const { generateBookmarkMetadata } = await import("./bookmark-metadata");

		await expect(generateBookmarkMetadata({ limit: 10 })).resolves.toEqual({
			scanned: 1,
			generated: 1,
			skipped: 0,
			failed: 0,
		});

		expect(readMetadata("bookmark_image_fail")).toMatchObject({
			summary: "Product with screenshot.",
			image_labels_json: "[]",
		});
	});

	it("translates existing metadata rows that have not been language checked", async () => {
		setupTempHome();
		insertTweet({
			id: "bookmark_ja",
			text: "これはAIツールです",
			bookmarked: 1,
		});
		insertCollection("bookmark_ja", "bookmarks");
		getNativeDb({ seedDemoData: false })
			.prepare(
				`
        insert into tweet_metadata (
          tweet_id, keywords_json, summary, image_labels_json, urls_json, model,
          generated_at
        ) values ('bookmark_ja', '["old"]', 'Old summary', '[]', '[]', 'old-model',
          '2026-06-01T00:00:00.000Z')
        `,
			)
			.run();
		mocks.detectAndTranslateTweet.mockResolvedValue({
			lang: "ja",
			textEn: "This is an AI tool.",
			model: "gpt-test",
		});
		const { generateBookmarkMetadata } = await import("./bookmark-metadata");

		await expect(generateBookmarkMetadata({ limit: 10 })).resolves.toEqual({
			scanned: 1,
			generated: 0,
			skipped: 1,
			failed: 0,
		});

		expect(mocks.generateTweetTextMetadata).not.toHaveBeenCalled();
		expect(mocks.detectAndTranslateTweet).toHaveBeenCalledWith(
			{ tweetId: "bookmark_ja", text: "これはAIツールです" },
			{},
		);
		expect(
			getNativeDb({ seedDemoData: false })
				.prepare(
					"select text, text_en, lang from tweets where id = 'bookmark_ja'",
				)
				.get(),
		).toEqual({
			text: "これはAIツールです",
			text_en: "This is an AI tool.",
			lang: "ja",
		});
	});

	it("continues when one tweet fails", async () => {
		setupTempHome();
		insertTweet({ id: "bookmark_fail", text: "fail me", bookmarked: 1 });
		insertTweet({ id: "bookmark_ok", text: "ok product", bookmarked: 1 });
		insertCollection("bookmark_fail", "bookmarks");
		insertCollection("bookmark_ok", "bookmarks");
		mocks.generateTweetTextMetadata
			.mockRejectedValueOnce(new Error("OpenAI failed"))
			.mockResolvedValueOnce({
				keywords: ["ok"],
				summary: "OK product.",
				model: "gpt-test",
			});
		mocks.expandUrlsFromTexts.mockResolvedValue([]);
		const { generateBookmarkMetadata } = await import("./bookmark-metadata");

		const result = await generateBookmarkMetadata({ limit: 10 });

		expect(result).toEqual({
			scanned: 2,
			generated: 1,
			skipped: 0,
			failed: 1,
			errors: [{ tweetId: "bookmark_fail", message: "OpenAI failed" }],
		});
		expect(readMetadata("bookmark_fail")).toBeUndefined();
		expect(readMetadata("bookmark_ok")).toBeTruthy();
	});

	it("passes provider and model options to metadata generation", async () => {
		setupTempHome();
		insertTweet({
			id: "bookmark_1",
			text: "AI screenshot",
			bookmarked: 1,
			mediaJson: JSON.stringify([{ url: "https://img.test/a.png" }]),
		});
		insertCollection("bookmark_1", "bookmarks");
		mocks.generateTweetTextMetadata.mockResolvedValue({
			keywords: ["agent ui"],
			summary: "Agent UI product.",
			model: "test-model",
		});
		mocks.generateTweetImageLabels.mockResolvedValue({
			labels: [],
			model: "test-model",
		});
		mocks.expandUrlsFromTexts.mockResolvedValue([]);
		const { generateBookmarkMetadata } = await import("./bookmark-metadata");

		await generateBookmarkMetadata({
			limit: 10,
			model: "test-model",
			provider: "openrouter",
		});

		expect(mocks.generateTweetTextMetadata).toHaveBeenCalledWith(
			{ tweetId: "bookmark_1", text: "AI screenshot" },
			{ model: "test-model", provider: "openrouter" },
		);
		expect(mocks.generateTweetImageLabels).toHaveBeenCalledWith(
			{
				tweetId: "bookmark_1",
				text: "AI screenshot",
				media: [{ url: "https://img.test/a.png" }],
			},
			{ model: "test-model", provider: "openrouter" },
		);
	});

	it("falls back to entities_json expandedUrl when expansion returns t.co", async () => {
		setupTempHome();
		insertTweet({
			id: "bookmark_1",
			text: "Agent tool https://t.co/miss",
			bookmarked: 1,
			entitiesJson: JSON.stringify({
				urls: [
					{
						url: "https://t.co/miss",
						expandedUrl: "https://agent-tool.example",
						displayUrl: "agent-tool.example",
					},
				],
			}),
		});
		insertCollection("bookmark_1", "bookmarks");
		mocks.generateTweetTextMetadata.mockResolvedValue({
			keywords: ["agent tool"],
			summary: "An agent tool.",
			model: "gpt-test",
		});
		// expansion "fails" — returns the original t.co as finalUrl
		mocks.expandUrlsFromTexts.mockResolvedValue([
			{
				url: "https://t.co/miss",
				expandedUrl: "https://t.co/miss",
				finalUrl: "https://t.co/miss",
				status: "miss",
				source: "http",
				updatedAt: "2026-06-01T00:00:00.000Z",
			},
		]);
		const { generateBookmarkMetadata } = await import("./bookmark-metadata");

		await generateBookmarkMetadata({ limit: 10 });
		const row = readMetadata("bookmark_1");

		expect(JSON.parse(row!.urls_json)).toEqual(["https://agent-tool.example"]);
	});

	it("falls back to entities_json expanded_url when expansion returns t.co", async () => {
		setupTempHome();
		insertTweet({
			id: "bookmark_1",
			text: "Agent tool https://t.co/miss",
			bookmarked: 1,
			entitiesJson: JSON.stringify({
				urls: [
					{
						url: "https://t.co/miss",
						expanded_url: "https://agent-tool.example/snake",
						display_url: "agent-tool.example/snake",
					},
				],
			}),
		});
		insertCollection("bookmark_1", "bookmarks");
		mocks.generateTweetTextMetadata.mockResolvedValue({
			keywords: ["agent tool"],
			summary: "An agent tool.",
			model: "gpt-test",
		});
		mocks.expandUrlsFromTexts.mockResolvedValue([
			{
				url: "https://t.co/miss",
				expandedUrl: "https://t.co/miss",
				finalUrl: "https://t.co/miss",
				status: "miss",
				source: "http",
				updatedAt: "2026-06-01T00:00:00.000Z",
			},
		]);
		const { generateBookmarkMetadata } = await import("./bookmark-metadata");

		await generateBookmarkMetadata({ limit: 10 });
		const row = readMetadata("bookmark_1");

		expect(JSON.parse(row!.urls_json)).toEqual([
			"https://agent-tool.example/snake",
		]);
	});

	it("drops t.co URLs when no entities_json fallback is available", async () => {
		setupTempHome();
		insertTweet({
			id: "bookmark_1",
			text: "Agent tool https://t.co/ghost",
			bookmarked: 1,
			entitiesJson: JSON.stringify({ urls: [] }),
		});
		insertCollection("bookmark_1", "bookmarks");
		mocks.generateTweetTextMetadata.mockResolvedValue({
			keywords: ["agent tool"],
			summary: "An agent tool.",
			model: "gpt-test",
		});
		mocks.expandUrlsFromTexts.mockResolvedValue([
			{
				url: "https://t.co/ghost",
				expandedUrl: "https://t.co/ghost",
				finalUrl: "https://t.co/ghost",
				status: "miss",
				source: "http",
				updatedAt: "2026-06-01T00:00:00.000Z",
			},
		]);
		const { generateBookmarkMetadata } = await import("./bookmark-metadata");

		await generateBookmarkMetadata({ limit: 10 });
		const row = readMetadata("bookmark_1");

		expect(JSON.parse(row!.urls_json)).toEqual([]);
	});

	it("can skip image labeling for text-only metadata runs", async () => {
		setupTempHome();
		insertTweet({
			id: "bookmark_1",
			text: "AI screenshot",
			bookmarked: 1,
			mediaJson: JSON.stringify([{ url: "https://img.test/a.png" }]),
		});
		insertCollection("bookmark_1", "bookmarks");
		mocks.generateTweetTextMetadata.mockResolvedValue({
			keywords: ["agent ui"],
			summary: "Agent UI product.",
			model: "nvidia/nemotron-3-super-120b-a12b:free",
		});
		mocks.expandUrlsFromTexts.mockResolvedValue([]);
		const { generateBookmarkMetadata } = await import("./bookmark-metadata");

		await generateBookmarkMetadata({
			limit: 10,
			skipImageLabels: true,
		});

		expect(mocks.generateTweetImageLabels).not.toHaveBeenCalled();
		expect(readMetadata("bookmark_1")?.image_labels_json).toBe("[]");
	});
});

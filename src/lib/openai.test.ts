// @vitest-environment node
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	generateTweetImageLabels,
	generateTweetTextMetadata,
	scoreInboxItemWithOpenAI,
	scoreInboxItemWithOpenAIEffect,
} from "./openai";

beforeEach(() => {
	process.env.OPENAI_API_KEY = "";
	delete process.env.OLLAMA_API_KEY;
	delete process.env.OPENROUTER_API_KEY;
	delete process.env.BIRDCLAW_AI_PROVIDER;
});

afterEach(() => {
	process.env.OPENAI_API_KEY = "";
	delete process.env.OLLAMA_API_KEY;
	delete process.env.OPENROUTER_API_KEY;
	delete process.env.BIRDCLAW_AI_PROVIDER;
	delete process.env.BIRDCLAW_OPENAI_MODEL;
	vi.unstubAllGlobals();
});

describe("openai inbox scoring", () => {
	it("fails without an API key", async () => {
		await expect(
			scoreInboxItemWithOpenAI({
				entityKind: "dm",
				title: "DM",
				text: "hello",
				influenceScore: 90,
				participant: {
					handle: "sam",
					displayName: "Sam",
					bio: "bio",
					followersCount: 10,
				},
			}),
		).rejects.toThrow("OPENAI_API_KEY");
	});

	it("returns clamped structured scores", async () => {
		process.env.OPENAI_API_KEY = "test-key";
		process.env.BIRDCLAW_OPENAI_MODEL = "gpt-test";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: JSON.stringify({
										score: 101.6,
										summary: "Strong ask",
										reasoning: "Concrete and relevant",
									}),
								},
							},
						],
					}),
				),
			),
		);

		const result = await scoreInboxItemWithOpenAI({
			entityKind: "mention",
			title: "Mention",
			text: "question?",
			influenceScore: 80,
			participant: {
				handle: "amelia",
				displayName: "Amelia",
				bio: "bio",
				followersCount: 4200,
			},
		});

		expect(result).toEqual({
			model: "gpt-test",
			score: 100,
			summary: "Strong ask",
			reasoning: "Concrete and relevant",
		});
	});

	it("exposes inbox scoring as an Effect program", async () => {
		process.env.OPENAI_API_KEY = "test-key";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: JSON.stringify({
										score: 44,
										summary: "Useful",
										reasoning: "Looks specific",
									}),
								},
							},
						],
					}),
				),
			),
		);

		await expect(
			Effect.runPromise(
				scoreInboxItemWithOpenAIEffect({
					entityKind: "mention",
					title: "Mention",
					text: "question?",
					influenceScore: 80,
					participant: {
						handle: "amelia",
						displayName: "Amelia",
						bio: "bio",
						followersCount: 4200,
					},
				}),
			),
		).resolves.toMatchObject({
			score: 44,
			summary: "Useful",
			reasoning: "Looks specific",
		});
	});

	it("fails when the API returns no content", async () => {
		process.env.OPENAI_API_KEY = "test-key";
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					new Response(JSON.stringify({ choices: [{ message: {} }] })),
				),
		);

		await expect(
			scoreInboxItemWithOpenAI({
				entityKind: "dm",
				title: "DM",
				text: "hello",
				influenceScore: 90,
				participant: {
					handle: "sam",
					displayName: "Sam",
					bio: "bio",
					followersCount: 10,
				},
			}),
		).rejects.toThrow("no content");
	});
});

describe("tweet metadata generation", () => {
	it("can call Ollama Cloud directly for text metadata", async () => {
		process.env.BIRDCLAW_AI_PROVIDER = "ollama";
		process.env.OLLAMA_API_KEY = "ollama-key";
		process.env.BIRDCLAW_OPENAI_MODEL = "deepseek-v4-flash";
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					message: {
						content: JSON.stringify({
							keywords: ["ai evals", "agent tooling"],
							summary: "An AI eval tool for agent workflows.",
						}),
					},
				}),
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await generateTweetTextMetadata({
			tweetId: "tweet_1",
			text: "New eval platform for agents",
		});

		expect(result).toEqual({
			model: "deepseek-v4-flash",
			keywords: ["ai evals", "agent tooling"],
			summary: "An AI eval tool for agent workflows.",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://ollama.com/api/chat",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					authorization: "Bearer ollama-key",
					"content-type": "application/json",
				}),
			}),
		);
		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(body).toMatchObject({
			model: "deepseek-v4-flash",
			stream: false,
		});
		expect(body).not.toHaveProperty("format");
	});

	it("skips image labeling on Ollama Cloud text-only metadata models", async () => {
		process.env.BIRDCLAW_AI_PROVIDER = "ollama";
		process.env.OLLAMA_API_KEY = "ollama-key";
		process.env.BIRDCLAW_OPENAI_MODEL = "deepseek-v4-flash";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			generateTweetImageLabels({
				tweetId: "tweet_1",
				text: "Screenshot",
				media: [{ media_url_https: "https://example.com/image.jpg" }],
			}),
		).resolves.toEqual({
			model: "deepseek-v4-flash",
			labels: [],
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("can call OpenRouter for text metadata", async () => {
		process.env.BIRDCLAW_AI_PROVIDER = "openrouter";
		process.env.OPENROUTER_API_KEY = "openrouter-key";
		process.env.BIRDCLAW_OPENAI_MODEL =
			"nvidia/nemotron-3-super-120b-a12b:free";
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content: JSON.stringify({
									keywords: ["ai search", "agent memory"],
									summary: "An AI search tool for agent memory.",
								}),
							},
						},
					],
				}),
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await generateTweetTextMetadata({
			tweetId: "tweet_1",
			text: "New AI search tool for agent memory",
		});

		expect(result).toEqual({
			model: "nvidia/nemotron-3-super-120b-a12b:free",
			keywords: ["ai search", "agent memory"],
			summary: "An AI search tool for agent memory.",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://openrouter.ai/api/v1/chat/completions",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					authorization: "Bearer openrouter-key",
					"content-type": "application/json",
				}),
			}),
		);
		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(body).toMatchObject({
			model: "nvidia/nemotron-3-super-120b-a12b:free",
			response_format: { type: "json_object" },
		});
	});

	it("can call OpenRouter for image labels", async () => {
		process.env.BIRDCLAW_AI_PROVIDER = "openrouter";
		process.env.OPENROUTER_API_KEY = "openrouter-key";
		process.env.BIRDCLAW_OPENAI_MODEL =
			"nvidia/nemotron-3-super-120b-a12b:free";
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content: JSON.stringify({
									labels: ["dashboard", "workflow builder"],
								}),
							},
						},
					],
				}),
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			generateTweetImageLabels({
				tweetId: "tweet_1",
				text: "Screenshot",
				media: [{ media_url_https: "https://example.com/image.jpg" }],
			}),
		).resolves.toEqual({
			model: "nvidia/nemotron-3-super-120b-a12b:free",
			labels: ["dashboard", "workflow builder"],
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://openrouter.ai/api/v1/chat/completions",
			expect.any(Object),
		);
	});
});

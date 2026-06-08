import { Effect } from "effect";
import { runEffectPromise, tryPromise } from "./effect-runtime";

export interface OpenAIInboxScore {
	score: number;
	summary: string;
	reasoning: string;
	model: string;
}

export interface OpenAIInboxInput {
	entityKind: "mention" | "dm";
	title: string;
	text: string;
	participant: {
		handle: string;
		displayName: string;
		bio: string;
		followersCount: number;
	};
	influenceScore: number;
}

export interface OpenAITweetTextMetadata {
	keywords: string[];
	summary: string;
	model: string;
}

export interface OpenAITweetImageLabels {
	labels: string[];
	model: string;
}

export type AIProvider = "openai" | "ollama" | "openrouter";

export interface OpenAITweetMetadataOptions {
	model?: string;
	provider?: AIProvider;
}

export interface OpenAITweetTextMetadataInput {
	tweetId?: string;
	text: string;
}

export interface OpenAITweetImageLabelsInput {
	tweetId?: string;
	text?: string;
	media: unknown[];
}

function clampScore(value: number) {
	return Math.max(0, Math.min(100, Math.round(value)));
}

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function trySync<T>(try_: () => T) {
	return Effect.try({
		try: try_,
		catch: toError,
	});
}

function resolveAIProvider(
	options: OpenAITweetMetadataOptions = {},
): AIProvider {
	const provider = options.provider ?? process.env.BIRDCLAW_AI_PROVIDER;
	if (
		provider === "ollama" ||
		provider === "openai" ||
		provider === "openrouter"
	) {
		return provider;
	}
	if (
		process.env.OPENROUTER_API_KEY &&
		!process.env.OPENAI_API_KEY &&
		!process.env.OLLAMA_API_KEY
	) {
		return "openrouter";
	}
	if (process.env.OLLAMA_API_KEY && !process.env.OPENAI_API_KEY) {
		return "ollama";
	}
	return "openai";
}

const DEFAULT_OPENAI_MODEL = "gpt-5.2";
const DEFAULT_OPENROUTER_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";
const DEFAULT_OLLAMA_MODEL = "deepseek-v4-flash";

function resolveAIModel(
	provider: AIProvider,
	options: OpenAITweetMetadataOptions = {},
) {
	return (
		options.model ??
		process.env.BIRDCLAW_OPENAI_MODEL ??
		(provider === "ollama"
			? DEFAULT_OLLAMA_MODEL
			: provider === "openrouter"
				? DEFAULT_OPENROUTER_MODEL
				: DEFAULT_OPENAI_MODEL)
	);
}

function normalizeStringArray(value: unknown) {
	return Array.isArray(value)
		? value.map((item) => String(item).trim()).filter((item) => item.length > 0)
		: [];
}

function mediaImageUrls(media: unknown[]) {
	const urls: string[] = [];
	for (const item of media) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		for (const key of [
			"url",
			"media_url",
			"media_url_https",
			"preview_image_url",
		]) {
			const value = record[key];
			if (typeof value === "string" && value.startsWith("http")) {
				urls.push(value);
				break;
			}
		}
	}
	return Array.from(new Set(urls));
}

function parseChatJson<T>(payload: {
	choices?: Array<{
		message?: {
			content?: string;
		};
	}>;
}) {
	const content = payload.choices?.[0]?.message?.content;
	if (!content) {
		throw new Error("OpenAI returned no content");
	}
	return JSON.parse(content) as T;
}

function parseOllamaChatJson<T>(payload: {
	message?: {
		content?: string;
	};
}) {
	const content = payload.message?.content;
	if (!content) {
		throw new Error("Ollama returned no content");
	}
	return JSON.parse(content) as T;
}

export function scoreInboxItemWithOpenAIEffect(
	input: OpenAIInboxInput,
): Effect.Effect<OpenAIInboxScore, Error> {
	return Effect.gen(function* () {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) {
			return yield* Effect.fail(new Error("OPENAI_API_KEY is not set"));
		}

		const model = process.env.BIRDCLAW_OPENAI_MODEL || "gpt-5.2";
		const response = yield* tryPromise(() =>
			fetch("https://api.openai.com/v1/chat/completions", {
				method: "POST",
				headers: {
					authorization: `Bearer ${apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model,
					response_format: { type: "json_object" },
					messages: [
						{
							role: "system",
							content:
								"You rank inbound Twitter mentions and DMs for Peter Steinberger. Return JSON only with keys score, summary, reasoning. Score 0-100. High score means worth replying soon. Prefer specific, actionable, novel, high-signal items. Penalize generic praise, low-context asks, and low-signal chatter. summary max 18 words. reasoning max 28 words.",
						},
						{
							role: "user",
							content: JSON.stringify(input),
						},
					],
				}),
			}),
		).pipe(Effect.mapError(toError));

		if (!response.ok) {
			return yield* Effect.fail(
				new Error(`OpenAI request failed: ${response.status}`),
			);
		}

		const payload = (yield* tryPromise(() => response.json()).pipe(
			Effect.mapError(toError),
		)) as {
			choices?: Array<{
				message?: {
					content?: string;
				};
			}>;
		};

		const content = payload.choices?.[0]?.message?.content;
		if (!content) {
			return yield* Effect.fail(new Error("OpenAI returned no content"));
		}

		const parsed = yield* trySync(
			() =>
				JSON.parse(content) as {
					score?: number;
					summary?: string;
					reasoning?: string;
				},
		);

		return {
			model,
			score: clampScore(parsed.score ?? 0),
			summary: String(parsed.summary ?? "No summary"),
			reasoning: String(parsed.reasoning ?? "No reasoning"),
		};
	});
}

export function scoreInboxItemWithOpenAI(
	input: OpenAIInboxInput,
): Promise<OpenAIInboxScore> {
	return runEffectPromise(scoreInboxItemWithOpenAIEffect(input));
}

function requestOpenAIChatEffect(args: {
	apiKey: string;
	model: string;
	system: string;
	user: unknown;
	content?: unknown;
	endpoint?: string;
}) {
	return tryPromise(() =>
		fetch(args.endpoint ?? "https://api.openai.com/v1/chat/completions", {
			method: "POST",
			headers: {
				authorization: `Bearer ${args.apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: args.model,
				response_format: { type: "json_object" },
				messages: [
					{
						role: "system",
						content: args.system,
					},
					{
						role: "user",
						content: args.content ?? JSON.stringify(args.user),
					},
				],
			}),
		}),
	).pipe(Effect.mapError(toError));
}

function requestOllamaChatEffect(args: {
	apiKey: string;
	model: string;
	system: string;
	user: unknown;
}) {
	return tryPromise(() =>
		fetch("https://ollama.com/api/chat", {
			method: "POST",
			headers: {
				authorization: `Bearer ${args.apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: args.model,
				stream: false,
				messages: [
					{
						role: "system",
						content: args.system,
					},
					{
						role: "user",
						content: JSON.stringify(args.user),
					},
				],
			}),
		}),
	).pipe(Effect.mapError(toError));
}

export function generateTweetTextMetadataEffect(
	input: OpenAITweetTextMetadataInput,
	options: OpenAITweetMetadataOptions = {},
): Effect.Effect<OpenAITweetTextMetadata, Error> {
	return Effect.gen(function* () {
		const provider = resolveAIProvider(options);
		const apiKey =
			provider === "ollama"
				? process.env.OLLAMA_API_KEY
				: provider === "openrouter"
					? process.env.OPENROUTER_API_KEY
					: process.env.OPENAI_API_KEY;
		if (!apiKey) {
			return yield* Effect.fail(
				new Error(
					provider === "ollama"
						? "OLLAMA_API_KEY is not set"
						: provider === "openrouter"
							? "OPENROUTER_API_KEY is not set"
							: "OPENAI_API_KEY is not set",
				),
			);
		}

		const model = resolveAIModel(provider, options);
		const system =
			"Extract SEO-style metadata for an AI product/project tweet. Return JSON only with keys keywords and summary. keywords is 3-8 concise strings. summary is one short agent-readable sentence, max 28 words.";
		const response =
			provider === "ollama"
				? yield* requestOllamaChatEffect({ apiKey, model, system, user: input })
				: yield* requestOpenAIChatEffect({
						apiKey,
						model,
						system,
						user: input,
						endpoint:
							provider === "openrouter"
								? "https://openrouter.ai/api/v1/chat/completions"
								: undefined,
					});

		if (!response.ok) {
			const body = yield* tryPromise(() => response.text()).pipe(
				Effect.catchAll(() => Effect.succeed("")),
			);
			return yield* Effect.fail(
				new Error(
					`${
						provider === "ollama"
							? "Ollama"
							: provider === "openrouter"
								? "OpenRouter"
								: "OpenAI"
					} request failed: ${response.status}${
						body.trim() ? `: ${body.trim()}` : ""
					}`,
				),
			);
		}

		const payload = (yield* tryPromise(() => response.json()).pipe(
			Effect.mapError(toError),
		)) as unknown;
		const parsed =
			provider === "ollama"
				? yield* trySync(() =>
						parseOllamaChatJson<{ keywords?: unknown; summary?: unknown }>(
							payload as {
								message?: { content?: string };
							},
						),
					)
				: yield* trySync(() =>
						parseChatJson<{ keywords?: unknown; summary?: unknown }>(
							payload as {
								choices?: Array<{ message?: { content?: string } }>;
							},
						),
					);

		return {
			model,
			keywords: normalizeStringArray(parsed.keywords),
			summary: String(parsed.summary ?? "").trim(),
		};
	});
}

export function generateTweetTextMetadata(
	input: OpenAITweetTextMetadataInput,
	options: OpenAITweetMetadataOptions = {},
): Promise<OpenAITweetTextMetadata> {
	return runEffectPromise(generateTweetTextMetadataEffect(input, options));
}

export function generateTweetImageLabelsEffect(
	input: OpenAITweetImageLabelsInput,
	options: OpenAITweetMetadataOptions = {},
): Effect.Effect<OpenAITweetImageLabels, Error> {
	return Effect.gen(function* () {
		const urls = mediaImageUrls(input.media);
		const provider = resolveAIProvider(options);
		const model = resolveAIModel(provider, options);
		if (urls.length === 0) {
			return { labels: [], model };
		}
		if (provider === "ollama") {
			return { labels: [], model };
		}

		const apiKey =
			provider === "openrouter"
				? process.env.OPENROUTER_API_KEY
				: process.env.OPENAI_API_KEY;
		if (!apiKey) {
			return yield* Effect.fail(
				new Error(
					provider === "openrouter"
						? "OPENROUTER_API_KEY is not set"
						: "OPENAI_API_KEY is not set",
				),
			);
		}

		const response = yield* requestOpenAIChatEffect({
			apiKey,
			model,
			system:
				"Label product screenshots or images from an AI-related tweet. Return JSON only with key labels: 3-10 concise visual/product keywords.",
			user: {
				tweetId: input.tweetId,
				text: input.text,
			},
			content: [
				{
					type: "text",
					text: JSON.stringify({
						tweetId: input.tweetId,
						text: input.text,
					}),
				},
				...urls.map((url) => ({
					type: "image_url",
					image_url: { url },
				})),
			],
			endpoint:
				provider === "openrouter"
					? "https://openrouter.ai/api/v1/chat/completions"
					: undefined,
		});

		if (!response.ok) {
			const body = yield* tryPromise(() => response.text()).pipe(
				Effect.catchAll(() => Effect.succeed("")),
			);
			return yield* Effect.fail(
				new Error(
					`${
						provider === "openrouter" ? "OpenRouter" : "OpenAI"
					} request failed: ${response.status}${
						body.trim() ? `: ${body.trim()}` : ""
					}`,
				),
			);
		}

		const payload = (yield* tryPromise(() => response.json()).pipe(
			Effect.mapError(toError),
		)) as {
			choices?: Array<{ message?: { content?: string } }>;
		};
		const parsed = yield* trySync(() =>
			parseChatJson<{ labels?: unknown }>(payload),
		);

		return {
			model,
			labels: normalizeStringArray(parsed.labels),
		};
	});
}

export function generateTweetImageLabels(
	input: OpenAITweetImageLabelsInput,
	options: OpenAITweetMetadataOptions = {},
): Promise<OpenAITweetImageLabels> {
	return runEffectPromise(generateTweetImageLabelsEffect(input, options));
}

export interface OpenAITweetTranslation {
	lang: string;
	textEn: string | null;
	model: string;
}

export interface OpenAITweetTranslationInput {
	tweetId?: string;
	text: string;
}

function isEnOrHi(lang: string): boolean {
	const code = lang.trim().toLowerCase();
	return (
		code === "en" ||
		code === "hi" ||
		code.startsWith("en-") ||
		code.startsWith("hi-")
	);
}

export function detectAndTranslateTweetEffect(
	input: OpenAITweetTranslationInput,
	options: OpenAITweetMetadataOptions = {},
): Effect.Effect<OpenAITweetTranslation, Error> {
	return Effect.gen(function* () {
		const provider = resolveAIProvider(options);
		const apiKey =
			provider === "ollama"
				? process.env.OLLAMA_API_KEY
				: provider === "openrouter"
					? process.env.OPENROUTER_API_KEY
					: process.env.OPENAI_API_KEY;
		if (!apiKey) {
			return yield* Effect.fail(
				new Error(
					provider === "ollama"
						? "OLLAMA_API_KEY is not set"
						: provider === "openrouter"
							? "OPENROUTER_API_KEY is not set"
							: "OPENAI_API_KEY is not set",
				),
			);
		}

		const model = resolveAIModel(provider, options);
		const system =
			'Detect the BCP-47-ish language of a tweet. If it\'s English (en, en-*) or Hindi (hi, hi-*), set translation to null. Otherwise, translate it to English. Return JSON only: {"lang":"<code>","translation":"<English translation or null>"}.';

		const response =
			provider === "ollama"
				? yield* requestOllamaChatEffect({ apiKey, model, system, user: input })
				: yield* requestOpenAIChatEffect({
						apiKey,
						model,
						system,
						user: input,
						endpoint:
							provider === "openrouter"
								? "https://openrouter.ai/api/v1/chat/completions"
								: undefined,
					});

		if (!response.ok) {
			const body = yield* tryPromise(() => response.text()).pipe(
				Effect.catchAll(() => Effect.succeed("")),
			);
			return yield* Effect.fail(
				new Error(
					`${
						provider === "ollama"
							? "Ollama"
							: provider === "openrouter"
								? "OpenRouter"
								: "OpenAI"
					} request failed: ${response.status}${
						body.trim() ? `: ${body.trim()}` : ""
					}`,
				),
			);
		}

		const payload = (yield* tryPromise(() => response.json()).pipe(
			Effect.mapError(toError),
		)) as unknown;
		const parsed =
			provider === "ollama"
				? yield* trySync(() =>
						parseOllamaChatJson<{ lang?: unknown; translation?: unknown }>(
							payload as { message?: { content?: string } },
						),
					)
				: yield* trySync(() =>
						parseChatJson<{ lang?: unknown; translation?: unknown }>(
							payload as {
								choices?: Array<{ message?: { content?: string } }>;
							},
						),
					);

		const lang = String(parsed.lang ?? "en")
			.trim()
			.toLowerCase();
		const textEn =
			isEnOrHi(lang) || !parsed.translation
				? null
				: String(parsed.translation).trim() || null;

		return { lang, textEn, model };
	});
}

export function detectAndTranslateTweet(
	input: OpenAITweetTranslationInput,
	options: OpenAITweetMetadataOptions = {},
): Promise<OpenAITweetTranslation> {
	return runEffectPromise(detectAndTranslateTweetEffect(input, options));
}

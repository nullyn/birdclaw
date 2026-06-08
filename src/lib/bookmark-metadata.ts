import { Either, Effect } from "effect";
import { getNativeDb } from "./db";
import { runEffectPromise } from "./effect-runtime";
import {
	type AIProvider,
	detectAndTranslateTweetEffect,
	generateTweetImageLabelsEffect,
	generateTweetTextMetadataEffect,
} from "./openai";
import { expandUrlsFromTextsEffect, extractUrls } from "./url-expansion";

export interface GenerateBookmarkMetadataOptions {
	refresh?: boolean;
	limit?: number;
	model?: string;
	provider?: AIProvider;
	skipImageLabels?: boolean;
}

export interface GenerateBookmarkMetadataSummary {
	scanned: number;
	generated: number;
	skipped: number;
	failed: number;
	errors?: Array<{
		tweetId: string;
		message: string;
	}>;
}

interface MetadataCandidate {
	id: string;
	text: string;
	media_json: string;
	entities_json: string;
	text_en: string | null;
	lang: string | null;
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

function parseMediaJson(value: string) {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function uniqueStrings(values: string[]) {
	return Array.from(
		new Set(
			values.map((value) => value.trim()).filter((value) => value.length > 0),
		),
	);
}

function tcoExpansionMap(entitiesJson: string): Map<string, string> {
	const map = new Map<string, string>();
	try {
		const parsed = JSON.parse(entitiesJson) as {
			urls?: Array<{
				url?: string;
				expandedUrl?: string;
				expanded_url?: string;
			}>;
		};
		for (const u of parsed.urls ?? []) {
			const expandedUrl = u.expandedUrl ?? u.expanded_url;
			if (u.url && expandedUrl) map.set(u.url, expandedUrl);
		}
	} catch {
		// ignore malformed entities
	}
	return map;
}

function isTcoUrl(value: string): boolean {
	try {
		return new URL(value).hostname.toLowerCase() === "t.co";
	} catch {
		return false;
	}
}

function listMetadataCandidates(limit: number, refresh: boolean) {
	const db = getNativeDb({ seedDemoData: false });
	const freshnessPredicate = refresh
		? ""
		: `
        and (
          t.lang is null
          or not exists (
            select 1
            from tweet_metadata existing_metadata
            where existing_metadata.tweet_id = t.id
          )
        )
      `;
	const orderBy = refresh
		? "t.created_at desc, t.id asc"
		: `
        case
          when exists (
            select 1
            from tweet_metadata existing_metadata
            where existing_metadata.tweet_id = t.id
          ) then 1
          else 0
        end asc,
        t.created_at desc,
        t.id asc
      `;
	return db
		.prepare(
			`
      select t.id, t.text, t.media_json, t.entities_json, t.text_en, t.lang
      from tweets t
      where
        (
          t.kind = 'reference'
          or t.id in (
          select tweet_id
          from tweet_collections
          where kind = 'bookmarks'
          )
        )
        ${freshnessPredicate}
      order by ${orderBy}
      limit ?
      `,
		)
		.all(limit) as MetadataCandidate[];
}

function hasMetadata(tweetId: string) {
	const db = getNativeDb({ seedDemoData: false });
	const row = db
		.prepare("select tweet_id from tweet_metadata where tweet_id = ?")
		.get(tweetId);
	return row !== undefined;
}

function upsertMetadata(args: {
	tweetId: string;
	keywords: string[];
	summary: string;
	imageLabels: string[];
	urls: string[];
	model: string;
	generatedAt: string;
}) {
	getNativeDb({ seedDemoData: false })
		.prepare(
			`
      insert into tweet_metadata (
        tweet_id, keywords_json, summary, image_labels_json, urls_json, model,
        generated_at
      ) values (?, ?, ?, ?, ?, ?, ?)
      on conflict(tweet_id) do update set
        keywords_json = excluded.keywords_json,
        summary = excluded.summary,
        image_labels_json = excluded.image_labels_json,
        urls_json = excluded.urls_json,
        model = excluded.model,
        generated_at = excluded.generated_at
      `,
		)
		.run(
			args.tweetId,
			JSON.stringify(args.keywords),
			args.summary,
			JSON.stringify(args.imageLabels),
			JSON.stringify(args.urls),
			args.model,
			args.generatedAt,
		);
}

function translateCandidateIfNeededEffect(
	candidate: MetadataCandidate,
	options: GenerateBookmarkMetadataOptions,
	modelOptions: { model?: string; provider?: AIProvider },
) {
	const shouldTranslate =
		options.refresh || candidate.lang === null || candidate.lang === undefined;
	if (!shouldTranslate) {
		return Effect.succeed(undefined);
	}

	return Effect.gen(function* () {
		const translation = yield* detectAndTranslateTweetEffect(
			{ tweetId: candidate.id, text: candidate.text },
			modelOptions,
		).pipe(Effect.catchAll(() => Effect.succeed(null)));

		if (translation) {
			yield* trySync(() =>
				getNativeDb({ seedDemoData: false })
					.prepare("update tweets set text_en = ?, lang = ? where id = ?")
					.run(translation.textEn, translation.lang, candidate.id),
			);
		}
	});
}

function processCandidateEffect(
	candidate: MetadataCandidate,
	options: GenerateBookmarkMetadataOptions,
) {
	return Effect.gen(function* () {
		const modelOptions = {
			...(options.model ? { model: options.model } : {}),
			...(options.provider ? { provider: options.provider } : {}),
		};
		yield* translateCandidateIfNeededEffect(candidate, options, modelOptions);

		if (!options.refresh && (yield* trySync(() => hasMetadata(candidate.id)))) {
			return "skipped" as const;
		}

		const textMetadata = yield* generateTweetTextMetadataEffect(
			{ tweetId: candidate.id, text: candidate.text },
			modelOptions,
		);
		const media = parseMediaJson(candidate.media_json);
		const imageLabels =
			options.skipImageLabels || media.length === 0
				? []
				: (yield* generateTweetImageLabelsEffect(
						{ tweetId: candidate.id, text: candidate.text, media },
						modelOptions,
					).pipe(Effect.catchAll(() => Effect.succeed({ labels: [] })))).labels;
		const expansionMap = tcoExpansionMap(candidate.entities_json);
		const urls =
			extractUrls(candidate.text).length === 0
				? []
				: uniqueStrings(
						(yield* expandUrlsFromTextsEffect([candidate.text]))
							.map((item) => {
								const resolved = item.finalUrl || item.expandedUrl || item.url;
								if (isTcoUrl(resolved)) {
									return expansionMap.get(item.url) ?? resolved;
								}
								return resolved;
							})
							.filter((value) => !isTcoUrl(value)),
					);

		yield* trySync(() =>
			upsertMetadata({
				tweetId: candidate.id,
				keywords: uniqueStrings(textMetadata.keywords),
				summary: textMetadata.summary,
				imageLabels: uniqueStrings(imageLabels),
				urls,
				model: textMetadata.model,
				generatedAt: new Date().toISOString(),
			}),
		);

		return "generated" as const;
	});
}

export function generateBookmarkMetadataEffect(
	options: GenerateBookmarkMetadataOptions = {},
): Effect.Effect<GenerateBookmarkMetadataSummary, never> {
	return Effect.gen(function* () {
		const limit = options.limit ?? 25;
		const candidates = yield* trySync(() =>
			listMetadataCandidates(limit, Boolean(options.refresh)),
		).pipe(Effect.catchAll(() => Effect.succeed([] as MetadataCandidate[])));
		const summary: GenerateBookmarkMetadataSummary = {
			scanned: candidates.length,
			generated: 0,
			skipped: 0,
			failed: 0,
		};

		for (const candidate of candidates) {
			const result = yield* Effect.either(
				processCandidateEffect(candidate, options),
			);
			if (Either.isLeft(result)) {
				summary.failed += 1;
				summary.errors ??= [];
				summary.errors.push({
					tweetId: candidate.id,
					message: toError(result.left).message,
				});
			} else {
				summary[result.right] += 1;
			}
		}

		return summary;
	});
}

export function generateBookmarkMetadata(
	options: GenerateBookmarkMetadataOptions = {},
): Promise<GenerateBookmarkMetadataSummary> {
	return runEffectPromise(generateBookmarkMetadataEffect(options));
}

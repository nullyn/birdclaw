import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { Effect, Either } from "effect";
import { getNativeDb } from "./db";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import { upsertSavedResource } from "./saved-resources";

const execFileAsync = promisify(execFile);
const GH_TIMEOUT_MS = 30_000;
const GRAPHQL_MAX_BUFFER = 16 * 1024 * 1024;
const README_MAX_BYTES = 1024 * 1024;

export interface SyncGithubStarsOptions {
	maxPages?: number;
	includeReadme?: boolean;
}

export interface GitHubStarsSyncResult {
	account: string;
	count: number;
	newCount: number;
	updatedCount: number;
	partial: boolean;
	warnings: string[];
}

interface GhRunner {
	(args: string[], maxBuffer: number): Promise<string>;
}

interface Repo {
	id: string;
	name: string;
	nameWithOwner: string;
	url: string;
	description: string | null;
	pushedAt: string | null;
	defaultBranchRef: { name: string } | null;
	repositoryTopics: { nodes: Array<{ topic: { name: string } }> };
}

interface StarsPage {
	data?: {
		viewer?: {
			login?: string;
			starredRepositories?: {
				edges: Array<{ starredAt: string; node: Repo }>;
				pageInfo: { hasNextPage: boolean; endCursor: string | null };
			};
		};
	};
	errors?: Array<{ message?: string }>;
}

const GRAPHQL_QUERY = `query($after: String) {
  viewer {
    login
    starredRepositories(first: 100, after: $after, orderBy: {field: STARRED_AT, direction: DESC}) {
      edges {
        starredAt
        node {
          id name nameWithOwner url description pushedAt
          defaultBranchRef { name }
          repositoryTopics(first: 100) { nodes { topic { name } } }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const runGh: GhRunner = async (args, maxBuffer) => {
	const result = await execFileAsync("gh", args, {
		encoding: "utf8",
		timeout: GH_TIMEOUT_MS,
		maxBuffer,
	});
	return result.stdout;
};

function parseJson<T>(value: string, label: string): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		throw new Error(`gh returned invalid ${label} JSON`);
	}
}

function hashText(value: string) {
	return createHash("sha256").update(value).digest("hex");
}

function displayText(
	description: string | null,
	topics: string[],
	readme: string,
) {
	return [
		description?.trim() ?? "",
		topics.length ? `Topics: ${topics.join(", ")}` : "",
		readme,
	]
		.filter(Boolean)
		.join("\n\n");
}

function decodeReadme(content: string) {
	const bytes = Buffer.from(content, "base64");
	if (bytes.byteLength > README_MAX_BYTES) {
		throw new Error(`README exceeds ${README_MAX_BYTES} bytes`);
	}
	return bytes.toString("utf8");
}

function oldReadme(metadataJson: string | undefined) {
	try {
		const metadata = JSON.parse(metadataJson ?? "{}") as { readme?: unknown };
		return typeof metadata.readme === "string" ? metadata.readme : "";
	} catch {
		return "";
	}
}

function errorSummary(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\s+/g, " ").slice(0, 500);
}

function syncGithubStarsEffect(
	options: SyncGithubStarsOptions = {},
	run: GhRunner = runGh,
): Effect.Effect<GitHubStarsSyncResult, unknown> {
	return Effect.gen(function* () {
		if (
			options.maxPages !== undefined &&
			(!Number.isInteger(options.maxPages) || options.maxPages <= 0)
		) {
			return yield* Effect.fail(
				new Error("maxPages must be a positive integer"),
			);
		}
		const warnings: string[] = [];
		const partial = { value: false };
		const accountOutput = yield* tryPromise(() =>
			run(["api", "user", "--jq", ".login"], 64 * 1024),
		);
		const account = accountOutput.trim().replace(/^"|"$/g, "").toLowerCase();
		if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(account)) {
			return yield* Effect.fail(
				new Error("gh api user returned an invalid login"),
			);
		}

		const repos: Array<{ repo: Repo; starredAt: string }> = [];
		let cursor: string | null = null;
		const requestedCursors = new Set<string>();
		let pageCount = 0;
		let hasNext = true;
		while (
			hasNext &&
			(options.maxPages === undefined || pageCount < options.maxPages)
		) {
			const args = ["api", "graphql", "-f", `query=${GRAPHQL_QUERY}`];
			if (cursor) {
				if (requestedCursors.has(cursor)) {
					return yield* Effect.fail(
						new Error("GitHub pagination repeated a cursor"),
					);
				}
				requestedCursors.add(cursor);
				args.push("-F", `after=${cursor}`);
			}
			const output = yield* tryPromise(() => run(args, GRAPHQL_MAX_BUFFER));
			const page = parseJson<StarsPage>(output, "starred repositories");
			if (page.errors?.length) {
				return yield* Effect.fail(
					new Error(
						page.errors
							.map((error) => error.message ?? "GraphQL error")
							.join("; "),
					),
				);
			}
			const viewer = page.data?.viewer;
			if (viewer?.login?.toLowerCase() !== account) {
				return yield* Effect.fail(
					new Error(
						"GitHub authenticated account changed during starred repository sync",
					),
				);
			}
			const connection = viewer.starredRepositories;
			if (!connection) {
				return yield* Effect.fail(
					new Error("gh returned no starred repositories data"),
				);
			}
			repos.push(
				...connection.edges.map((edge) => ({
					repo: edge.node,
					starredAt: edge.starredAt,
				})),
			);
			cursor = connection.pageInfo.endCursor;
			hasNext = connection.pageInfo.hasNextPage;
			pageCount += 1;
			if (hasNext && !cursor)
				return yield* Effect.fail(
					new Error("GitHub pagination returned no cursor"),
				);
			if (hasNext && cursor && requestedCursors.has(cursor))
				return yield* Effect.fail(
					new Error("GitHub pagination repeated a cursor"),
				);
		}
		if (hasNext) {
			partial.value = true;
			warnings.push(
				`Stopped after ${pageCount} page(s); more starred repositories remain.`,
			);
		}

		const db = getNativeDb({ seedDemoData: false });
		let newCount = 0;
		let updatedCount = 0;
		for (const { repo, starredAt } of repos) {
			const previous = db
				.prepare(
					"select metadata_json, content_hash, text from saved_resources where source = 'github' and account = ? and external_id = ?",
				)
				.get(account, repo.id) as
				| { metadata_json: string; content_hash: string; text: string }
				| undefined;
			const topics = (repo.repositoryTopics?.nodes ?? []).map(
				(item) => item.topic.name,
			);
			const oldMetadata = previous?.metadata_json ?? "{}";
			const cachedReadme = oldReadme(oldMetadata);
			let readme = cachedReadme;
			let readmeStatus: "available" | "failed" | "skipped" = "available";
			const branch = repo.defaultBranchRef?.name ?? "";
			let cachedMarkers: {
				pushedAt?: string | null;
				defaultBranch?: string;
				readmeStatus?: string;
			} = {};
			try {
				cachedMarkers = JSON.parse(oldMetadata) as typeof cachedMarkers;
			} catch {
				// Fetch when an old cache row has malformed metadata.
			}
			const shouldFetchReadme =
				options.includeReadme !== false &&
				(!previous ||
					cachedMarkers.pushedAt !== repo.pushedAt ||
					cachedMarkers.defaultBranch !== branch ||
					!cachedReadme ||
					cachedMarkers.readmeStatus === "failed" ||
					cachedMarkers.readmeStatus === "skipped");
			if (shouldFetchReadme) {
				const readmeResult = yield* Effect.either(
					tryPromise(() =>
						run(
							["api", `repos/${repo.nameWithOwner}/readme`, "--jq", ".content"],
							README_MAX_BYTES * 2 + 64 * 1024,
						),
					),
				);
				if (Either.isRight(readmeResult)) {
					try {
						readme = decodeReadme(
							readmeResult.right.trim().replace(/^"|"$/g, ""),
						);
						readmeStatus = "available";
					} catch (error) {
						readmeStatus = "failed";
						partial.value = true;
						warnings.push(
							`README unavailable for ${repo.nameWithOwner}: ${errorSummary(error)}`,
						);
					}
				} else {
					readmeStatus = "failed";
					partial.value = true;
					warnings.push(
						`README unavailable for ${repo.nameWithOwner}: ${errorSummary(readmeResult.left)}`,
					);
				}
			} else if (options.includeReadme === false) {
				readmeStatus = "skipped";
			}
			const text = displayText(repo.description, topics, readme);
			const metadata = {
				githubId: repo.id,
				nameWithOwner: repo.nameWithOwner,
				pushedAt: repo.pushedAt,
				defaultBranch: branch,
				topics,
				starredAt,
				readme,
				readmeStatus,
			};
			const contentHash = hashText(
				`${repo.url}\n${repo.nameWithOwner}\n${text}`,
			);
			if (!previous) newCount += 1;
			else if (previous.content_hash !== contentHash) updatedCount += 1;
			yield* Effect.tryPromise({
				try: () =>
					upsertSavedResource({
						source: "github",
						account,
						externalId: repo.id,
						url: repo.url,
						title: repo.nameWithOwner,
						author: repo.nameWithOwner.split("/")[0] ?? "",
						text,
						savedAt: starredAt,
						fetchedAt: new Date().toISOString(),
						metadata,
						contentHash,
					}),
				catch: (error) => error,
			});
		}
		return {
			account,
			count: repos.length,
			newCount,
			updatedCount,
			partial: partial.value,
			warnings,
		};
	});
}

export function syncGithubStars(options: SyncGithubStarsOptions = {}) {
	return runEffectPromise(syncGithubStarsEffect(options));
}

export function syncGithubStarsUsingRunner(
	options: SyncGithubStarsOptions,
	runner: GhRunner,
) {
	return runEffectPromise(syncGithubStarsEffect(options, runner));
}

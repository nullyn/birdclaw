// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { syncGithubStarsUsingRunner } from "./github-stars";
import { getSavedResource, searchSavedResources } from "./saved-resources";

const tempDirs: string[] = [];
function tempHome() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-github-stars-"));
	tempDirs.push(dir);
	process.env.BIRDCLAW_HOME = dir;
	resetBirdclawPathsForTests();
	return dir;
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	for (const dir of tempDirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function repoPage({
	login = "octo",
	pushedAt = "2026-01-01T00:00:00Z",
	hasNextPage = false,
	endCursor = null as string | null,
} = {}) {
	return JSON.stringify({
		data: {
			viewer: {
				login,
				starredRepositories: {
					edges: [
						{
							starredAt: "2025-01-01T00:00:00Z",
							node: {
								id: "R_1",
								name: "project",
								nameWithOwner: "octo/project",
								url: "https://github.com/octo/project",
								description: "A useful tool",
								pushedAt,
								defaultBranchRef: { name: "main" },
								repositoryTopics: { nodes: [{ topic: { name: "search" } }] },
							},
						},
					],
					pageInfo: { hasNextPage, endCursor },
				},
			},
		},
	});
}

describe("GitHub stars importer", () => {
	it("refreshes a changed README after a metadata-only sync", async () => {
		tempHome();
		let pushedAt = "2026-01-01T00:00:00Z";
		let readmeCalls = 0;
		const runner = async (args: string[]) => {
			if (args[1] === "user") return "octo";
			if (args[1] === "graphql") return repoPage({ pushedAt });
			readmeCalls += 1;
			return Buffer.from(`README updated ${pushedAt}`).toString("base64");
		};
		await syncGithubStarsUsingRunner({}, runner);
		pushedAt = "2026-02-01T00:00:00Z";
		await syncGithubStarsUsingRunner({ includeReadme: false }, runner);
		expect(readmeCalls).toBe(1);
		await syncGithubStarsUsingRunner({}, runner);
		expect(readmeCalls).toBe(2);
		expect((await getSavedResource("github", "octo", "R_1"))?.text).toContain(
			pushedAt,
		);
	});

	it("imports descriptions, topics and README idempotently and scopes rows by account", async () => {
		tempHome();
		let login = "octo";
		let readmeCalls = 0;
		const runner = async (args: string[]) => {
			if (args[1] === "user") return login;
			if (args[1] === "graphql") return repoPage({ login });
			if (args.some((arg) => arg.includes("readme"))) {
				readmeCalls += 1;
				return Buffer.from("# Project README").toString("base64");
			}
			throw new Error(`Unexpected gh args: ${args.join(" ")}`);
		};
		const first = await syncGithubStarsUsingRunner({}, runner);
		expect(first).toMatchObject({
			account: "octo",
			count: 1,
			newCount: 1,
			updatedCount: 0,
			partial: false,
		});
		expect(
			getNativeDb({ seedDemoData: false })
				.prepare("select count(*) as count from accounts")
				.get(),
		).toEqual({ count: 0 });
		const second = await syncGithubStarsUsingRunner({}, runner);
		expect(second).toMatchObject({ count: 1, newCount: 0, updatedCount: 0 });
		expect(readmeCalls).toBe(1);
		expect(
			(await searchSavedResources({ query: "search README" })).map(
				(item) => item.title,
			),
		).toEqual(["octo/project"]);
		login = "another-user";
		await syncGithubStarsUsingRunner({}, runner);
		expect(
			await getSavedResource("github", "another-user", "R_1"),
		).not.toBeNull();
		expect(await getSavedResource("github", "octo", "R_1")).not.toBeNull();
	});

	it("retains cached README and reports partial when refresh fails", async () => {
		tempHome();
		let changed = false;
		const runner = async (args: string[]) => {
			if (args[1] === "user") return "octo";
			if (args[1] === "graphql")
				return repoPage({
					login: "octo",
					pushedAt: changed ? "2026-02-01T00:00:00Z" : undefined,
				});
			if (args.some((arg) => arg.includes("readme"))) {
				if (changed) throw new Error("API unavailable");
				return Buffer.from("durable README text").toString("base64");
			}
			throw new Error("Unexpected gh call");
		};
		await syncGithubStarsUsingRunner({}, runner);
		changed = true;
		const result = await syncGithubStarsUsingRunner({}, runner);
		expect(result.partial).toBe(true);
		expect(result.warnings.join(" ")).toContain("README unavailable");
		const saved = await getSavedResource("github", "octo", "R_1");
		expect(saved?.text).toContain("durable README text");
		expect(saved?.metadata.readmeStatus).toBe("failed");
	});

	it("accepts READMEs up to 1 MiB and preserves cached text above the cap", async () => {
		tempHome();
		let oversized = false;
		let pushedAt = "2026-01-01T00:00:00Z";
		const runner = async (args: string[]) => {
			if (args[1] === "user") return "octo";
			if (args[1] === "graphql") return repoPage({ pushedAt });
			if (args.some((arg) => arg.includes("readme"))) {
				const text = oversized ? "x".repeat(1024 * 1024 + 1) : "cached README";
				return Buffer.from(text).toString("base64");
			}
			throw new Error("Unexpected gh call");
		};
		await syncGithubStarsUsingRunner({}, runner);
		oversized = true;
		pushedAt = "2026-02-01T00:00:00Z";
		const result = await syncGithubStarsUsingRunner({}, runner);
		expect(result.partial).toBe(true);
		expect(result.warnings.join(" ")).toContain("README exceeds 1048576 bytes");
		expect((await getSavedResource("github", "octo", "R_1"))?.text).toContain(
			"cached README",
		);
	});

	it("marks page-limited syncs partial and preserves pagination cursors", async () => {
		tempHome();
		const argsSeen: string[][] = [];
		const runner = async (args: string[]) => {
			argsSeen.push(args);
			if (args[1] === "user") return "octo";
			if (args[1] === "graphql")
				return repoPage({ hasNextPage: true, endCursor: "cursor-1" });
			throw new Error("Should not fetch README when capped before rows? ");
		};
		const result = await syncGithubStarsUsingRunner(
			{ maxPages: 1, includeReadme: false },
			runner,
		);
		expect(result.partial).toBe(true);
		expect(result.warnings[0]).toContain("more starred repositories remain");
		expect(argsSeen.some((args) => args.includes("cursor-1"))).toBe(false);
	});

	it("follows GraphQL cursors until membership is complete", async () => {
		tempHome();
		const graphqlArgs: string[][] = [];
		const runner = async (args: string[]) => {
			if (args[1] === "user") return "octo";
			if (args[1] === "graphql") {
				graphqlArgs.push(args);
				return graphqlArgs.length === 1
					? repoPage({ hasNextPage: true, endCursor: "cursor-1" })
					: JSON.stringify({
							data: {
								viewer: {
									login: "octo",
									starredRepositories: {
										edges: [],
										pageInfo: { hasNextPage: false, endCursor: null },
									},
								},
							},
						});
			}
			throw new Error("Unexpected gh call");
		};
		const result = await syncGithubStarsUsingRunner(
			{ includeReadme: false },
			runner,
		);
		expect(result.partial).toBe(false);
		expect(graphqlArgs).toHaveLength(2);
		expect(graphqlArgs[1]).toContain("after=cursor-1");
	});

	it("rejects invalid page caps and repeated cursors before writing rows", async () => {
		tempHome();
		const runner = async (args: string[]) => {
			if (args[1] === "user") return "octo";
			if (args[1] === "graphql")
				return repoPage({ hasNextPage: true, endCursor: "cursor-repeat" });
			throw new Error("Unexpected gh call");
		};
		await expect(
			syncGithubStarsUsingRunner({ maxPages: 0 }, runner),
		).rejects.toThrow("maxPages must be a positive integer");
		await expect(syncGithubStarsUsingRunner({}, runner)).rejects.toThrow(
			"repeated a cursor",
		);
		expect(await getSavedResource("github", "octo", "R_1")).toBeNull();
	});

	it("fails before import if the GraphQL account differs from gh api user", async () => {
		tempHome();
		const runner = async (args: string[]) => {
			if (args[1] === "user") return "octo";
			if (args[1] === "graphql") return repoPage({ login: "someone-else" });
			throw new Error("Unexpected gh call");
		};
		await expect(syncGithubStarsUsingRunner({}, runner)).rejects.toThrow(
			"account changed",
		);
		expect(await getSavedResource("github", "octo", "R_1")).toBeNull();
	});
});

// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	getSavedResource,
	searchSavedResources,
	upsertSavedResource,
} from "./saved-resources";

const tempDirs: string[] = [];

function setTestHome() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-saved-resources-"));
	tempDirs.push(dir);
	process.env.BIRDCLAW_HOME = dir;
	resetBirdclawPathsForTests();
}

async function addResource(
	source: string,
	account: string,
	externalId: string,
) {
	await upsertSavedResource({
		source,
		account,
		externalId,
		url: `https://example.com/${externalId}`,
		title: `${source} ${externalId}`,
		author: "author",
		text: `Brief description. ${"Unrelated context. ".repeat(40)} The README mentions marzipan observability in detail.`,
		savedAt: "2026-01-01T00:00:00.000Z",
		fetchedAt: "2026-01-02T00:00:00.000Z",
		metadata: {
			readme: "The README mentions marzipan observability in detail.",
		},
		contentHash: externalId,
	});
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("saved resource search", () => {
	it("keeps a fresh library free of demo data when reading and importing resources", async () => {
		setTestHome();
		expect(await getSavedResource("github", "octo", "missing")).toBeNull();
		expect(await searchSavedResources({ query: "README" })).toEqual([]);
		await addResource("github", "octo", "repo-a");
		const db = getNativeDb({ seedDemoData: false });
		for (const table of ["accounts", "tweets", "tweet_collections"])
			expect(
				db.prepare(`select count(*) as count from ${table}`).get(),
			).toEqual({
				count: 0,
			});
		expect(await searchSavedResources({ query: "marzipan" })).toHaveLength(1);
	});

	it("returns a README match excerpt and applies source/account filters", async () => {
		setTestHome();
		await addResource("github", "octo", "repo-a");
		await addResource("github", "other", "repo-b");
		await addResource("instagram", "octo", "post-c");

		const results = await searchSavedResources({
			query: "marzipan observability",
			source: "github",
			account: "octo",
		});
		expect(results).toHaveLength(1);
		expect(results[0]?.externalId).toBe("repo-a");
		expect(results[0]?.excerpt).toContain("marzipan observability");
		expect(results[0]?.excerpt.length).toBeLessThan(
			results[0]?.text.length ?? 0,
		);
	});
});

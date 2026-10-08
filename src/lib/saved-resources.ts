import { Effect } from "effect";
import { getNativeDb } from "./db";
import { runEffectPromise } from "./effect-runtime";

export interface SavedResource {
	source: string;
	account: string;
	externalId: string;
	url: string;
	title: string;
	author: string;
	text: string;
	savedAt: string;
	fetchedAt: string;
	metadata: Record<string, unknown>;
	contentHash: string;
}

export interface SavedResourceSearchOptions {
	query: string;
	source?: string;
	account?: string;
	limit?: number;
}

export interface SavedResourceSearchResult extends SavedResource {
	excerpt: string;
}

function parseResource(row: Record<string, unknown>): SavedResource {
	let metadata: Record<string, unknown> = {};
	try {
		metadata = JSON.parse(String(row.metadata_json ?? "{}")) as Record<
			string,
			unknown
		>;
	} catch {
		// Keep malformed historical metadata readable.
	}
	return {
		source: String(row.source),
		account: String(row.account),
		externalId: String(row.external_id),
		url: String(row.url),
		title: String(row.title),
		author: String(row.author),
		text: String(row.text),
		savedAt: String(row.saved_at),
		fetchedAt: String(row.fetched_at),
		metadata,
		contentHash: String(row.content_hash),
	};
}

export function upsertSavedResource(resource: SavedResource) {
	return runEffectPromise(
		Effect.sync(() => {
			getNativeDb({ seedDemoData: false })
				.prepare(`
        insert into saved_resources (
          source, account, external_id, url, title, author, text,
          saved_at, fetched_at, metadata_json, content_hash
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(source, account, external_id) do update set
          url = excluded.url,
          title = excluded.title,
          author = excluded.author,
          text = excluded.text,
          saved_at = excluded.saved_at,
          fetched_at = excluded.fetched_at,
          metadata_json = excluded.metadata_json,
          content_hash = excluded.content_hash
      `)
				.run(
					resource.source,
					resource.account,
					resource.externalId,
					resource.url,
					resource.title,
					resource.author,
					resource.text,
					resource.savedAt,
					resource.fetchedAt,
					JSON.stringify(resource.metadata),
					resource.contentHash,
				);
		}),
	);
}

export function getSavedResource(
	source: string,
	account: string,
	externalId: string,
) {
	return runEffectPromise(
		Effect.sync(() => {
			const row = getNativeDb({ seedDemoData: false })
				.prepare(
					"select * from saved_resources where source = ? and account = ? and external_id = ?",
				)
				.get(source, account, externalId) as
				| Record<string, unknown>
				| undefined;
			return row ? parseResource(row) : null;
		}),
	);
}

export function searchSavedResources(options: SavedResourceSearchOptions) {
	return runEffectPromise(
		Effect.sync(() => {
			const terms = options.query
				.trim()
				.split(/\s+/)
				.map((term) => term.replace(/["*(){}:^~]/g, ""))
				.filter(Boolean);
			if (terms.length === 0) return [];
			const query = terms.map((term) => `"${term}"`).join(" AND ");
			const filters: string[] = [];
			const params: (string | number)[] = [query];
			if (options.source) {
				filters.push("r.source = ?");
				params.push(options.source);
			}
			if (options.account) {
				filters.push("r.account = ?");
				params.push(options.account);
			}
			params.push(Math.min(200, Math.max(1, options.limit ?? 20)));
			const where = filters.length ? `and ${filters.join(" and ")}` : "";
			const rows = getNativeDb({ seedDemoData: false })
				.prepare(
					`select r.*, snippet(saved_resources_fts, 5, '', '', ' … ', 48) as excerpt
           from saved_resources_fts f
           join saved_resources r on r.rowid = f.rowid
           where saved_resources_fts match ? ${where}
           order by bm25(saved_resources_fts), r.saved_at desc limit ?`,
				)
				.all(...params) as Record<string, unknown>[];
			return rows.map((row) => ({
				...parseResource(row),
				excerpt: String(row.excerpt ?? ""),
			})) satisfies SavedResourceSearchResult[];
		}),
	);
}

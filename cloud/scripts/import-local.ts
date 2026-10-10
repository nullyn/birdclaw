import { readFileSync } from "node:fs";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { loadKnowledgeDocuments } from "../../src/lib/knowledge-passages";
import { getNativeDb } from "../../src/lib/db";

const endpoint = process.env.NALANDA_MCP_URL;
const token =
	process.env.NALANDA_MCP_TOKEN ??
	(process.env.NALANDA_MCP_TOKEN_FILE
		? readFileSync(process.env.NALANDA_MCP_TOKEN_FILE, "utf8").trim()
		: undefined);
if (!endpoint || !token)
	throw new Error(
		"Set NALANDA_MCP_URL and NALANDA_MCP_TOKEN_FILE (or NALANDA_MCP_TOKEN)",
	);
const url = new URL(endpoint);
if (
	url.protocol !== "https:" &&
	url.hostname !== "localhost" &&
	url.hostname !== "127.0.0.1"
)
	throw new Error("Migration requires HTTPS");
const documents = loadKnowledgeDocuments();
const db = getNativeDb({ seedDemoData: false });
const metadata = db
	.prepare(
		"SELECT source,account,external_id,metadata_json FROM saved_resources WHERE source IN ('github','instagram')",
	)
	.all() as Array<{
	source: string;
	account: string;
	external_id: string;
	metadata_json: string;
}>;
const byId = new Map(
	metadata.map((row) => [
		JSON.stringify([row.source, row.account, row.external_id]),
		JSON.parse(row.metadata_json) as Record<string, unknown>,
	]),
);
const client = new Client({ name: "nalanda-archive-migration", version: "1" });
await client.connect(
	new StreamableHTTPClientTransport(url, {
		requestInit: { headers: { Authorization: `Bearer ${token}` } },
	}),
);
let imported = Number(process.env.NALANDA_IMPORT_OFFSET ?? 0);
try {
	const startOffset = Number(process.env.NALANDA_IMPORT_OFFSET ?? 0);
	if (!Number.isInteger(startOffset) || startOffset < 0)
		throw new Error("Invalid import offset");
	for (let offset = startOffset; offset < documents.length; offset += 5) {
		const batch = documents.slice(offset, offset + 5).map((doc) => {
			const extra = byId.get(doc.id) ?? {};
			if (doc.source === "github") {
				const readme = typeof extra.readme === "string" ? extra.readme : "";
				return {
					...doc,
					metadata: {
						pushedAt: extra.pushedAt,
						topics: extra.topics,
						starredAt: extra.starredAt,
						readmeStart: readme
							? doc.text.lastIndexOf(readme) < 0
								? doc.text.length
								: doc.text.lastIndexOf(readme)
							: doc.text.length,
					},
				};
			}
			return { ...doc, metadata: extra };
		});
		const response = await client.callTool({
			name: "nalanda_import",
			arguments: { documents: batch },
		});
		if (response.isError)
			throw new Error(
				`Migration stopped before batch ${offset}; completed batches are durable. Inspect MCP account configuration.`,
			);
		imported += batch.length;
		if (imported % 100 === 0 || imported === documents.length)
			console.log(JSON.stringify({ imported, total: documents.length }));
	}
	console.log(
		JSON.stringify({
			imported,
			total: documents.length,
			processing:
				"queued; check pendingImports and pendingPassages through nalanda_status",
			localArchiveRetained: true,
		}),
	);
} finally {
	await client.close();
}

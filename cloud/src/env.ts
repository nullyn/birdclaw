export interface Env {
	DB: D1Database;
	AI: Ai;
	VECTORS: VectorizeIndex;
	BROWSER: Fetcher;
	JOBS: Queue<{ jobId: string }>;
	MCP_TOKEN: string;
	X_SESSION_COOKIES?: string;
	INSTAGRAM_SESSION_COOKIES?: string;
	X_ACCOUNT: string;
	INSTAGRAM_ACCOUNT: string;
	INSTAGRAM_COLLECTION: string;
	GITHUB_ACCOUNT: string;
	MAX_BROWSER_LAUNCHES_PER_DAY: string;
}

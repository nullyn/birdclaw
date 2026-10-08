import { existsSync, readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import path from "node:path";
import { parseEnv } from "node:util";
import { getBirdclawPaths } from "./config";

export function getTypeSafeApiKey() {
	const key = process.env.TYPESAFE_API_KEY?.trim();
	if (key) return key;
	const manifest = findPackageJSON(import.meta.url);
	for (const file of [
		path.join(getBirdclawPaths().rootDir, ".env"),
		...(manifest ? [path.join(path.dirname(manifest), ".env")] : []),
	]) {
		if (!existsSync(file)) continue;
		const value = parseEnv(readFileSync(file, "utf8")).TYPESAFE_API_KEY?.trim();
		if (value) return value;
	}
	return undefined;
}

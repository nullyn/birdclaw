// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTypeSafeApiKey } from "./typesafe-key";

vi.mock("node:fs", () => ({ existsSync: vi.fn(), readFileSync: vi.fn() }));
vi.mock("node:module", () => ({ findPackageJSON: vi.fn() }));
vi.mock("./config", () => ({
	getBirdclawPaths: () => ({ rootDir: "/nalanda-home" }),
}));

beforeEach(() => {
	vi.mocked(findPackageJSON).mockReturnValue("/nalanda-package/package.json");
});

afterEach(() => {
	vi.resetAllMocks();
	vi.unstubAllEnvs();
});

describe("TypeSafe credentials", () => {
	it("prefers the process environment without reading files", () => {
		vi.stubEnv("TYPESAFE_API_KEY", " process-key ");
		expect(getTypeSafeApiKey()).toBe("process-key");
		expect(existsSync).not.toHaveBeenCalled();
	});

	it("uses the Nalanda home file independently of the agent's working directory", () => {
		vi.stubEnv("TYPESAFE_API_KEY", "");
		vi.mocked(existsSync).mockImplementation(
			(file) => file === "/nalanda-home/.env",
		);
		vi.mocked(readFileSync).mockReturnValue('TYPESAFE_API_KEY="home-key"');
		expect(getTypeSafeApiKey()).toBe("home-key");
		expect(readFileSync).toHaveBeenCalledWith("/nalanda-home/.env", "utf8");
	});

	it("retains the package's ignored .env fallback without reading a caller's .env", () => {
		vi.stubEnv("TYPESAFE_API_KEY", "");
		vi.mocked(existsSync).mockImplementation(
			(file) => file === "/nalanda-package/.env",
		);
		vi.mocked(readFileSync).mockReturnValue("TYPESAFE_API_KEY=package-key");
		expect(getTypeSafeApiKey()).toBe("package-key");
		expect(readFileSync).toHaveBeenCalledWith("/nalanda-package/.env", "utf8");
		expect(findPackageJSON).toHaveBeenCalledWith(
			import.meta.url.replace("typesafe-key.test.ts", "typesafe-key.ts"),
		);
		expect(existsSync).not.toHaveBeenCalledWith(".env");
	});

	it("returns missing when neither stable file has a key", () => {
		vi.stubEnv("TYPESAFE_API_KEY", "");
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockReturnValue("UNRELATED=value");
		expect(getTypeSafeApiKey()).toBeUndefined();
	});
});

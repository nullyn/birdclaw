import {
	configDefaults,
	coverageConfigDefaults,
	defineConfig,
} from "vitest/config";

export default defineConfig({
	resolve: {
		tsconfigPaths: true,
	},
	test: {
		environment: "jsdom",
		setupFiles: ["./src/test/setup.ts"],
		include: ["src/**/*.test.{ts,tsx}"],
		exclude: [
			...configDefaults.exclude,
			"playwright/**/*",
			"src/router.test.ts",
		],
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary", "html"],
			include: ["src/**/*.{ts,tsx}"],
			exclude: [
				...coverageConfigDefaults.exclude,
				"src/routeTree.gen.ts",
				"src/styles.css",
				"src/lib/types.ts",
				"src/routes/*.tsx",
			],
			thresholds: {
				lines: 85,
				functions: 85,
				branches: 80,
				statements: 85,
			},
		},
	},
});

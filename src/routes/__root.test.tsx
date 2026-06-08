import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const appNavProps: Array<{ compact?: boolean }> = vi.hoisted(() => []);

vi.mock("@tanstack/react-router", () => ({
	createRootRoute: (options: Record<string, unknown>) => ({ options }),
	HeadContent: () => null,
	Scripts: () => <div data-testid="scripts" />,
}));

vi.mock("@tanstack/react-devtools", () => ({
	TanStackDevtools: ({
		plugins,
	}: {
		plugins: Array<{ name: string; render: ReactNode }>;
	}) => (
		<div data-testid="devtools">
			{plugins[0]?.name}
			{plugins[0]?.render}
		</div>
	),
}));

vi.mock("@tanstack/react-router-devtools", () => ({
	TanStackRouterDevtoolsPanel: () => (
		<div data-testid="router-devtools-panel">router panel</div>
	),
}));

vi.mock("#/components/AppNav", () => ({
	AppNav: (props: { compact?: boolean }) => {
		appNavProps.push(props);
		return <nav>birdclaw nav {props.compact ? "compact" : "full"}</nav>;
	},
}));

import { Route } from "./__root";

describe("root route", () => {
	it("exposes document metadata and renders shell chrome", () => {
		appNavProps.length = 0;
		const routeOptions = Route.options as unknown as {
			head?: () => unknown;
			shellComponent: ({ children }: { children: ReactNode }) => ReactNode;
		};
		const head = routeOptions.head?.();
		const Shell = routeOptions.shellComponent as ({
			children,
		}: {
			children: ReactNode;
		}) => ReactNode;

		const markup = renderToStaticMarkup(
			<Shell>
				<main>child content</main>
			</Shell>,
		);

		expect(head).toMatchObject({
			meta: expect.arrayContaining([
				expect.objectContaining({ charSet: "utf-8" }),
				expect.objectContaining({ name: "viewport" }),
				expect.objectContaining({ title: "birdclaw" }),
			]),
			links: expect.arrayContaining([
				expect.objectContaining({ rel: "stylesheet" }),
			]),
		});
		expect(markup).toContain("birdclaw nav");
		expect(markup).toContain("max-w-[1280px]");
		expect(markup).toContain("child content");
		expect(markup).toContain('data-testid="scripts"');
		expect(markup).toContain("Tanstack Router");
		expect(markup).toContain("router panel");
		expect(appNavProps).toEqual([{}]);
	});
});

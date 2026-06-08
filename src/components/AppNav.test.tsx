import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "#/lib/theme";

const routerState = vi.hoisted(() => ({ path: "/bookmarks" }));

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		to,
		className,
		...props
	}: {
		children: ReactNode;
		to: string;
		className: string;
		[key: string]: unknown;
	}) => (
		<a className={className} href={to} {...props}>
			{children}
		</a>
	),
	useRouterState: ({
		select,
	}: {
		select: (state: { location: { pathname: string } }) => string;
	}) => select({ location: { pathname: routerState.path } }),
}));

vi.mock("./AccountSwitcher", () => ({
	AccountSwitcher: ({ action }: { action?: ReactNode }) => (
		<div data-testid="account-switcher">{action}</div>
	),
}));

import { AppNav } from "./AppNav";

afterEach(() => {
	routerState.path = "/bookmarks";
	cleanup();
});

describe("AppNav", () => {
	it("marks the active route", () => {
		render(
			<ThemeProvider>
				<AppNav />
			</ThemeProvider>,
		);

		expect(screen.getByRole("link", { name: "Bookmarks" })).toHaveClass(
			"nav-link-active",
		);
		expect(screen.getByRole("link", { name: "Bookmarks" })).toHaveAttribute(
			"aria-label",
			"Bookmarks",
		);
		expect(screen.getByRole("link", { name: "Likes" })).toBeInTheDocument();
		expect(
			screen.getByText("Fast search for your archive."),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: "Theme: System default. Switch to Light theme.",
			}),
		).toBeInTheDocument();
	});

	it("places the theme toggle inside the bottom account picker", () => {
		render(
			<ThemeProvider>
				<AppNav />
			</ThemeProvider>,
		);

		const themeButton = screen.getByRole("button", {
			name: "Theme: System default. Switch to Light theme.",
		});
		const accountSwitcher = screen.getByTestId("account-switcher");

		expect(accountSwitcher).toContainElement(themeButton);
	});

	it("uses icon-rail chrome when compact", () => {
		routerState.path = "/likes";
		render(
			<ThemeProvider>
				<AppNav compact />
			</ThemeProvider>,
		);

		expect(screen.getByRole("link", { name: "Likes" })).toHaveClass(
			"nav-link-active",
		);
		expect(screen.getByRole("link", { name: "Likes" })).toHaveClass(
			"justify-center",
		);
		expect(screen.getByText("birdclaw").parentElement).toHaveClass("sr-only");
		expect(screen.getByText("Likes")).toHaveClass("sr-only");
	});
});

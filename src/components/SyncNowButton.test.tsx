import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRecord } from "#/lib/types";
import { SyncNowButton } from "./SyncNowButton";

const primaryAccount: AccountRecord = {
	id: "acct_primary",
	name: "Primary",
	handle: "me",
	externalUserId: null,
	transport: "auto",
	isDefault: 1,
	createdAt: "2026-01-01T00:00:00.000Z",
};

const accounts: AccountRecord[] = [primaryAccount];

function syncJobResponse(kind: "likes" | "bookmarks", summary: string) {
	return new Response(
		JSON.stringify({
			id: `sync_${kind}_1`,
			kind,
			status: "succeeded",
			startedAt: "2026-05-15T12:00:00.000Z",
			summary,
			inProgress: false,
			result: { ok: true, kind, summary, steps: [] },
		}),
	);
}

describe("SyncNowButton", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		cleanup();
		window.localStorage.clear();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("posts the sync kind with the selected account and reports success", async () => {
		const onSynced = vi.fn();
		const fetchMock = vi.fn(async () =>
			syncJobResponse("bookmarks", "Synced 12 items"),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SyncNowButton
				kind="bookmarks"
				label="Sync bookmarks"
				accounts={accounts}
				onSynced={onSynced}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Sync bookmarks" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/sync",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({
						kind: "bookmarks",
						accountId: "acct_primary",
					}),
				}),
			);
			expect(onSynced).toHaveBeenCalledWith(
				expect.objectContaining({ summary: "Synced 12 items" }),
			);
		});
		expect(screen.getByText("Synced 12 items")).toBeInTheDocument();
	});

	it("keeps an accessible label when the visible text is hidden", () => {
		render(
			<SyncNowButton
				kind="likes"
				label="Sync likes"
				accounts={accounts}
				onSynced={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("button", { name: "Sync likes" }),
		).toBeInTheDocument();
	});

	it("disables the button until accounts load", () => {
		render(
			<SyncNowButton kind="likes" label="Sync likes" onSynced={vi.fn()} />,
		);

		expect(screen.getByRole("button", { name: "Sync likes" })).toBeDisabled();
		expect(screen.getByText("Loading account")).toBeInTheDocument();
	});

	it("shows an account picker when multiple accounts are available", () => {
		const multiAccounts: AccountRecord[] = [
			primaryAccount,
			{ ...primaryAccount, id: "acct_studio", handle: "studio", isDefault: 0 },
		];

		render(
			<SyncNowButton
				kind="bookmarks"
				label="Sync bookmarks"
				accounts={multiAccounts}
				showAccountPicker
				onSynced={vi.fn()}
			/>,
		);

		expect(screen.getByLabelText("Sync account")).toBeInTheDocument();
	});

	it("surfaces an error summary when the sync fails", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						id: "sync_bookmarks_err",
						kind: "bookmarks",
						status: "failed",
						startedAt: "2026-05-15T12:00:00.000Z",
						summary: "sync exploded",
						inProgress: false,
						result: {
							ok: false,
							kind: "bookmarks",
							summary: "sync exploded",
							steps: [],
							error: "sync exploded",
						},
					}),
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SyncNowButton
				kind="bookmarks"
				label="Sync bookmarks"
				accounts={accounts}
				onSynced={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Sync bookmarks" }));

		await waitFor(() => {
			expect(screen.getByText("sync exploded")).toBeInTheDocument();
		});
	});
});

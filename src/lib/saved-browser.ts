/** The local CLI can test the same cloud Chromium used by hosted hydration. */
export async function launchSavedBrowser() {
	const { chromium } = await import("playwright");
	const backend = process.env.NALANDA_BROWSER_BACKEND ?? "chrome";
	if (backend === "chrome")
		return chromium.launch({ channel: "chrome", headless: false });
	if (backend !== "cloudflare")
		throw new Error("NALANDA_BROWSER_BACKEND must be chrome or cloudflare");
	const account = process.env.CLOUDFLARE_ACCOUNT_ID;
	const token = process.env.CLOUDFLARE_API_TOKEN;
	if (!account || !/^[a-f0-9]{32}$/.test(account) || !token)
		throw new Error(
			"Cloud browser requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN",
		);
	try {
		return await chromium.connectOverCDP(
			`wss://api.cloudflare.com/client/v4/accounts/${account}/browser-run/devtools/browser?keep_alive=60000`,
			{ headers: { Authorization: `Bearer ${token}` }, timeout: 30_000 },
		);
	} catch (error) {
		// Playwright diagnostics can contain connection headers. Keep secrets out of logs.
		const status =
			error instanceof Error
				? error.message.match(/(?:status[^\d]*|HTTP\s+)(\d{3})/i)?.[1]
				: undefined;
		throw new Error(
			`Cloudflare browser connection failed${status ? ` (HTTP ${status})` : ""}; check token permissions and free browser quota`,
		);
	}
}

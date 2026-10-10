export function readStandalonePostDom({
	author: targetAuthor,
	origin,
}: {
	author: string;
	origin: string;
}) {
	const root = document.querySelector("main") ?? document.body;
	const author = targetAuthor.toLowerCase();
	const identity = {
		handleFor(anchor: HTMLAnchorElement) {
			return anchor
				.getAttribute("href")
				?.split("/")
				.filter(Boolean)[0]
				?.toLowerCase();
		},
	};
	const commentFilter = {
		isCommentText(value: string) {
			const text = value.replace(/\s+/g, " ").trim();
			return Boolean(
				text &&
				text.replace(/^@/, "").toLowerCase() !== author &&
				!/^\d+\s*(?:s|m|h|d|w|sec(?:ond)?s?|min(?:ute)?s?|hours?|days?|weeks?)(?:\s+ago)?$/i.test(
					text,
				) &&
				!/^(?:reply|like|view all\b|view replies\b)/i.test(text),
			);
		},
	};
	let captionNode: Element | null = null;
	let postTime: HTMLTimeElement | null = null;
	for (const block of root.querySelectorAll("div")) {
		const children = Array.from(block.children);
		const header = children.find(
			(child) =>
				child.tagName === "DIV" &&
				Array.from(
					child.querySelectorAll<HTMLAnchorElement>('a[href^="/"]'),
				).some((anchor) => identity.handleFor(anchor) === author) &&
				Boolean(child.querySelector("time[datetime]")),
		);
		const caption = children.find(
			(child) =>
				child.tagName === "SPAN" &&
				Boolean(child.textContent?.replace(/\s+/g, " ").trim()),
		);
		if (header && caption) {
			captionNode = caption;
			postTime = header.querySelector("time[datetime]");
			break;
		}
	}
	const comments: string[] = [];
	const links = new Set<string>();
	const linkCollector = {
		addLinks(node: Element) {
			for (const anchor of node.querySelectorAll<HTMLAnchorElement>(
				"a[href]",
			)) {
				try {
					const url = new URL(anchor.href, origin);
					if (
						(url.protocol === "http:" || url.protocol === "https:") &&
						url.hostname !== "www.instagram.com" &&
						url.hostname !== "instagram.com"
					)
						links.add(url.href);
				} catch {
					// Ignore malformed or non-web links.
				}
			}
			for (const match of node.textContent?.matchAll(
				/https?:\/\/[^\s<>()]+/g,
			) ?? []) {
				const value = match[0]?.replace(/[.,!?;:)]+$/, "");
				if (value) links.add(value);
			}
		},
	};
	if (captionNode) linkCollector.addLinks(captionNode);
	for (const textNode of root.querySelectorAll<HTMLElement>(
		'span[dir="auto"]',
	)) {
		let commentContainer: HTMLElement | null = textNode.parentElement;
		while (
			commentContainer &&
			!commentContainer.querySelector('a[href*="/c/"]')
		)
			commentContainer = commentContainer.parentElement;
		if (
			!commentContainer ||
			(captionNode && commentContainer.contains(captionNode))
		)
			continue;
		const profileLinks = Array.from(
			commentContainer.querySelectorAll<HTMLAnchorElement>('a[href^="/"]'),
		).filter(
			(anchor) => !/\/(?:p|reel)\//.test(anchor.getAttribute("href") ?? ""),
		);
		const commentAuthor = profileLinks[0];
		if (!commentAuthor || identity.handleFor(commentAuthor) !== author)
			continue;
		const text = textNode.textContent?.replace(/\s+/g, " ").trim() ?? "";
		if (commentFilter.isCommentText(text)) comments.push(text);
		linkCollector.addLinks(textNode);
	}
	return {
		caption: captionNode?.textContent?.replace(/\s+/g, " ").trim() ?? "",
		publishedAt: postTime?.getAttribute("datetime") ?? "",
		comments: [...new Set(comments)],
		links: [...links],
	};
}

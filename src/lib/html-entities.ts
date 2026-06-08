const NAMED: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00a0",
};

export function decodeHtmlEntities(text: string): string {
	return text.replace(
		/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
		(match, body: string) => {
			if (body[0] === "#") {
				const codePoint =
					body[1] === "x" || body[1] === "X"
						? Number.parseInt(body.slice(2), 16)
						: Number.parseInt(body.slice(1), 10);
				if (
					Number.isFinite(codePoint) &&
					codePoint > 0 &&
					codePoint <= 0x10ffff
				) {
					try {
						return String.fromCodePoint(codePoint);
					} catch {
						return match;
					}
				}
				return match;
			}
			const named = NAMED[body.toLowerCase()];
			return named ?? match;
		},
	);
}

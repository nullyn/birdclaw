import { createHash } from "node:crypto";

export interface KnowledgeDocument {
	id: string;
	source: "x" | "github" | "instagram";
	account: string;
	externalId: string;
	url: string;
	title: string;
	author: string;
	text: string;
	publishedAt: string | null;
	publishedAtSource: string | null;
	savedAt: string | null;
	savedAtSource: string | null;
	fetchedAt: string;
}

const CHUNKER_VERSION = "knowledge-passages-v1";
const MAX_PASSAGE_LENGTH = 1600;
const PASSAGE_OVERLAP = 200;

function splitsSurrogatePair(text: string, offset: number) {
	const before = text.charCodeAt(offset - 1);
	const after = text.charCodeAt(offset);
	return (
		before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
	);
}

export function splitKnowledgePassages(
	text: string,
): { text: string; start: number; end: number }[] {
	if (!text.trim()) return [];
	if (text.length <= MAX_PASSAGE_LENGTH) {
		return [{ text, start: 0, end: text.length }];
	}
	const passages: { text: string; start: number; end: number }[] = [];
	let start = 0;
	while (start < text.length) {
		let end = Math.min(start + MAX_PASSAGE_LENGTH, text.length);
		if (end < text.length) {
			const boundary = text.lastIndexOf(" ", end);
			const newlineBoundary = text.lastIndexOf("\n", end);
			const preferred = Math.max(boundary, newlineBoundary);
			if (preferred > start + Math.floor(MAX_PASSAGE_LENGTH / 2))
				end = preferred;
		}
		if (splitsSurrogatePair(text, end)) end -= 1;
		passages.push({ text: text.slice(start, end), start, end });
		if (end === text.length) break;
		let nextStart = Math.max(start + 1, end - PASSAGE_OVERLAP);
		if (splitsSurrogatePair(text, nextStart)) nextStart -= 1;
		if (nextStart <= start) nextStart = start + 2;
		start = nextStart;
	}
	return passages;
}

export function knowledgeContentHash(document: KnowledgeDocument): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				CHUNKER_VERSION,
				document.source,
				document.id,
				document.title,
				document.author,
				document.text,
			]),
		)
		.digest("hex");
}

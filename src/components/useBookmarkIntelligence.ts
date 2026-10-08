import { useEffect, useRef, useState } from "react";
import type { BookmarkIntelligence } from "#/lib/bookmark-intelligence";
import type { TimelineItem } from "#/lib/types";

interface AnalysisResponse {
	items: BookmarkIntelligence[];
	topics: string[];
	requests: number;
	inputTokens: number;
	skippedIds: string[];
}
export function useBookmarkIntelligence(
	items: TimelineItem[],
	account: string | undefined,
	enabled: boolean,
) {
	const [query, setQuery] = useState("");
	const [result, setResult] = useState<{
		scope: string;
		data: AnalysisResponse;
		query: string;
	} | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = items.slice(0, 50).map((item) => item.id);
	const scope = JSON.stringify({ ids, account });
	const scopeRef = useRef(scope);
	scopeRef.current = scope;
	const liveRequestRef = useRef(0);
	const liveControllerRef = useRef<AbortController | null>(null);

	useEffect(() => {
		if (!enabled || !ids.length) return;
		liveControllerRef.current?.abort();
		const controller = new AbortController();
		const requestVersion = ++liveRequestRef.current;
		setBusy(false);
		setError(null);
		void fetch("/api/bookmark-intelligence", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...JSON.parse(scope), cachedOnly: true }),
			signal: controller.signal,
		})
			.then(async (response) => {
				if (!response.ok) return;
				const data: AnalysisResponse = await response.json();
				if (
					!controller.signal.aborted &&
					liveRequestRef.current === requestVersion &&
					scopeRef.current === scope
				)
					setResult({ scope, data, query: "" });
			})
			.catch(() => undefined);
		return () => {
			controller.abort();
			liveControllerRef.current?.abort();
		};
	}, [enabled, scope]);

	async function analyze() {
		if (busy) return;
		const requestVersion = ++liveRequestRef.current;
		const controller = new AbortController();
		liveControllerRef.current = controller;
		const requestedScope = scope;
		const requestedQuery = query.trim();
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/bookmark-intelligence", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ...JSON.parse(scope), query: requestedQuery }),
				signal: controller.signal,
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.message || "JEV analysis failed");
			if (
				!controller.signal.aborted &&
				requestVersion === liveRequestRef.current &&
				scopeRef.current === requestedScope
			)
				setResult({ scope: requestedScope, data, query: requestedQuery });
		} catch (error) {
			if (
				!controller.signal.aborted &&
				requestVersion === liveRequestRef.current &&
				scopeRef.current === requestedScope
			)
				setError(
					error instanceof Error ? error.message : "JEV analysis failed",
				);
		} finally {
			if (requestVersion === liveRequestRef.current) setBusy(false);
		}
	}
	const analysis = result?.scope === scope ? result : null;
	return {
		query,
		setQuery,
		analyze,
		busy,
		error,
		analysis,
		activeQuery: analysis?.query === query.trim() ? analysis.query : "",
	};
}

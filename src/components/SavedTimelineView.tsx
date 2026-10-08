import { useSelectedAccountId } from "./account-selection";
import { useBookmarkIntelligence } from "./useBookmarkIntelligence";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import {
	FeedEmpty,
	FeedError,
	FeedLoading,
	TweetSkeletonRows,
} from "#/components/FeedState";
import { SyncNowButton } from "#/components/SyncNowButton";
import { TimelineCard } from "#/components/TimelineCard";
import { useTimelineRouteData } from "#/components/useTimelineRouteData";
import { ConversationSurfaceScope } from "#/lib/conversation-surface";
import {
	feedClass,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	searchFieldIconClass,
	searchFieldInputClass,
	searchFieldShellClass,
} from "#/lib/ui";

interface SavedTimelineViewProps {
	filter: "liked" | "bookmarked";
	eyebrow: string;
	title: string;
	loadingLabel: string;
	searchPlaceholder: string;
}

const TITLES: Record<SavedTimelineViewProps["filter"], string> = {
	liked: "Likes",
	bookmarked: "Bookmarks",
};

export function SavedTimelineView({
	filter,
	title,
	loadingLabel,
	searchPlaceholder,
}: SavedTimelineViewProps) {
	const [search, setSearch] = useState("");
	const [topic, setTopic] = useState("");
	const {
		meta,
		items,
		loading,
		error,
		retry,
		refreshLocalView,
		replyToTweet,
		hasMore,
		loadingMore,
		loadMore,
	} = useTimelineRouteData({
		resource: "home",
		search,
		errorFallback: `${TITLES[filter]} unavailable`,
		likedOnly: filter === "liked",
		bookmarkedOnly: filter === "bookmarked",
	});

	const subtitle = useMemo(() => {
		if (!meta) {
			return items.length > 0
				? `${String(items.length)} visible`
				: loadingLabel;
		}
		return `${String(items.length)} visible · ${filter === "bookmarked" ? "local bookmarks" : meta.transport.statusText}`;
	}, [items.length, loadingLabel, meta, filter]);

	const syncKind = filter === "liked" ? "likes" : "bookmarks";
	const account = useSelectedAccountId(meta?.accounts);
	const intelligence = useBookmarkIntelligence(
		items,
		account,
		filter === "bookmarked",
	);
	const judgments = new Map(
		intelligence.analysis?.data.items.map((item) => [item.id, item]) ?? [],
	);
	const rankedItems = intelligence.activeQuery
		? [...items].sort(
				(left, right) =>
					(judgments.get(right.id)?.relevance?.score ?? -1) -
					(judgments.get(left.id)?.relevance?.score ?? -1),
			)
		: items;
	const visibleItems = topic
		? rankedItems.filter(
				(item) => (judgments.get(item.id)?.topics[topic] ?? 0) >= 0.8,
			)
		: rankedItems;

	return (
		<>
			<header className={pageHeaderClass}>
				<div className={pageHeaderRowClass}>
					<div className="flex min-w-0 flex-col">
						<h1 className={pageTitleClass}>{TITLES[filter]}</h1>
						<p className={pageSubtitleClass}>{title}</p>
						<p className={pageSubtitleClass}>{subtitle}</p>
					</div>
					<SyncNowButton
						accounts={meta?.accounts}
						kind={syncKind}
						label={filter === "liked" ? "Sync likes" : "Sync bookmarks"}
						onSynced={refreshLocalView}
					/>
				</div>
				<div className="px-4 pb-3">
					<label className={searchFieldShellClass}>
						<Search className={searchFieldIconClass} strokeWidth={2} />
						<input
							className={searchFieldInputClass}
							onChange={(event) => setSearch(event.target.value)}
							placeholder={searchPlaceholder}
							value={search}
						/>
					</label>
				</div>

				{filter === "bookmarked" ? (
					<div className="space-y-2 px-4 pb-3">
						<form
							className="flex gap-2"
							onSubmit={(event) => {
								event.preventDefault();
								void intelligence.analyze();
							}}
						>
							<input
								className={`${searchFieldInputClass} rounded-lg border border-[var(--border)] px-3`}
								aria-label="Rank bookmarks for a question"
								placeholder="Rank loaded bookmarks for… (optional)"
								value={intelligence.query}
								maxLength={500}
								onChange={(event) => intelligence.setQuery(event.target.value)}
							/>
							<button
								className="shrink-0 rounded-full bg-[var(--accent)] px-4 py-1.5 text-sm font-bold text-white disabled:opacity-60"
								disabled={intelligence.busy || loading || items.length === 0}
								type="submit"
							>
								{intelligence.busy ? "Analyzing…" : "Analyze with JEV"}
							</button>
						</form>
						<p className={pageSubtitleClass}>
							Tags and ranking cover the first 50 loaded bookmarks. Cached
							judgments are reused.
						</p>
						{intelligence.activeQuery ? (
							<p className={pageSubtitleClass}>
								Ranked for: {intelligence.activeQuery}
							</p>
						) : null}
						{intelligence.analysis?.data.items.length ? (
							<p className={pageSubtitleClass}>
								{intelligence.analysis.data.items.length} analyzed ·{" "}
								{intelligence.analysis.data.requests} JEV requests ·{" "}
								{intelligence.analysis.data.inputTokens} input tokens
							</p>
						) : null}
						{intelligence.analysis?.data.topics.length ? (
							<select
								className="max-w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm"
								aria-label="Filter analyzed bookmarks by topic"
								value={topic}
								onChange={(event) => setTopic(event.target.value)}
							>
								<option value="">All topics</option>
								{intelligence.analysis.data.topics.map((label) => (
									<option key={label} value={label}>
										{label}
									</option>
								))}
							</select>
						) : null}
						{intelligence.analysis?.data.skippedIds?.length ? (
							<p className={pageSubtitleClass}>
								Some posts are no longer in this account's bookmarks. Refresh
								the collection.
							</p>
						) : null}
						{intelligence.error ? (
							<p role="alert" className="text-sm text-red-500">
								{intelligence.error}
							</p>
						) : null}
					</div>
				) : null}
			</header>
			<ConversationSurfaceScope>
				<section className={feedClass}>
					{loading ? (
						<FeedLoading
							detail={`Reading local ${TITLES[filter].toLowerCase()}`}
							label={loadingLabel}
						>
							<TweetSkeletonRows />
						</FeedLoading>
					) : error ? (
						<FeedError
							action={
								<button
									className="rounded-full bg-[var(--accent)] px-4 py-1.5 text-[14px] font-bold text-white"
									onClick={retry}
									type="button"
								>
									Retry
								</button>
							}
							message={error}
							title={`Could not load ${TITLES[filter].toLowerCase()}`}
						/>
					) : items.length === 0 ? (
						<FeedEmpty
							detail="Sync this collection or broaden the search."
							label="Nothing saved here yet"
						/>
					) : null}
					{topic && !visibleItems.length && !loading ? (
						<FeedEmpty
							label="No analyzed bookmarks in this topic"
							detail="Choose another topic or analyze more loaded bookmarks."
						/>
					) : null}
					{visibleItems.map((item) => (
						<div key={item.id}>
							{judgments.has(item.id) ? (
								<div className="flex flex-wrap gap-2 px-4 pt-3 text-xs text-[var(--muted)]">
									{Object.entries(judgments.get(item.id)!.topics)
										.filter(([, probability]) => probability >= 0.8)
										.map(([topic, probability]) => (
											<span
												key={topic}
												className="rounded-full border border-[var(--border)] px-2 py-1"
												title={`JEV topic probability: ${Math.round(probability * 100)}%`}
											>
												{topic}
											</span>
										))}
									{intelligence.activeQuery &&
									judgments.get(item.id)?.relevance ? (
										<span>
											Relevance{" "}
											{judgments.get(item.id)!.relevance!.score.toFixed(1)}/4 ·
											confidence{" "}
											{Math.round(
												judgments.get(item.id)!.relevance!.confidence * 100,
											)}
											%
										</span>
									) : null}
								</div>
							) : null}
							<TimelineCard
								key={item.id}
								item={item}
								onReply={replyToTweet}
								showReplyControls={false}
							/>
						</div>
					))}
					{!loading && !error && hasMore ? (
						<div className="flex justify-center py-4">
							<button
								className="rounded-full bg-[var(--accent)] px-5 py-1.5 text-[14px] font-bold text-white disabled:opacity-60"
								disabled={loadingMore}
								onClick={loadMore}
								type="button"
							>
								{loadingMore ? "Loading…" : "Load more"}
							</button>
						</div>
					) : null}
				</section>
			</ConversationSurfaceScope>
		</>
	);
}

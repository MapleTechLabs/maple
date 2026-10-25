import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { isSameFailure, type LoadFailure } from "../../../data/load-failure"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import { skeleton } from "../../../ui/skeleton"
import { statusDot } from "../../../ui/status-dot"
import { sectionHeading } from "../../kit/section-heading"
import type { TimeSearch } from "../kit/view-tabs"
import { findingHref } from "./links"
import type { Finding, SourceId } from "./model"
import { sourceMark, SOURCE_TITLE } from "./source-mark"
import type { SourceState } from "./state"

// `NeedsAttention` and its rows.

// A stale source is an outline, not a status fill.
const STALE_DOT = "border-[1.5px] border-muted-foreground bg-transparent"

export const ROW_CLASS =
	"group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"

export const FINDINGS_LIST_CLASS = "flex flex-col overflow-hidden rounded-md border"
const FINDINGS_ROW_CLASS = "-mt-px border-t"

/** Errors sit after warnings: a source we couldn't check outranks one that went quiet. */
const RANK = { crit: 0, warn: 1, error: 2, stale: 3 } as const

/** Loading rows while any source is still reading; the list then lands once, sorted. */
const LOADING_ROWS = 2

const sourceLabel = <M>(h: HtmlBuilder<M>, id: SourceId): Html =>
	h.span(
		[h.Class("flex w-32 shrink-0 items-center gap-2 text-xs text-muted-foreground")],
		[sourceMark(h, id, 14), SOURCE_TITLE[id]],
	)

/** The name truncates; the metric after it ("at 97% CPU") always stays visible. */
const findingTitle = <M>(h: HtmlBuilder<M>, { subject, title }: Finding): Html =>
	subject === undefined || subject === "" || !title.startsWith(subject)
		? h.span([h.Class("truncate text-sm text-foreground group-hover:text-primary"), h.Title(title)], [title])
		: h.span(
				[h.Class("flex min-w-0 text-sm text-foreground group-hover:text-primary"), h.Title(title)],
				[
					h.span([h.Class("truncate")], [subject]),
					h.span([h.Class("shrink-0 whitespace-pre tabular-nums")], [title.slice(subject.length)]),
				],
			)

export const findingRow = <M>(h: HtmlBuilder<M>, finding: Finding, time: TimeSearch): Html =>
	h.a(
		[h.Class(cn(ROW_CLASS, FINDINGS_ROW_CLASS)), h.Href(findingHref(finding.target, time))],
		[
			finding.tone === "stale"
				? statusDot(h, { tone: "custom", size: "lg", className: STALE_DOT })
				: statusDot(h, { tone: finding.tone, size: "lg" }),
			sourceLabel(h, finding.source),
			h.span(
				[h.Class("flex min-w-0 flex-1 flex-col gap-0.5")],
				[findingTitle(h, finding), h.span([h.Class("truncate text-xs text-muted-foreground")], [finding.detail])],
			),
			icon(h, "ChevronRightIcon", { size: 14, className: "shrink-0 text-muted-foreground" }),
		],
	)

const findingRowLoading = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[h.Class(cn("flex items-center gap-4 px-4 py-3", FINDINGS_ROW_CLASS))],
		[
			skeleton(h, "size-2 shrink-0 rounded-full"),
			h.span([h.Class("flex w-32 shrink-0 items-center")], [skeleton(h, "h-3 w-20")]),
			h.span(
				[h.Class("flex min-w-0 flex-1 flex-col gap-0.5")],
				[skeleton(h, "my-0.5 h-4 w-64 max-w-full"), skeleton(h, "my-0.5 h-3 w-40 max-w-full")],
			),
		],
	)

/** A source we couldn't read is not an all-clear, so it gets a row of its own. */
const findingRowError = <M>(h: HtmlBuilder<M>, id: SourceId): Html =>
	h.div(
		[h.Class(cn("flex items-center gap-4 px-4 py-3", FINDINGS_ROW_CLASS))],
		[
			statusDot(h, { tone: "neutral", size: "lg" }),
			sourceLabel(h, id),
			h.span([h.Class("text-sm text-muted-foreground")], ["Couldn't check this source. Its page shows the error."]),
		],
	)

type Entry = Readonly<{ rank: number; row: Html }>

const entriesOf = <M>(
	h: HtmlBuilder<M>,
	id: SourceId,
	state: SourceState,
	time: TimeSearch,
): ReadonlyArray<Entry> =>
	state.status === "ready"
		? state.summary.findings.map((finding) => ({
				rank: RANK[finding.tone],
				row: findingRow(h, finding, time),
			}))
		: state.status === "error"
			? [{ rank: RANK.error, row: findingRowError(h, id) }]
			: []

/** Every source failed for one reason: that reason once, instead of a row per source. */
const sharedFailure = (
	sources: ReadonlyArray<Readonly<{ id: SourceId; state: SourceState }>>,
): LoadFailure | undefined => {
	const failures = sources.flatMap(({ state }) =>
		state.status === "error" && state.failure !== undefined ? [state.failure] : [],
	)
	const [first] = failures
	return first !== undefined &&
		sources.length > 1 &&
		failures.length === sources.length &&
		failures.every((failure) => isSameFailure(failure, first))
		? first
		: undefined
}

const findingsList = <M>(h: HtmlBuilder<M>, rows: ReadonlyArray<Html>): Html =>
	h.div([h.Class(FINDINGS_LIST_CLASS)], rows)

/** The loading block, also shown while which sources the org has is still pending. */
const needsAttentionLoading = <M>(h: HtmlBuilder<M>): Html =>
	findingsList(
		h,
		Array.from({ length: LOADING_ROWS }, () => findingRowLoading(h)),
	)

/**
 * Every present source's findings in one list, worst first. It waits for every source, so it
 * lays out once instead of growing and reordering as each answers.
 */
export const needsAttention = <M>(
	h: HtmlBuilder<M>,
	sources: ReadonlyArray<Readonly<{ id: SourceId; state: SourceState }>> | null,
	time: TimeSearch,
): Html => {
	const isSettled = sources !== null && sources.every(({ state }) => state.status !== "loading")
	const rows = isSettled
		? sources
				.flatMap(({ id, state }) => entriesOf(h, id, state, time))
				.toSorted((a, b) => a.rank - b.rank)
				.map(({ row }) => row)
		: []
	const shared = isSettled ? sharedFailure(sources) : undefined
	return h.section(
		[h.Class("space-y-3")],
		[
			sectionHeading(h, { title: "Needs attention", hint: "across every source, worst first" }),
			!isSettled
				? needsAttentionLoading(h)
				: shared !== undefined
					? errorState(h, { failure: shared, variant: "row" })
					: rows.length > 0
					? findingsList(h, rows)
					: h.p(
							[
								h.Class(
									"rounded-md border px-4 py-6 text-center text-sm text-muted-foreground",
								),
							],
							["Nothing is over its thresholds in this window."],
						),
		],
	)
}

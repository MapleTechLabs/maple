import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
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
const FINDING_ORDER = {
	crit: "order-1",
	warn: "order-2",
	error: "order-3",
	stale: "order-4",
	loading: "order-5",
} as const

const sourceLabel = <M>(h: HtmlBuilder<M>, id: SourceId): Html =>
	h.span(
		[h.Class("flex w-32 shrink-0 items-center gap-2 text-xs text-muted-foreground")],
		[sourceMark(h, id, 14), SOURCE_TITLE[id]],
	)

/** The name truncates; the metric after it ("at 97% CPU") always stays visible. */
const findingTitle = <M>(h: HtmlBuilder<M>, { subject, title }: Finding): Html =>
	subject === undefined || subject === "" || !title.startsWith(subject)
		? h.span(
				[h.Class("truncate text-sm text-foreground group-hover:text-primary"), h.Title(title)],
				[title],
			)
		: h.span(
				[h.Class("flex min-w-0 text-sm text-foreground group-hover:text-primary"), h.Title(title)],
				[
					h.span([h.Class("truncate")], [subject]),
					h.span([h.Class("shrink-0 whitespace-pre tabular-nums")], [title.slice(subject.length)]),
				],
			)

export const findingRow = <M>(h: HtmlBuilder<M>, finding: Finding, time: TimeSearch): Html =>
	h.a(
		[
			h.Class(cn(ROW_CLASS, FINDINGS_ROW_CLASS, FINDING_ORDER[finding.tone])),
			h.Href(findingHref(finding.target, time)),
		],
		[
			finding.tone === "stale"
				? statusDot(h, { tone: "custom", size: "lg", className: STALE_DOT })
				: statusDot(h, { tone: finding.tone, size: "lg" }),
			sourceLabel(h, finding.source),
			h.span(
				[h.Class("flex min-w-0 flex-1 flex-col gap-0.5")],
				[
					findingTitle(h, finding),
					h.span([h.Class("truncate text-xs text-muted-foreground")], [finding.detail]),
				],
			),
			icon(h, "ChevronRightIcon", { size: 14, className: "shrink-0 text-muted-foreground" }),
		],
	)

const findingRowLoading = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[h.Class(cn("flex items-center gap-4 px-4 py-3", FINDINGS_ROW_CLASS, FINDING_ORDER.loading))],
		[skeleton(h, "size-2 rounded-full"), skeleton(h, "h-3 w-28"), skeleton(h, "h-4 w-64")],
	)

/** A source we couldn't read is not an all-clear, so it gets a row of its own. */
const findingRowError = <M>(h: HtmlBuilder<M>, id: SourceId): Html =>
	h.div(
		[h.Class(cn("flex items-center gap-4 px-4 py-3", FINDINGS_ROW_CLASS, FINDING_ORDER.error))],
		[
			statusDot(h, { tone: "neutral", size: "lg" }),
			sourceLabel(h, id),
			h.span(
				[h.Class("text-sm text-muted-foreground")],
				["Couldn't check this source. Its page shows the error."],
			),
		],
	)

const rowsOf = <M>(
	h: HtmlBuilder<M>,
	id: SourceId,
	state: SourceState,
	time: TimeSearch,
): ReadonlyArray<Html> =>
	state.status === "ready"
		? state.summary.findings.map((finding) => findingRow(h, finding, time))
		: state.status === "loading"
			? [findingRowLoading(h)]
			: [findingRowError(h, id)]

/** Every present source's findings in one list; an empty list gives way to the all-clear line. */
export const needsAttention = <M>(
	h: HtmlBuilder<M>,
	sources: ReadonlyArray<Readonly<{ id: SourceId; state: SourceState }>>,
	time: TimeSearch,
): Html =>
	h.section(
		[h.Class("space-y-3")],
		[
			sectionHeading(h, { title: "Needs attention", hint: "across every source, worst first" }),
			h.div(
				[h.Class(cn("peer empty:hidden", FINDINGS_LIST_CLASS))],
				sources.flatMap(({ id, state }) => rowsOf(h, id, state, time)),
			),
			h.p(
				[
					h.Class(
						"hidden rounded-md border px-4 py-6 text-center text-sm text-muted-foreground peer-empty:block",
					),
				],
				["Nothing is over its thresholds in this window."],
			),
		],
	)

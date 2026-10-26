import { VALUE_TONE } from "../../../components/infra/severity-tokens"
import { formatNumber } from "@maple/ui/lib/format"
import { TONE_FILL } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../../ui/icon"
import { segmentedBar } from "../../../ui/meter"
import { panel } from "../../../ui/panel"
import { skeleton } from "../../../ui/skeleton"
import { sectionHeading } from "../../kit/section-heading"
import type { TimeSearch } from "../kit/view-tabs"
import { sourceHref } from "./links"
import type { HealthSegment, SourceId } from "./model"
import { sourceMark, SOURCE_TITLE } from "./source-mark"
import type { SourceState } from "./state"
import { ROW_CLASS, sectionCaption } from "./view-findings"

// `SourcesTable`, `SourceRowBody` and `HealthBar`.

const SEGMENT_CLASS = {
	ok: TONE_FILL.ok,
	elevated: TONE_FILL.warn,
	saturated: TONE_FILL.crit,
	// Hatched, not a fill: there is no limit to measure against.
	unbounded:
		"bg-[repeating-linear-gradient(135deg,var(--muted-foreground)_0_1.5px,transparent_1.5px_4px)] opacity-60",
	// Healthy but barely used: muted, not a warning.
	idle: "bg-muted-foreground/40",
} satisfies Record<HealthSegment["key"], string>

const SEGMENT_LABEL = {
	ok: "ok",
	elevated: "elevated",
	saturated: "saturated",
	unbounded: "no limit",
	idle: "idle",
} satisfies Record<HealthSegment["key"], string>

const healthBar = <M>(h: HtmlBuilder<M>, segments: ReadonlyArray<HealthSegment>): Html => {
	const drawn = segments.filter((segment) => segment.count > 0)
	return h.div(
		[h.Class("flex flex-col gap-1.5")],
		[
			segmentedBar(h, {
				className: "w-full gap-px bg-muted",
				minVisible: 2,
				segments: drawn.map((segment) => ({
					key: segment.key,
					value: segment.count,
					className: SEGMENT_CLASS[segment.key],
				})),
			}),
			h.span(
				[h.Class("flex gap-3 text-2xs text-muted-foreground tabular-nums")],
				drawn.map((segment) =>
					h.span([], [formatNumber(segment.count), " ", SEGMENT_LABEL[segment.key]]),
				),
			),
		],
	)
}

/** `healthBar`'s shape while loading: the bar and an empty legend line, so the row keeps its height. */
const healthBarLoading = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[h.Class("flex flex-col gap-1.5")],
		[skeleton(h, "h-1.5 w-full rounded-full"), h.span([h.Class("text-2xs")], ["\u00a0"])],
	)

/** `isFailureExplained`: the page already shows the one failure every source shares. */
export const sourceRow = <M>(
	h: HtmlBuilder<M>,
	id: SourceId,
	state: SourceState,
	time: TimeSearch,
	isFailureExplained = false,
): Html => {
	const isQuietFailure = isFailureExplained && state.status === "error"
	return h.a(
		[h.Class(cn(ROW_CLASS, "py-3.5", isQuietFailure && "opacity-70")), h.Href(sourceHref(id, time))],
		[
			h.span(
				[h.Class("flex w-52 shrink-0 items-center gap-3")],
				[
					sourceMark(h, id, 18),
					h.span(
						[h.Class("flex min-w-0 flex-col gap-0.5")],
						[
							h.span(
								[h.Class("text-sm text-foreground group-hover:text-primary")],
								[SOURCE_TITLE[id]],
							),
							...(isQuietFailure
								? []
								: [
										state.status === "loading"
											? skeleton(h, "my-0.5 h-3 w-16")
											: h.span(
													[h.Class("text-xs text-muted-foreground")],
													[
														state.status === "ready"
															? state.summary.resources
															: "Couldn't load",
													],
												),
									]),
						],
					),
				],
			),
			h.span(
				[h.Class("hidden min-w-0 flex-1 pr-6 md:block")],
				state.status === "ready"
					? [healthBar(h, state.summary.segments)]
					: state.status === "loading"
						? [healthBarLoading(h)]
						: [],
			),
			state.status === "loading"
				? h.span(
						[h.Class("flex min-w-0 flex-1 md:w-64 md:flex-none")],
						[skeleton(h, "my-0.5 h-3 w-40 max-w-full")],
					)
				: h.span(
						[
							h.Class(
								cn(
									"min-w-0 flex-1 truncate text-xs md:w-64 md:flex-none",
									state.status === "ready"
										? VALUE_TONE[state.summary.headlineTone]
										: "text-muted-foreground",
								),
							),
						],
						// A failed row already says "Couldn't load" (or the page banner does); the chevron leads to the details.
						[state.status === "ready" ? state.summary.headline : ""],
					),
			icon(h, "ChevronRightIcon", { size: 14, className: "shrink-0 text-muted-foreground" }),
		],
	)
}

/** A source row before the org's sources are known: same height, no name yet. */
const sourceRowPending = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[h.Class("flex items-center gap-4 px-4 py-3.5")],
		[
			h.span(
				[h.Class("flex w-52 shrink-0 items-center gap-3")],
				[
					skeleton(h, "size-[18px] shrink-0 rounded"),
					h.span(
						[h.Class("flex min-w-0 flex-col gap-0.5")],
						[skeleton(h, "my-0.5 h-4 w-24"), skeleton(h, "my-0.5 h-3 w-16")],
					),
				],
			),
			h.span([h.Class("hidden min-w-0 flex-1 pr-6 md:block")], [healthBarLoading(h)]),
			h.span(
				[h.Class("flex min-w-0 flex-1 md:w-64 md:flex-none")],
				[skeleton(h, "my-0.5 h-3 w-40 max-w-full")],
			),
		],
	)

/** Rows the pending table holds: a typical org's count, so the real table mostly lands in place. */
const PENDING_ROWS = 3

export const sourcesTable = <M>(
	h: HtmlBuilder<M>,
	sources: ReadonlyArray<Readonly<{ id: SourceId; state: SourceState }>> | null,
	time: TimeSearch,
	isFailureExplained = false,
): Html =>
	h.section(
		[h.Class("space-y-3")],
		[
			sectionHeading(h, {
				title: "Sources",
				badge: sectionCaption(h, "one row per source reporting to this org"),
			}),
			panel(
				h,
				{ tone: "background", className: "divide-y" },
				sources === null
					? Array.from({ length: PENDING_ROWS }, () => sourceRowPending(h))
					: sources.map(({ id, state }) => sourceRow(h, id, state, time, isFailureExplained)),
			),
		],
	)

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
import { ROW_CLASS } from "./view-findings"

// `SourcesTable`, `SourceRowBody` and `HealthBar`.

const SEGMENT_CLASS = {
	ok: TONE_FILL.ok,
	elevated: TONE_FILL.warn,
	saturated: TONE_FILL.crit,
	// Hatched, not a fill: there is no limit to measure against.
	unbounded:
		"bg-[repeating-linear-gradient(135deg,var(--muted-foreground)_0_1.5px,transparent_1.5px_4px)] opacity-60",
} satisfies Record<HealthSegment["key"], string>

const SEGMENT_LABEL = {
	ok: "ok",
	elevated: "elevated",
	saturated: "saturated",
	unbounded: "no limit",
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
				drawn.map((segment) => h.span([], [formatNumber(segment.count), " ", SEGMENT_LABEL[segment.key]])),
			),
		],
	)
}

export const sourceRow = <M>(h: HtmlBuilder<M>, id: SourceId, state: SourceState, time: TimeSearch): Html =>
	h.a(
		[h.Class(cn(ROW_CLASS, "py-3.5")), h.Href(sourceHref(id, time))],
		[
			h.span(
				[h.Class("flex w-52 shrink-0 items-center gap-3")],
				[
					sourceMark(h, id, 18),
					h.span(
						[h.Class("flex min-w-0 flex-col gap-0.5")],
						[
							h.span([h.Class("text-sm text-foreground group-hover:text-primary")], [SOURCE_TITLE[id]]),
							h.span(
								[h.Class("text-xs text-muted-foreground")],
								[state.status === "ready" ? state.summary.resources : state.status === "error" ? "Couldn't load" : " "],
							),
						],
					),
				],
			),
			h.span(
				[h.Class("hidden min-w-0 flex-1 pr-6 md:block")],
				state.status === "ready"
					? [healthBar(h, state.summary.segments)]
					: state.status === "loading"
						? [skeleton(h, "h-1.5 w-full rounded-full")]
						: [],
			),
			h.span(
				[
					h.Class(
						cn(
							"min-w-0 flex-1 truncate text-xs md:w-64 md:flex-none",
							state.status === "ready" ? VALUE_TONE[state.summary.headlineTone] : "text-muted-foreground",
						),
					),
				],
				[
					state.status === "ready"
						? state.summary.headline
						: state.status === "loading"
							? skeleton(h, "h-3 w-40")
							: "Open the page for details",
				],
			),
			icon(h, "ChevronRightIcon", { size: 14, className: "shrink-0 text-muted-foreground" }),
		],
	)

export const sourcesTable = <M>(
	h: HtmlBuilder<M>,
	sources: ReadonlyArray<Readonly<{ id: SourceId; state: SourceState }>>,
	time: TimeSearch,
): Html =>
	h.section(
		[h.Class("space-y-3")],
		[
			sectionHeading(h, { title: "Sources", hint: "one row per source reporting to this org" }),
			panel(
				h,
				{ tone: "background", className: "divide-y" },
				sources.map(({ id, state }) => sourceRow(h, id, state, time)),
			),
		],
	)

import { cn } from "@maple/ui/lib/utils"
import { icon } from "@maple/views/ui/icon"
import { Array as Arr, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { makeStaticIsland, type StaticMessage } from "../../foldkit-island/island"
import {
	COST_SOURCES,
	type CostSource,
	PLANNED_COST_SOURCES,
	type PlannedCostSource,
} from "../../lib/cost-sources"

// The cost sources Maple reads, one tile each, and under them the planned ones by mark and name.
// The facts are `lib/cost-sources.ts`; the labels are prose, so the section passes them translated.

const Props = Schema.Struct({
	availableLabel: Schema.String,
	plannedLabel: Schema.String,
	docsLabel: Schema.String,
})
type Props = typeof Props.Type

type H = HtmlBuilder<StaticMessage>

const mark = (h: H, source: Pick<CostSource, "icon" | "iconClassName">): Html =>
	h.span(
		[
			h.Class(
				"inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-bg-elevated",
			),
		],
		[icon(h, source.icon, { size: 16, className: cn("shrink-0", source.iconClassName) })],
	)

const fact = (h: H, key: string, value: string): Html =>
	h.div(
		[h.Class("flex items-baseline justify-between gap-4 py-1.5")],
		[
			h.dt([h.Class("shrink-0 text-fg-muted")], [key]),
			h.dd([h.Class("min-w-0 text-right text-fg")], [value]),
		],
	)

const tile = (h: H, source: CostSource, docsLabel: string): Html =>
	h.li(
		[h.Key(source.name), h.Class("flex flex-col bg-bg p-5")],
		[
			h.div(
				[h.Class("flex items-center gap-3")],
				[mark(h, source), h.h3([h.Class("text-[15px] font-medium text-fg")], [source.name])],
			),
			h.dl(
				[h.Class("mt-4 divide-y divide-border border-y border-border font-mono text-[11px]")],
				[
					fact(h, "reads", source.reads),
					fact(h, "splits.by", source.splitsBy),
					fact(h, "added.with", source.addedWith),
					fact(h, "history", source.history),
				],
			),
			...(source.docs === undefined
				? []
				: [
						h.a(
							[
								h.Href(source.docs),
								h.Class(
									"mt-4 inline-flex w-fit text-[13px] text-fg-muted transition-colors hover:text-fg",
								),
							],
							[`${source.name} ${docsLabel}`],
						),
					]),
		],
	)

const plannedTile = (h: H, source: PlannedCostSource): Html =>
	h.li(
		[h.Key(source.name), h.Class("flex items-center gap-3 bg-bg px-5 py-4")],
		[
			mark(h, source),
			h.div(
				[h.Class("min-w-0")],
				[
					h.h3([h.Class("truncate text-[15px] font-medium text-fg")], [source.name]),
					h.p([h.Class("font-mono text-[11px] text-fg-muted")], [source.kind]),
				],
			),
		],
	)

const GRID =
	"grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4"

const label = (h: H, text: string, count: number, className?: string): Html =>
	h.p(
		[h.Class(cn("mb-4 flex items-baseline gap-2 text-[13px] font-medium text-fg", className))],
		[text, h.span([h.Class("font-mono text-[11px] font-normal text-fg-muted")], [String(count)])],
	)

const view = (model: Props, h: H): Html =>
	h.div(
		[],
		[
			label(h, model.availableLabel, COST_SOURCES.length),
			h.ul(
				[h.Class(GRID)],
				Arr.map(COST_SOURCES, (source) => tile(h, source, model.docsLabel)),
			),
			label(h, model.plannedLabel, PLANNED_COST_SOURCES.length, "mt-12"),
			h.ul(
				[h.Class(GRID)],
				Arr.map(PLANNED_COST_SOURCES, (source) => plannedTile(h, source)),
			),
		],
	)

export const LiveCostSources = makeStaticIsland({ name: "live-cost-sources", Props, view })

import { Schema, Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { makeIsland } from "../foldkit-island/island"
import { brandMark, markColor, type BrandMarkId } from "../lib/brand-marks"
import { vendorConfigs } from "../lib/vendor-pricing"
import { calculatorView, type Competitor, initModel, Message, Model, update } from "./PricingCalculator"

const COMPETITORS: ReadonlyArray<Competitor> = [
	"datadog",
	"grafana",
	"new-relic",
	"dash0",
	"openobserve",
	"signoz",
]

const MARKS = {
	datadog: "datadog",
	grafana: "grafana",
	"new-relic": "newrelic",
	dash0: "dash0",
	openobserve: "openobserve",
	signoz: "signoz",
	axiom: "axiom",
	"better-stack": "betterstack",
	honeycomb: "honeycomb",
} satisfies Record<Competitor, BrandMarkId>

type H = HtmlBuilder<Message>

/** The vendor's mark in its brand colour; on the active (amber) tab it takes the tab's foreground instead. */
const vendorMark = (h: H, id: BrandMarkId, isActive: boolean): Html => {
	const mark = brandMark(id)
	const { layers, overlay } = mark
	return h.svg(
		[
			h.ViewBox(mark.viewBox ?? "0 0 24 24"),
			h.Class("h-3.5 w-3.5 shrink-0"),
			...(isActive ? [] : [h.Style({ color: markColor(mark) })]),
			h.Fill("currentColor"),
			h.AriaHidden(true),
		],
		[
			...(layers !== undefined && !isActive
				? Arr.map(layers, (layer) => h.path([h.D(layer.path), h.Fill(layer.fill)], []))
				: [h.path([h.D(mark.path)], [])]),
			...(overlay === undefined
				? []
				: [
						h.path(
							[
								h.D(overlay.path),
								h.Fill(overlay.fill),
								...(overlay.fillRule === undefined ? [] : [h.FillRule(overlay.fillRule)]),
							],
							[],
						),
					]),
		],
	)
}

const competitorTab = (h: H, competitor: Competitor, isActive: boolean): Html =>
	h.button(
		[
			h.Key(competitor),
			h.Type("button"),
			h.Role("tab"),
			h.AriaSelected(isActive),
			h.OnClick(Message.SelectedCompetitor({ competitor })),
			h.Class(
				`inline-flex h-8 items-center gap-2 rounded-lg pl-2.5 pr-3 text-xs font-medium transition-colors ${
					isActive
						? "bg-primary text-primary-foreground"
						: "border border-border bg-bg text-fg-muted hover:bg-bg-elevated hover:text-fg"
				}`,
			),
		],
		[vendorMark(h, MARKS[competitor], isActive), vendorConfigs[competitor].name],
	)

/** The calculator under a competitor switcher, so /pricing compares Maple against any vendor. */
const view = (model: Model, h: H): Html =>
	h.div(
		[],
		[
			h.div(
				[h.Class("mb-3 flex flex-wrap items-center gap-x-4 gap-y-2")],
				[
					h.span(
						[h.Class("text-[10px] uppercase tracking-wider text-fg-muted")],
						["Compare against"],
					),
					h.div(
						[
							h.Role("tablist"),
							h.AriaLabel("Compare against"),
							h.Class("inline-flex flex-wrap gap-1"),
						],
						Arr.map(COMPETITORS, (c) => competitorTab(h, c, c === model.competitor)),
					),
				],
			),
			calculatorView(model, h),
		],
	)

export const PricingComparisonCalculator = makeIsland({
	name: "pricing-comparison-calculator",
	Props: Schema.Struct({}),
	Model,
	init: () => ({ model: initModel("datadog", false) }),
	update,
	view,
})

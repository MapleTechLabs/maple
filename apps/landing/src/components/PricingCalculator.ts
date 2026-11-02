import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { makeIsland } from "../foldkit-island/island"
import { APP_SIGN_UP_URL } from "../lib/app-urls"
import { trackLanding } from "../lib/telemetry"
import {
	estimateMaple,
	estimateVendor,
	formatCurrency,
	formatLineAmount,
	formatSliderValue,
	MAPLE_PRICING_NOTE,
	PRICES_VERIFIED,
	vendorCaveat,
	vendorConfigs,
	VENDORS,
	defaultValues,
	type Estimate,
	type SliderConfig,
} from "../lib/vendor-pricing"

/**
 * The interactive half of the price comparison. All arithmetic lives in `lib/vendor-pricing.ts`
 * so the server-rendered receipts on `/compare/*` price the reference workload with the same
 * functions this island prices the visitor's sliders with.
 */

// MODEL

export const Competitor = Schema.Literals(VENDORS)
export type Competitor = typeof Competitor.Type

export const Model = Schema.Struct({
	competitor: Competitor,
	/** The /compare/* shape: one row of totals under the sliders instead of two cards. */
	isCompact: Schema.Boolean,
	values: Schema.Record(Schema.String, Schema.Finite),
	/** Bumped per slider tick; a settle timer only reports if no tick followed it. */
	settleVersion: Schema.Finite,
})
export type Model = typeof Model.Type

export const initModel = (competitor: Competitor, isCompact: boolean): Model => ({
	competitor,
	isCompact,
	values: defaultValues(competitor),
	settleVersion: 0,
})

// MESSAGE

export const Message = defineMessageUnion({
	ChangedSlider: { key: Schema.String, value: Schema.Finite },
	SettledSlider: { version: Schema.Finite, competitor: Competitor, key: Schema.String, value: Schema.Finite },
	ReportedCalculatorChange: {},
	SelectedCompetitor: { competitor: Competitor },
})
export type Message = typeof Message.Type

// COMMAND

/** A range input fires per tick of the drag, so the event waits for the slider to settle. */
const WaitForSliderSettle = Command.define("WaitForSliderSettle", {
	args: { version: Schema.Finite, competitor: Competitor, key: Schema.String, value: Schema.Finite },
	messages: [Message.SettledSlider],
	execute: (args) => Effect.sleep("800 millis").pipe(Effect.as(Message.SettledSlider(args))),
})

const ReportCalculatorChange = Command.define("ReportCalculatorChange", {
	args: { competitor: Competitor, key: Schema.String, value: Schema.Finite },
	messages: [Message.ReportedCalculatorChange],
	execute: ({ competitor, key, value }) =>
		Effect.sync(() => {
			trackLanding("pricing_calculator_changed", { competitor, slider: key, value })
			return Message.ReportedCalculatorChange()
		}),
})

// UPDATE

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		ChangedSlider: ({ key, value }) => {
			const settleVersion = model.settleVersion + 1
			return {
				model: { ...model, values: { ...model.values, [key]: value }, settleVersion },
				commands: [WaitForSliderSettle({ version: settleVersion, competitor: model.competitor, key, value })],
			}
		},
		SettledSlider: ({ version, competitor, key, value }) =>
			version === model.settleVersion
				? { model, commands: [ReportCalculatorChange({ competitor, key, value })] }
				: { model },
		ReportedCalculatorChange: () => ({ model }),
		// Re-seeds the sliders with the new vendor's defaults; a pending report still goes out.
		SelectedCompetitor: ({ competitor }) => ({
			model: { ...initModel(competitor, model.isCompact), settleVersion: model.settleVersion },
		}),
	})

// VIEW

type H = HtmlBuilder<Message>

/** "August 2026" from the `YYYY-MM` the price sheet carries. */
const PRICES_VERIFIED_LABEL = new Date(`${PRICES_VERIFIED}-15T00:00:00Z`).toLocaleDateString("en-US", {
	month: "long",
	year: "numeric",
	timeZone: "UTC",
})

const slider = (h: H, competitor: Competitor, config: SliderConfig, value: number): Html => {
	const pct = ((value - config.min) / (config.max - config.min)) * 100
	const inputId = `pricing-${competitor}-${config.key}`
	const readout = formatSliderValue(config, value)
	return h.div(
		[h.Key(config.key), h.Class("space-y-2")],
		[
			h.div(
				[h.Class("flex items-center justify-between")],
				[
					h.label([h.For(inputId), h.Class("text-xs text-fg-muted")], [config.label]),
					h.span([h.Class("text-xs font-mono text-fg")], [readout]),
				],
			),
			h.div(
				[h.Class("relative h-8 flex items-center")],
				[
					h.div([h.Class("absolute inset-x-0 h-[2px] bg-border rounded-full")], []),
					h.div([h.Class("absolute h-[2px] bg-primary rounded-full"), h.Style({ width: `${pct}%` })], []),
					h.input([
						h.Id(inputId),
						h.Type("range"),
						h.Min(String(config.min)),
						h.Max(String(config.max)),
						h.Step(String(config.step)),
						h.Value(String(value)),
						h.AriaValuetext(readout),
						h.OnInput((raw) => Message.ChangedSlider({ key: config.key, value: Number(raw) })),
						h.Class(
							"slider-input absolute inset-x-0 w-full h-8 appearance-none bg-transparent cursor-pointer",
						),
					]),
				],
			),
		],
	)
}

const perMonth = (h: H, className: string): Html => h.span([h.Class(className)], ["/mo"])

const breakdownCard = (
	h: H,
	card: Readonly<{ name: string; nameClass: string; totalClass: string; estimate: Estimate }>,
): Html =>
	h.div(
		[h.Class("bg-bg-elevated p-6 md:p-8")],
		[
			h.div([h.Class("mb-4")], [h.span([h.Class(`text-[10px] uppercase tracking-wider ${card.nameClass}`)], [card.name])]),
			h.div(
				[h.Class(`mb-4 font-mono text-3xl font-medium tabular-nums tracking-[-0.02em] ${card.totalClass} md:text-4xl`)],
				[formatCurrency(card.estimate.total), perMonth(h, "text-sm font-normal text-fg-muted")],
			),
			h.div(
				[h.Class("space-y-2")],
				card.estimate.breakdown.map((item) =>
					h.div(
						[h.Key(item.label), h.Class("flex items-center justify-between text-xs")],
						[
							h.span([h.Class("text-fg-muted")], [item.label]),
							h.span(
								[h.Class("font-mono text-fg")],
								[item.value === 0 ? "Free" : formatLineAmount(item.value)],
							),
						],
					),
				),
			),
			h.div(
				[h.Class("mt-3 space-y-1")],
				card.estimate.breakdown.map((item) =>
					h.div([h.Key(`${item.label}-d`), h.Class("text-[10px] text-fg-muted/80")], [item.detail]),
				),
			),
		],
	)

const compactTotal = (h: H, label: string, labelClass: string, totalClass: string, total: number): Html =>
	h.div(
		[h.Class("bg-bg-elevated px-6 py-5 md:px-8")],
		[
			h.dt([h.Class(`font-mono text-[10px] font-medium uppercase tracking-[0.14em] ${labelClass}`)], [label]),
			h.dd(
				[h.Class(`mt-2 font-mono text-2xl font-medium tabular-nums tracking-[-0.02em] ${totalClass} md:text-3xl`)],
				[formatCurrency(total), perMonth(h, "ml-1 text-xs font-normal text-fg-muted")],
			),
		],
	)

const compactView = (h: H, model: Model, sliders: ReadonlyArray<Html>, maple: Estimate, vendor: Estimate): Html => {
	const savings = vendor.total - maple.total
	const savingsPct = vendor.total > 0 ? Math.round((savings / vendor.total) * 100) : 0
	return h.div(
		[h.Class("overflow-hidden rounded-xl border border-border bg-bg-elevated")],
		[
			h.div([h.Class("space-y-5 p-6 md:p-8")], sliders),
			h.dl(
				[h.Class("grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-3")],
				[
					compactTotal(h, "Maple", "text-primary", "text-primary", maple.total),
					compactTotal(h, vendorConfigs[model.competitor].name, "text-fg-muted", "text-fg", vendor.total),
					h.div(
						[h.Class("col-span-2 bg-bg-elevated px-6 py-5 sm:col-span-1 md:px-8")],
						[
							h.dt(
								[h.Class("font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-fg-muted")],
								["Difference"],
							),
							h.dd(
								[h.Class("mt-2 text-[13px] leading-relaxed text-fg")],
								[
									savings >= 0
										? `${formatCurrency(savings)} less per month on Maple`
										: `${formatCurrency(-savings)} more per month on Maple`,
									h.span(
										[h.Class("block text-fg-muted")],
										[
											`${formatCurrency(Math.abs(savings) * 12)} a year${savings > 0 ? ` · ${savingsPct}% less` : ""}`,
										],
									),
								],
							),
						],
					),
				],
			),
		],
	)
}

const savingsCallout = (h: H, name: string, savings: number, savingsPct: number): Html =>
	h.div(
		[h.Class("border-t border-border bg-primary/[0.06] p-6 md:p-8")],
		[
			h.div(
				[h.Class("flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4")],
				[
					h.div(
						[],
						[
							h.div(
								[h.Class("font-mono text-2xl font-medium tabular-nums tracking-[-0.02em] text-primary md:text-3xl")],
								[`Save ${formatCurrency(savings)}/month`],
							),
							h.p(
								[h.Class("text-sm text-fg-muted mt-1")],
								[
									h.span([h.Class("font-semibold text-primary")], [`${savingsPct}% less`]),
									` than ${name}, or `,
									h.span([h.Class("font-semibold text-primary")], [`${formatCurrency(savings * 12)}/year`]),
									" over twelve months.",
								],
							),
						],
					),
					h.a(
						[
							h.Href(APP_SIGN_UP_URL),
							h.Class(
								"inline-flex h-10 shrink-0 items-center justify-center rounded-lg bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90",
							),
						],
						["Start free trial"],
					),
				],
			),
		],
	)

export const calculatorView = (model: Model, h: H): Html => {
	const { competitor } = model
	const config = vendorConfigs[competitor]
	const vendor = estimateVendor(competitor, model.values)
	const maple = estimateMaple(competitor, model.values)
	const sliders = config.sliders.map((s) => slider(h, competitor, s, model.values[s.key] ?? s.default))
	if (model.isCompact) return compactView(h, model, sliders, maple, vendor)
	const savings = vendor.total - maple.total
	const savingsPct = vendor.total > 0 ? Math.round((savings / vendor.total) * 100) : 0
	return h.div(
		[h.Class("overflow-hidden rounded-xl border border-border bg-bg-elevated")],
		[
			h.div(
				[h.Class("space-y-5 p-6 md:p-8")],
				[h.div([h.Class("text-[10px] uppercase tracking-wider text-fg-muted")], ["Adjust your usage"]), ...sliders],
			),
			h.div(
				[h.Class("grid grid-cols-1 gap-px border-t border-border bg-border md:grid-cols-2")],
				[
					breakdownCard(h, { name: "Maple", nameClass: "text-primary", totalClass: "text-primary", estimate: maple }),
					breakdownCard(h, { name: config.name, nameClass: "text-fg-muted", totalClass: "text-fg", estimate: vendor }),
				],
			),
			...(savings > 0 ? [savingsCallout(h, config.name, savings, savingsPct)] : []),
			h.p(
				[h.Class("px-6 pb-6 pt-4 text-[10px] leading-relaxed text-fg-muted/80 md:px-8")],
				[
					`Estimates based on published pricing as of ${PRICES_VERIFIED_LABEL}. Actual costs may vary based on contract terms, volume discounts, and additional features. ${MAPLE_PRICING_NOTE} ${vendorCaveat[competitor]}`,
				],
			),
		],
	)
}

export const PricingCalculator = makeIsland({
	name: "pricing-calculator",
	Props: Schema.Struct({ competitor: Competitor, compact: Schema.optionalKey(Schema.Boolean) }),
	Model,
	init: ({ competitor, compact }) => ({ model: initModel(competitor, compact ?? false) }),
	update,
	view: calculatorView,
})

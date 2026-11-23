import type { V2IngestRule, V2IngestRuleStats } from "@maple/domain/http/v2"
import { formatNumber, formatStorageBytes } from "@maple/ui/lib/format"
import { AsyncData } from "foldkit"
import { card, cardAction, cardDescription, cardHeader, cardTitle } from "@maple/views/ui/card"
import type { Html } from "foldkit/html"
import { errorState } from "@maple/views/ui/error-state"
import { meter } from "@maple/views/ui/meter"
import { miniBars } from "@maple/views/ui/mini-bars"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statFigure } from "@maple/views/ui/stat-figure"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr, Option } from "effect"
import {
	bucketed,
	type Effect,
	effectCount,
	effectKind,
	headline,
	hourlySeries,
	IMPACT_BAR_HOURS,
	IMPACT_HOURS,
	type ImpactWindow,
	type RuleCounts,
} from "./impact"
import { Message } from "./message"
import type { Model } from "./model"
import { SIGNAL_LABELS } from "./summary"
import type { H } from "./view-form"
import { strip } from "@maple/views/ui/rule"

// The saved rule's impact: what the gateway counted it matching, dropping and redacting.

const WINDOW_LABELS = { "24h": "last 24 hours", "7d": "last 7 days" } as const satisfies Record<
	ImpactWindow,
	string
>

const ZERO: RuleCounts = { matched: 0, dropped: 0, dropped_bytes: 0, redacted_values: 0 }

const percent = (part: number, whole: number): string =>
	whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%"

interface Tile {
	readonly label: string
	readonly value: string
	readonly unit?: string
	readonly caption?: string
}

/** A figure on its own sunken tile: a readable label, the value, an optional caption. */
const tile = (h: H, { label, value, unit, caption }: Tile, hero: boolean): Html =>
	vstack(
		h,
		{
			gap: "2",
			className: hero
				? "col-span-2 rounded-md border bg-surface-sunken p-4"
				: "rounded-md border bg-surface-sunken p-4",
		},
		[
			typography(h, { size: "ui", tone: "soft", weight: "medium" }, [label]),
			statFigure(h, { value, unit: unit ?? "", size: hero ? "lg" : "md" }),
			...(caption === undefined
				? []
				: [typography(h, { size: "ui", tone: "muted", numeric: true }, [caption])]),
		],
	)

/** The rule's main effect, with how much of what it matched that is. */
const heroTile = (effect: Effect, totals: RuleCounts, window: string): Tile =>
	effect === "drop"
		? {
				label: `Dropped, ${window}`,
				value: formatNumber(totals.dropped),
				unit: "records",
				caption:
					totals.dropped >= totals.matched
						? "Every record it matched"
						: `${percent(totals.dropped, totals.matched)} of the ${formatNumber(totals.matched)} records it matched`,
			}
		: {
				label: `Redacted, ${window}`,
				value: formatNumber(totals.redacted_values),
				unit: "values",
				caption: `In ${formatNumber(totals.matched)} records it matched`,
			}

/** Bytes, the busiest bar, and a second effect if the rule changed action in the window. */
const sideTiles = (effect: Effect, totals: RuleCounts, peak: number, perBar: string): ReadonlyArray<Tile> => [
	...(effect === "drop" || totals.dropped > 0
		? [{ label: "Bytes dropped", value: formatStorageBytes(totals.dropped_bytes) }]
		: []),
	...(effect === "drop" && totals.redacted_values > 0
		? [{ label: "Values redacted", value: formatNumber(totals.redacted_values) }]
		: []),
	...(effect === "redact" && totals.dropped > 0
		? [{ label: "Records dropped", value: formatNumber(totals.dropped) }]
		: []),
	{ label: perBar === "hour" ? "Peak hour" : "Peak 6h", value: formatNumber(peak) },
]

type Totals = RuleCounts & { readonly signals: V2IngestRuleStats["rules"][number]["signals"] }

/** One row per signal: its share of the rule's effect as a meter, then its counts. */
const signalRows = (h: H, rule: V2IngestRule, effect: Effect, totals: Totals): Html =>
	vstack(h, { gap: "3" }, [
		typography(h, { size: "ui", tone: "soft", weight: "medium" }, ["By signal"]),
		vstack(
			h,
			{ gap: "3" },
			Arr.map(totals.signals, (entry) => {
				const own = effectKind(rule.action, entry)
				// Phone: name and counts on one line, the meter full width under them.
				return h.div(
					[
						h.Class(
							"grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 sm:grid-cols-[5rem_minmax(0,1fr)_16rem]",
						),
					],
					[
						typography(h, { size: "ui", weight: "medium" }, [SIGNAL_LABELS[entry.signal]]),
						meter(h, {
							value: effectCount(effect, entry),
							max: Math.max(effectCount(effect, totals), 1),
							tone: "live",
							label: `${SIGNAL_LABELS[entry.signal]}: share of the rule's ${effect === "drop" ? "drops" : "redactions"}`,
							className: "col-span-2 h-1.5 max-sm:order-last sm:col-span-1",
						}),
						hstack(h, { gap: "3", justify: "end" }, [
							typography(h, { size: "ui", numeric: true }, [headline(own, entry)]),
							...(own === "drop"
								? [
										typography(
											h,
											{
												size: "ui",
												tone: "muted",
												numeric: true,
												className: "w-16 text-right",
											},
											[formatStorageBytes(entry.dropped_bytes)],
										),
									]
								: []),
						]),
					],
				)
			}),
		),
	])

const body = (h: H, model: Model, rule: V2IngestRule, stats: V2IngestRuleStats): Html => {
	const totals: Totals = Option.getOrElse(
		Arr.findFirst(stats.rules, (entry) => entry.id === rule.id),
		() => ({ ...ZERO, signals: [] }),
	)
	const window = WINDOW_LABELS[model.impactWindow]
	const effect = effectKind(rule.action, totals)
	if (totals.matched === 0)
		return vstack(h, { gap: "1", className: "px-4 pb-6" }, [
			typography(h, { size: "sm", weight: "medium" }, [`No records matched in the ${window}.`]),
			typography(h, { size: "ui", tone: "muted" }, [
				rule.enabled
					? "The rule applies to new data as it arrives. Counts lag by up to a minute."
					: "The rule is off, so the gateway skips it.",
			]),
		])
	const perBar = model.impactWindow === "24h" ? "hour" : "6 hours"
	const bars = bucketed(
		hourlySeries(stats, rule.id, IMPACT_HOURS[model.impactWindow], (entry) => effectCount(effect, entry)),
		IMPACT_BAR_HOURS[model.impactWindow],
	)
	const peak = Arr.reduce(bars, 0, (max, value) => Math.max(max, value))
	const side = sideTiles(effect, totals, peak, perBar)
	return vstack(h, { gap: "6", className: "px-4 pb-4" }, [
		h.div(
			[
				h.Class(
					side.length > 1
						? "grid grid-cols-2 gap-3 sm:grid-cols-4"
						: "grid grid-cols-2 gap-3 sm:grid-cols-3",
				),
			],
			[
				tile(h, heroTile(effect, totals, window), true),
				...Arr.map(side, (entry) => tile(h, entry, false)),
			],
		),
		vstack(h, { gap: "2" }, [
			h.div(
				[h.Class("border-b border-border")],
				[
					miniBars(h, {
						values: bars,
						floor: 3,
						floorColor: "var(--input)",
						gap: 1.2,
						minHeight: 4,
						className: "text-primary h-20 w-full",
						label: `${rule.name}: ${effect === "drop" ? "records dropped" : "values redacted"} per ${perBar}`,
					}),
				],
			),
			hstack(h, { justify: "between" }, [
				typography(h, { size: "xs", tone: "muted" }, [
					model.impactWindow === "24h" ? "24h ago" : "7d ago",
				]),
				typography(h, { size: "xs", tone: "muted" }, [`Per ${perBar}, UTC`]),
				typography(h, { size: "xs", tone: "muted" }, ["Now"]),
			]),
		]),
		...(totals.signals.length > 1
			? [strip(h, { kind: "section" }, [signalRows(h, rule, effect, totals)])]
			: []),
	])
}

/** Shown above the editor for a saved rule; nothing while creating one. */
export const impactPanel = (h: H, model: Model): ReadonlyArray<Html> => {
	if (model.editingId === null || !AsyncData.isSuccess(model.existing)) return []
	const rule = model.existing.data
	return [
		card(h, [
			cardHeader(h, [
				cardTitle(h, ["Impact"]),
				cardDescription(h, ["What the gateway did with the records this rule matched."]),
				cardAction(h, [
					segmentedSelect<ImpactWindow, Message>(h, {
						size: "xs",
						ariaLabel: "Impact window",
						value: model.impactWindow,
						onChange: (window) => Message.PickedImpactWindow({ window }),
						options: [
							{ value: "24h", label: "24h" },
							{ value: "7d", label: "7d" },
						],
					}),
				]),
			]),
			AsyncData.matchData(model.impact, {
				onEmpty: () =>
					vstack(h, { gap: "3", className: "px-4 pb-4" }, [
						skeleton(h, "h-24 w-full"),
						skeleton(h, "h-20 w-full"),
					]),
				onFailure: (error) =>
					errorState(h, {
						failure: error,
						title: "Couldn't load this rule's counts",
						onRetry: Message.ClickedRetryImpact(),
						className: "border-0",
					}),
				onData: (stats) => body(h, model, rule, stats),
			}),
		]),
	]
}

import type { V2IngestRule, V2IngestRuleStats } from "@maple/domain/http/v2"
import { formatNumber, formatStorageBytes } from "@maple/ui/lib/format"
import { AsyncData } from "foldkit"
import type { Html } from "foldkit/html"
import { errorState } from "@maple/views/ui/error-state"
import { keyValue, keyValueList } from "@maple/views/ui/key-value"
import { miniBars } from "@maple/views/ui/mini-bars"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statFigure } from "@maple/views/ui/stat-figure"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr, Option } from "effect"
import {
	bucketed,
	detail,
	effectOf,
	headline,
	hourlySeries,
	IMPACT_BAR_HOURS,
	IMPACT_HOURS,
	type ImpactWindow,
	keptOf,
	type RuleCounts,
} from "./impact"
import { Message } from "./message"
import type { Model } from "./model"
import { SIGNAL_LABELS } from "./summary"
import type { H } from "./view-form"

// The saved rule's impact: what the gateway counted it matching, dropping and redacting.

const WINDOW_LABELS = { "24h": "last 24 hours", "7d": "last 7 days" } as const satisfies Record<
	ImpactWindow,
	string
>

const ZERO: RuleCounts = { matched: 0, dropped: 0, dropped_bytes: 0, redacted_values: 0 }

const figures = (h: H, rule: V2IngestRule, totals: RuleCounts): ReadonlyArray<Html> => {
	const action = rule.action
	if (action.type !== "drop")
		return [
			statFigure(h, {
				label: "Values redacted",
				value: formatNumber(totals.redacted_values),
				size: "sm",
			}),
			statFigure(h, { label: "Records matched", value: formatNumber(totals.matched), size: "sm" }),
		]
	return [
		statFigure(h, { label: "Records dropped", value: formatNumber(totals.dropped), size: "sm" }),
		statFigure(h, {
			label: "Kept off the bill",
			value: formatStorageBytes(totals.dropped_bytes),
			size: "sm",
		}),
		...(action.keep_percent > 0
			? [statFigure(h, { label: "Kept by sampling", value: formatNumber(keptOf(totals)), size: "sm" })]
			: []),
	]
}

const body = (h: H, model: Model, rule: V2IngestRule, stats: V2IngestRuleStats): Html => {
	const totals = Option.getOrElse(
		Arr.findFirst(stats.rules, (entry) => entry.id === rule.id),
		() => ({ ...ZERO, signals: [] }),
	)
	const window = WINDOW_LABELS[model.impactWindow]
	if (totals.matched === 0)
		return vstack(h, { gap: "1", className: "px-4 py-6" }, [
			typography(h, { size: "sm" }, [`No records matched in the ${window}.`]),
			typography(h, { size: "xs", tone: "muted" }, [
				rule.enabled
					? "The rule applies to new data as it arrives. Counts lag by up to a minute."
					: "The rule is off, so the gateway skips it.",
			]),
		])
	return vstack(h, { gap: "4", className: "p-4" }, [
		h.div([h.Class("grid grid-cols-2 gap-4 sm:grid-cols-3")], [...figures(h, rule, totals)]),
		vstack(h, { gap: "1" }, [
			miniBars(h, {
				values: bucketed(
					hourlySeries(stats, rule.id, IMPACT_HOURS[model.impactWindow], (entry) =>
						effectOf(rule.action, entry),
					),
					IMPACT_BAR_HOURS[model.impactWindow],
				),
				floor: 6,
				floorColor: "var(--input)",
				gap: 1,
				className: "text-primary h-12 w-full",
				label: `${rule.name}: ${rule.action.type === "drop" ? "records dropped" : "values redacted"} per ${model.impactWindow === "24h" ? "hour" : "6 hours"}`,
			}),
			hstack(h, { justify: "between" }, [
				typography(h, { size: "2xs", tone: "muted" }, [
					model.impactWindow === "24h" ? "24h ago" : "7d ago",
				]),
				typography(h, { size: "2xs", tone: "muted" }, [
					model.impactWindow === "24h" ? "Per hour, UTC" : "Per 6 hours, UTC",
				]),
				typography(h, { size: "2xs", tone: "muted" }, ["Now"]),
			]),
		]),
		totals.signals.length > 1
			? keyValueList(
					h,
					{ divided: true },
					Arr.map(totals.signals, (entry) =>
						keyValue(h, { label: SIGNAL_LABELS[entry.signal] }, [
							`${headline(rule.action, entry)} · ${detail(rule.action, entry)}`,
						]),
					),
				)
			: h.div([], []),
	])
}

/** Shown above the editor for a saved rule; nothing while creating one. */
export const impactPanel = (h: H, model: Model): ReadonlyArray<Html> => {
	if (model.editingId === null || !AsyncData.isSuccess(model.existing)) return []
	const rule = model.existing.data
	return [
		panel(h, { className: "overflow-hidden" }, [
			panelHeader(h, {
				title: "Impact",
				action: segmentedSelect<ImpactWindow, Message>(h, {
					size: "xs",
					ariaLabel: "Impact window",
					value: model.impactWindow,
					onChange: (window) => Message.PickedImpactWindow({ window }),
					options: [
						{ value: "24h", label: "24h" },
						{ value: "7d", label: "7d" },
					],
				}),
			}),
			AsyncData.matchData(model.impact, {
				onEmpty: () =>
					vstack(h, { gap: "3", className: "p-4" }, [
						skeleton(h, "h-8 w-64"),
						skeleton(h, "h-12 w-full"),
					]),
				onFailure: (error) =>
					errorState(h, {
						failure: error,
						title: "Couldn't load this rule's counts",
						className: "border-0",
					}),
				onData: (stats) => body(h, model, rule, stats),
			}),
		]),
	]
}

import { AGGREGATIONS_BY_SOURCE } from "@maple/query-engine/query-builder"
import {
	getPerformanceHints,
	hasSlowHints,
	slowHintsSummary,
} from "../../lib/query-builder/performance-hints"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AsyncData } from "foldkit"
import { Option } from "effect"
import { QueryChange, type AddOnKey } from "../../page/kit/query-builder/change"
import type { QueryDraft } from "../../page/kit/query-builder/draft"
import { textInput } from "../../page/kit/query-builder/parts"
import { whereEditor } from "../../page/kit/query-builder/where-editor"
import { button } from "../../ui/button"
import { card, cardHeader, cardPanel } from "../../ui/card"
import * as Checkbox from "../../ui/checkbox"
import { icon } from "../../ui/icon"
import { label } from "../../ui/label"
import { metricOptionsOf } from "./derive"
import { Message, type Model } from "./model"
import { fieldEyebrow, labSelect, nameBadge } from "./view-controls"
import { addOnSections } from "./view-add-ons"

// One query card of `QueryBuilderLabInner`.

type H = HtmlBuilder<Message>

const DATA_SOURCES = [
	{ label: "Traces", value: "traces" },
	{ label: "Logs", value: "logs" },
	{ label: "Metrics", value: "metrics" },
]

const SIGNAL_SOURCES = [
	{ label: "Default", value: "default" },
	{ label: "Meter", value: "meter" },
]

const ADD_ONS: ReadonlyArray<{ key: AddOnKey; label: string }> = [
	{ key: "groupBy", label: "Group by" },
	{ key: "having", label: "Having" },
	{ key: "orderBy", label: "Order by" },
	{ key: "limit", label: "Limit" },
	{ key: "legend", label: "Legend" },
]

const changed = (query: QueryDraft, change: QueryChange) =>
	Message.ChangedQuery({ queryId: query.id, change })

const header = (h: H, model: Model, query: QueryDraft): Html => {
	const inputId = `query-enabled-${query.id}`
	return cardHeader(
		h,
		[
			h.div(
				[h.Class("flex flex-wrap items-center justify-between gap-2")],
				[
					labSelect(h, model, `source:${query.id}`, query.dataSource, DATA_SOURCES, {
						className: "w-[120px]",
						toView: (parts) =>
							h.div(
								[h.Class("flex items-center gap-2")],
								[
									h.span(
										[h.Class("text-xs text-muted-foreground")],
										["Query ", query.name],
									),
									...parts,
								],
							),
					}),
					h.div(
						[h.Class("flex items-center gap-1")],
						[
							h.div(
								[h.Class("flex items-center gap-1.5")],
								[
									...Checkbox.view(h, {
										model: { isChecked: query.enabled },
										toParentMessage: () => Message.ToggledEnabled({ queryId: query.id }),
										id: `${inputId}-root`,
										inputId,
									}),
									label(
										h,
										{
											className: "text-2xs text-muted-foreground",
											attributes: [h.For(inputId), h.Id(Checkbox.labelId(inputId))],
										},
										["Enabled"],
									),
								],
							),
							button(
								h,
								{
									variant: "ghost",
									size: "xs",
									attributes: [h.OnClick(Message.ClickedCloneQuery({ queryId: query.id }))],
								},
								[icon(h, "CopyIcon"), "Clone"],
							),
							button(
								h,
								{
									variant: "ghost",
									size: "xs",
									attributes: [
										h.OnClick(Message.ClickedRemoveQuery({ queryId: query.id })),
									],
								},
								[icon(h, "XmarkIcon"), "Remove"],
							),
						],
					),
				],
			),
		],
		"pb-2",
	)
}

const NO_METRICS = [{ value: "__none__", label: "No metrics available" }]

/** The Metric and Signal Source selects of a metrics query. */
const metricFields = (h: H, model: Model, query: QueryDraft): ReadonlyArray<Html> => {
	if (query.dataSource !== "metrics") return []
	const rows = Option.getOrElse(AsyncData.getData(model.metrics.data), () => [])
	const options = metricOptionsOf(rows)
	const value = query.metricName === "" ? "" : `${query.metricName}::${query.metricType}`
	const field = (title: string, select: (toView: (parts: ReadonlyArray<Html>) => Html) => Html) =>
		select((parts) => h.div([h.Class("space-y-1")], [fieldEyebrow(h, title), ...parts]))
	return [
		h.div(
			[h.Class("grid gap-2 md:grid-cols-2")],
			[
				field("Metric", (toView) =>
					labSelect(
						h,
						model,
						`metric:${query.id}`,
						value,
						options.length === 0 ? NO_METRICS : options,
						{
							className: "w-full",
							placeholder: "Select metric",
							toView,
						},
					),
				),
				field("Signal source", (toView) =>
					labSelect(h, model, `signal:${query.id}`, query.signalSource, SIGNAL_SOURCES, {
						className: "w-full",
						toView,
					}),
				),
			],
		),
	]
}

const WHERE_PLACEHOLDER = 'Leave empty for all services. Example: deployment.environment = "production"'

const whereSection = (h: H, query: QueryDraft): Html => {
	const hints =
		query.dataSource === "traces"
			? getPerformanceHints(query.whereClause, query.addOns.groupBy ? [...query.groupBy] : [])
			: []
	return h.div(
		[h.Class("space-y-1")],
		[
			fieldEyebrow(h, "Where (key = value, joined by AND)"),
			h.div(
				[h.Class("relative")],
				[
					icon(h, "MagnifierIcon", {
						size: 12,
						className: "pointer-events-none absolute left-2 top-2.5 text-muted-foreground",
					}),
					whereEditor(h, {
						id: `where-${query.id}`,
						value: query.whereClause,
						ariaLabel: `Where clause for query ${query.name}`,
						textareaClassName: "pl-7",
						placeholder: WHERE_PLACEHOLDER,
						rows: 2,
						onInput: (value) =>
							changed(query, QueryChange.SetText({ field: "whereClause", value })),
						onEnter: Message.PressedWhereEnter(),
					}),
				],
			),
			...(hasSlowHints(hints)
				? [h.p([h.Class("mt-1 text-2xs text-severity-warn")], [slowHintsSummary(hints)])]
				: []),
		],
	)
}

const aggregationRow = (h: H, model: Model, query: QueryDraft): Html =>
	h.div(
		[h.Class("grid gap-2 md:grid-cols-[1.1fr_1fr]")],
		[
			labSelect(
				h,
				model,
				`aggregation:${query.id}`,
				query.aggregation,
				AGGREGATIONS_BY_SOURCE[query.dataSource],
				{
					className: "w-full",
					toView: (parts) =>
						h.div([h.Class("space-y-1")], [fieldEyebrow(h, "Aggregation"), ...parts]),
				},
			),
			h.div(
				[h.Class("space-y-1")],
				[
					fieldEyebrow(h, "Every (seconds, 5m, 1h)"),
					textInput(
						h,
						`step-${query.id}`,
						query.stepInterval,
						"Auto (e.g. 60, 5m, 1h)",
						"",
						(value) => changed(query, QueryChange.SetText({ field: "stepInterval", value })),
					),
				],
			),
		],
	)

const addOnToggles = (h: H, query: QueryDraft): Html =>
	h.div(
		[h.Class("space-y-2")],
		[
			fieldEyebrow(h, "Add-ons"),
			h.div(
				[h.Class("flex flex-wrap gap-1.5")],
				ADD_ONS.map((addOn) =>
					button(
						h,
						{
							variant: query.addOns[addOn.key] ? "secondary" : "outline",
							size: "xs",
							attributes: [
								h.OnClick(changed(query, QueryChange.ToggledAddOn({ key: addOn.key }))),
							],
						},
						[addOn.label],
					),
				),
			),
		],
	)

/** One query row: its name badge and its card. */
export const queryRow = (h: H, model: Model, query: QueryDraft): Html =>
	h.div(
		[h.Key(query.id), h.Class("grid grid-cols-[44px_1fr] gap-2")],
		[
			nameBadge(h, query.name),
			card(
				h,
				[
					header(h, model, query),
					cardPanel(h, [
						h.div(
							[h.Class("space-y-2 border-l border-dashed pl-3")],
							[
								...metricFields(h, model, query),
								whereSection(h, query),
								aggregationRow(h, model, query),
								addOnToggles(h, query),
								...addOnSections(h, model, query),
							],
						),
					]),
				],
				query.enabled ? "" : "opacity-60",
			),
		],
	)

import { buildTimeseriesQuerySpec, createQueryDraft } from "@maple/query-engine/query-builder"
import { getListPerformanceHints } from "../../../lib/query-builder/performance-hints"
import { AsyncData } from "foldkit"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription } from "../../../ui/alert"
import { button } from "../../../ui/button"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { input } from "../../../ui/input"
import { segmentedSelect } from "../../../ui/segmented-select"
import { settingRow } from "../../../ui/setting-row"
import { switchControl } from "../../../ui/switch"
import { lookupField } from "../../kit/autocomplete-lookups"
import { whereEditor } from "../../kit/query-builder/where-editor"
import { autocompleteFor, listField } from "./where-fields"
import type { EditorState, ListDataSource } from "./editor-state"
import { MountListColumnDrag } from "./list-column-drag"
import { buildListLogsParams } from "./list-logs-params"
import { Message } from "./message"
import type { Model } from "./model"
import { ProductEdit } from "./product-edit"
import { product } from "./view-product"
import { listColumnRow } from "./view-list-column"

// `ListConfigPanel` and its Run preview row.

type H = HtmlBuilder<Message>

const SOURCE_OPTIONS: ReadonlyArray<{ value: ListDataSource; label: string }> = [
	{ value: "traces", label: "Traces" },
	{ value: "logs", label: "Logs" },
	{ value: "product_events", label: "Product events" },
]

const FILTER_PLACEHOLDER = {
	traces: 'service.name = "api" AND has_error = true',
	logs: 'service.name = "api" AND severity = "ERROR"',
	product_events: 'event.name = "signup_completed" AND country = "DE"',
} as const

const KNOWN_FIELDS = {
	traces: [
		"traceId",
		"timestamp",
		"spanId",
		"serviceName",
		"spanName",
		"durationMs",
		"statusCode",
		"spanKind",
		"hasError",
	],
	logs: ["timestamp", "severityText", "severityNumber", "serviceName", "body", "traceId", "spanId"],
	product_events: [
		"timestamp",
		"eventName",
		"kind",
		"source",
		"host",
		"pagePath",
		"url",
		"serviceName",
		"userId",
		"groupId",
		"visitorId",
		"sessionId",
		"traceId",
	],
} as const

const ATTRIBUTE_PREFIX = {
	traces: "spanAttributes.",
	logs: "logAttributes.",
	product_events: "attributes.",
} as const

const lookupNames = (model: Model, lookup: string): ReadonlyArray<string> =>
	lookupField(
		Option.getOrUndefined(AsyncData.getData(model.autocomplete[lookup]?.data ?? AsyncData.Idle())),
		"keys",
	)

/** The known columns, then the source's attribute keys under their map prefix. */
export const suggestedFieldsOf = (model: Model, source: ListDataSource): ReadonlyArray<string> => {
	const prefix = ATTRIBUTE_PREFIX[source]
	const dynamic =
		source === "product_events"
			? lookupNames(model, "productEventAttributeKeys").map((key) => `${prefix}${key}`)
			: [
					...lookupNames(model, "spanAttributeKeys").map((key) => `${prefix}${key}`),
					...lookupNames(model, "resourceAttributeKeys").map((key) => `resourceAttributes.${key}`),
				]
	return [...KNOWN_FIELDS[source], ...dynamic]
}

/** `listWhereClauseWarnings`. */
const filterWarnings = (source: ListDataSource, whereClause: string): ReadonlyArray<string> =>
	source === "logs"
		? buildListLogsParams(whereClause, 1).warnings
		: buildTimeseriesQuerySpec({
				...createQueryDraft(0),
				dataSource: source,
				whereClause,
				aggregation: "count",
			}).warnings

const warningList = (h: H, warnings: ReadonlyArray<string>): ReadonlyArray<Html> =>
	warnings.length === 0
		? []
		: [
				alert(h, { variant: "warn", size: "sm" }, [
					icon(h, "CircleWarningIcon", { size: 14 }),
					alertDescription(
						h,
						[
							h.ul(
								[h.Class("space-y-1")],
								warnings.map((warning) => h.li([], [warning])),
							),
						],
						"text-severity-warn",
					),
				]),
			]

/** The traces list's performance hints: slow clauses, and what the root-span MV speeds up. */
const performanceHints = (h: H, state: EditorState): ReadonlyArray<Html> => {
	if (state.listDataSource !== "traces") return []
	const parsedLimit = Number.parseInt(state.listLimit, 10)
	const hints = getListPerformanceHints(
		state.listWhereClause,
		Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 25,
		state.listRootOnly,
	)
	const slow = hints.filter((hint) => hint.speed === "slow")
	const fast = hints.filter((hint) => hint.speed === "fast")
	if (slow.length === 0 && fast.length === 0) return []
	const callout = (variant: "warn" | "ok", className: string, reasons: typeof hints) =>
		alert(h, { variant, size: "sm" }, [
			alertDescription(
				h,
				reasons.map((hint) => h.p([], [hint.reason])),
				`gap-1 text-2xs ${className}`,
			),
		])
	return [
		h.div(
			[h.Class("mt-1.5 space-y-1.5")],
			[
				...(slow.length > 0 ? [callout("warn", "text-severity-warn", slow)] : []),
				...(fast.length > 0 ? [callout("ok", "text-severity-info", fast)] : []),
			],
		),
	]
}

const listLimit = (h: H, state: EditorState): Html =>
	labelled(h, "Limit", "space-y-1.5", [
		input(h, {
			id: "widget-list-limit",
			type: "number",
			className: "w-32",
			attributes: [
				h.Value(state.listLimit),
				h.Placeholder("25"),
				h.Min("1"),
				h.Max("200"),
				h.OnInput((value) => product(ProductEdit.ChangedListLimit({ value }))),
			],
		}),
		h.p(
			[h.Class("text-3xs text-muted-foreground")],
			["Max 200. Recommended: 25-50 for dashboard widgets."],
		),
	])

const labelled = (h: H, label: string, className: string, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class(className)], [eyebrow(h, { variant: "label", as: "p" }, [label]), ...children])

/** `ListConfigPanel`, then its Run preview button. */
export const listPanel = (h: H, model: Model, state: EditorState): ReadonlyArray<Html> => {
	const source = state.listDataSource
	const fields = suggestedFieldsOf(model, source)
	return [
		h.div(
			[h.Class("space-y-5")],
			[
				labelled(h, "Data Source", "space-y-1.5", [
					segmentedSelect(h, {
						options: SOURCE_OPTIONS,
						value: source,
						onChange: (next) => product(ProductEdit.SetListSource({ source: next })),
						size: "sm",
						ariaLabel: "Data source",
						className: "*:px-4 *:text-xs",
					}),
				]),
				...(source === "traces"
					? [
							settingRow(h, {
								ids: {
									control: "list-root-only-input",
									label: "list-root-only-label",
									description: "list-root-only-description",
								},
								label: "Root spans only",
								description: "Uses pre-aggregated data for faster queries",
								filled: state.listRootOnly,
								control: switchControl(h, {
									id: "list-root-only",
									inputId: "list-root-only-input",
									isChecked: state.listRootOnly,
									labelledBy: "list-root-only-label",
									describedBy: "list-root-only-description",
									isFilled: state.listRootOnly,
									onToggle: product(ProductEdit.ToggledListRootOnly()),
								}),
							}),
						]
					: []),
				labelled(h, "Filter", "space-y-1.5", [
					whereEditor(h, {
						id: "widget-list-filter",
						value: state.listWhereClause,
						ariaLabel: "List filter",
						placeholder: FILTER_PLACEHOLDER[source],
						rows: 1,
						textareaClassName: "min-h-[32px] resize-y text-xs",
						onInput: (value) => product(ProductEdit.ChangedListWhere({ value })),
						autocomplete: autocompleteFor(model, listField(model, null, state.listWhereClause, source)),
					}),
					...warningList(h, filterWarnings(source, state.listWhereClause)),
					...performanceHints(h, state),
				]),
				listLimit(h, state),
				labelled(h, "Columns", "space-y-2", [
					h.div(
						[h.Class("space-y-2"), h.OnMount(MountListColumnDrag())],
						state.listColumns.map((column, index) =>
							listColumnRow(
								h,
								model,
								column,
								index,
								model.listFieldFocus === index ? fields : null,
							),
						),
					),
					button(
						h,
						{
							variant: "outline",
							size: "sm",
							attributes: [h.OnClick(product(ProductEdit.AddedListColumn()))],
						},
						["+ Column"],
					),
				]),
			],
		),
		h.div(
			[h.Class("flex items-center gap-3")],
			[
				button(h, { size: "sm", attributes: [h.OnClick(Message.ClickedRunPreview())] }, [
					"Run preview",
				]),
			],
		),
	]
}

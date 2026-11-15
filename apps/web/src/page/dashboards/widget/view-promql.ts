import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { field, fieldDescription, fieldErrorText, fieldLabel, type FieldState } from "@maple/views/ui/field"
import { inlineCode } from "@maple/views/ui/inline-code"
import { input } from "@maple/views/ui/input"
import { hstack, vstack } from "@maple/views/ui/stack"
import { textarea } from "@maple/views/ui/textarea"
import { typography } from "@maple/views/ui/typography"
import { dataStateOf } from "../kit/data-state"
import { Message } from "./message"
import type { Model } from "./model"
import { isRunnablePromql, promqlParseErrorOf, type PromqlState } from "./promql"
import { PROMQL_TEXTAREA_ID } from "./promql-step"
import { previewWidgetOf, widgetOf } from "./update"

type H = HtmlBuilder<Message>

const IDLE: FieldState = {
	isInvalid: false,
	isDirty: false,
	isFilled: false,
	isFocused: false,
	isTouched: false,
}

const idsOf = (base: string) => ({ control: base, label: `${base}-label`, error: `${base}-error` })
const QUERY_IDS = { ...idsOf(PROMQL_TEXTAREA_ID), description: `${PROMQL_TEXTAREA_ID}-description` }
const LEGEND_IDS = idsOf("widget-editor-promql-legend")
const STEP_IDS = idsOf("widget-editor-promql-step")

/** The preview's failure, when the server refused the query itself. */
const parseErrorOf = (model: Model): string | null => {
	const widget = previewWidgetOf(model)
	if (widget === null) return null
	const state = dataStateOf(model.requests, widget, model.gate)
	return state._tag === "Error" ? promqlParseErrorOf(state.message) : null
}

const queryField = (h: H, promql: PromqlState, error: string | null): Html =>
	field(h, { state: { ...IDLE, isInvalid: error !== null } }, [
		fieldLabel(h, { ids: QUERY_IDS, state: IDLE }, "PromQL query"),
		textarea(h, {
			id: QUERY_IDS.control,
			controlClassName: "min-h-32 font-mono text-xs leading-5",
			defaultValue: promql.draft.query,
			attributes: [
				h.Spellcheck(false),
				h.Placeholder("sum by (job) (rate(http_requests_total[$__rate_interval]))"),
				h.OnInput((value) => Message.ChangedPromql({ value })),
			],
		}),
		error === null
			? fieldDescription(h, { ids: QUERY_IDS, state: IDLE }, [
					"Dashboard variables work as ",
					inlineCode(h, {}, ["$name"]),
					", plus ",
					inlineCode(h, {}, ["$__interval"]),
					", ",
					inlineCode(h, {}, ["$__rate_interval"]),
					" and ",
					inlineCode(h, {}, ["$__range"]),
					".",
				])
			: fieldErrorText(h, {}, error),
	])

const legendField = (h: H, promql: PromqlState): Html =>
	field(h, { className: "grow", state: IDLE }, [
		fieldLabel(h, { ids: LEGEND_IDS, state: IDLE }, "Legend"),
		input(h, {
			id: LEGEND_IDS.control,
			size: "sm",
			className: "font-mono text-xs",
			attributes: [
				h.Placeholder("{{job}}"),
				h.Value(promql.draft.legendFormat),
				h.OnInput((value) => Message.ChangedPromqlLegend({ value })),
			],
		}),
	])

const stepField = (h: H, promql: PromqlState): Html => {
	const step = promql.draft.minStepSeconds
	return field(h, { className: "w-28 shrink-0", state: IDLE }, [
		fieldLabel(h, { ids: STEP_IDS, state: IDLE }, "Min step (s)"),
		input(h, {
			id: STEP_IDS.control,
			type: "number",
			size: "sm",
			className: "text-xs",
			attributes: [
				h.Min("1"),
				h.Placeholder("15"),
				h.Value(step === null ? "" : String(step)),
				h.OnInput((value) => Message.ChangedPromqlMinStep({ value })),
			],
		}),
	])
}

/** The PromQL tab's body: the query, its legend and step, and Run preview. */
export const promqlEditor = (h: H, model: Model, promql: PromqlState): ReadonlyArray<Html> => [
	vstack(h, { gap: "4" }, [
		queryField(h, promql, parseErrorOf(model)),
		hstack(h, { gap: "3", align: "start" }, [legendField(h, promql), stepField(h, promql)]),
		hstack(h, { gap: "3" }, [
			button(
				h,
				{
					size: "sm",
					isDisabled: !isRunnablePromql(promql),
					attributes: [h.OnClick(Message.ClickedRunPreview())],
				},
				["Run preview"],
			),
			typography(h, { size: "2xs", tone: "muted", className: "ml-auto" }, [
				"Targets ",
				inlineCode(h, {}, [model.state?.visualization ?? widgetOf(model)?.visualization ?? ""]),
			]),
		]),
	]),
]

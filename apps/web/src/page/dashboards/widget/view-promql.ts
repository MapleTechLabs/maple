import type { Html, HtmlBuilder, KeyboardModifiers } from "foldkit/html"
import { Array as Arr, Option, String as Str } from "effect"
import { codeEditor } from "@maple/views/ui/code-editor"
import { tokenizePromql } from "@maple/views/lib/promql-highlight"
import { button } from "@maple/views/ui/button"
import { field, fieldDescription, fieldErrorText, fieldLabel, type FieldState } from "@maple/views/ui/field"
import { inlineCode } from "@maple/views/ui/inline-code"
import { input } from "@maple/views/ui/input"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { dataStateOf } from "../kit/data-state"
import { Message } from "./message"
import type { Model } from "./model"
import { isRunnablePromql, promqlParseErrorOf, promqlSuggestionsOf, type PromqlState } from "./promql"
import { PROMQL_TEXTAREA_ID, promqlVariablesOf } from "./promql-step"
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

/** `Line 2, column 7` for an offset, as the error under the field names it. */
const positionOf = (query: string, offset: number): string => {
	const lines = Str.split(Str.slice(0, offset)(query), "\n")
	return `Line ${lines.length}, column ${Arr.last(lines).pipe(Option.getOrElse(() => "")).length + 1}`
}

/** The editor's keys: the open list's arrows, Enter, Tab and Esc, and Ctrl+Space to open it. */
const editorKey = (isOpen: boolean) => (key: string, modifiers: KeyboardModifiers) =>
	key === " " && modifiers.ctrlKey
		? Option.some(Message.PressedPromqlKey({ key }))
		: isOpen && LIST_KEYS.has(key)
			? Option.some(Message.PressedPromqlKey({ key }))
			: Option.none()

const LIST_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"])

const queryField = (h: H, model: Model, promql: PromqlState, serverError: string | null): Html => {
	const suggestions = promqlSuggestionsOf(promql, promqlVariablesOf(model))
	// Mid-word with suggestions open, the half-typed query is expected to be incomplete; Apply still checks it.
	const parseError = promql.completion !== null && suggestions.length > 0 ? null : promql.parseError
	const isInvalid = parseError !== null || serverError !== null
	return field(h, { state: { ...IDLE, isInvalid } }, [
		fieldLabel(h, { ids: QUERY_IDS, state: IDLE }, "PromQL query"),
		codeEditor(h, {
			id: QUERY_IDS.control,
			label: "PromQL query",
			value: promql.draft.query,
			tokens: tokenizePromql(promql.draft.query),
			size: "auto",
			placeholder: "sum by (job) (rate(http_requests_total[$__rate_interval]))",
			describedBy: isInvalid ? QUERY_IDS.error : QUERY_IDS.description,
			error: parseError,
			completion:
				promql.completion === null
					? null
					: {
							caret: promql.caret,
							items: suggestions,
							activeIndex: Math.min(
								promql.completion.activeIndex,
								Math.max(0, suggestions.length - 1),
							),
							onPick: (index) => Message.PickedPromqlSuggestion({ index }),
						},
			onInput: (value) => Message.ChangedPromql({ value }),
			onKeyDown: editorKey(promql.completion !== null && suggestions.length > 0),
			onKeyUp: (key) => Message.ReleasedPromqlKey({ key }),
			onClick: Message.ClickedPromqlEditor(),
			onBlur: Message.BlurredPromqlEditor(),
		}),
		parseError !== null
			? fieldErrorText(
					h,
					{ attributes: [h.Id(QUERY_IDS.error)] },
					`${positionOf(promql.draft.query, parseError.from)}: ${parseError.message}`,
				)
			: serverError !== null
				? fieldErrorText(h, { attributes: [h.Id(QUERY_IDS.error)] }, serverError)
				: fieldDescription(h, { ids: QUERY_IDS, state: IDLE }, [
						"Dashboard variables work as ",
						inlineCode(h, {}, ["$name"]),
						", plus ",
						inlineCode(h, {}, ["$__interval"]),
						", ",
						inlineCode(h, {}, ["$__rate_interval"]),
						" and ",
						inlineCode(h, {}, ["$__range"]),
						". Ctrl+Space suggests names.",
					]),
	])
}

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
		queryField(h, model, promql, parseErrorOf(model)),
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

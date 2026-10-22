import { formatNumber } from "@maple/domain/format"
import { FUNNEL_MAX_STEPS, FUNNEL_SESSION_DIMENSION_LABEL } from "@maple/query-model"
import { cn } from "@maple/ui/lib/utils"
import { FUNNEL_SESSION_DIMENSIONS } from "../../../components/funnels/definition"
import { parseFunnelStepFilter } from "../../../lib/query-builder/funnel-filters"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import * as Combobox from "../../../ui/combobox"
import * as ComboboxView from "../../../ui/combobox-view"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { input } from "../../../ui/input"
import { panel } from "../../../ui/panel"
import { whereEditor } from "../../kit/query-builder/where-editor"
import { autocompleteFor, stepField } from "./where-fields"
import type { StepDraft } from "./editor-state"
import { Message } from "./message"
import type { Model } from "./model"
import { ProductEdit, type StepScope, type StepTextField } from "./product-edit"
import { stepDimensionSelectId, stepKindSelectId } from "./product-selects"
import { stepComboId } from "./product-step"
import type { Suggestion } from "./suggestions"
import { pageSelect } from "./view-select"

// The funnel step builder, compact: an ordered list of
// steps, each an event name, a page path or (first step only) a session dimension.

type H = HtmlBuilder<Message>

const KIND_LABEL = { event: "Event", page: "Page", session: "Session" } as const

export type StepBuilderOptions = Readonly<{
	scope: StepScope
	steps: ReadonlyArray<StepDraft>
	eventNames: ReadonlyArray<Suggestion>
	pagePaths: ReadonlyArray<Suggestion>
	eventStepFilter: boolean
	maxSteps: number
}>

const product = (edit: ProductEdit): Message => Message.ChangedProduct({ edit })

/** `SuggestingInput`: free text, with the window's names to pick from. */
const suggestingInput = (
	h: H,
	model: Model,
	id: string,
	value: string,
	suggestions: ReadonlyArray<Suggestion>,
	inputs: Readonly<{ placeholder: string; ariaLabel: string; empty: string; isMono: boolean }>,
): Html => {
	const names = suggestions.map((suggestion) => suggestion.name)
	const current = model.stepCombos[id] ?? Combobox.init(id, "single")
	const counts = new Map(suggestions.map((suggestion) => [suggestion.name, suggestion.count]))
	return h.submodel({
		slotId: `widget-editor-${id}`,
		model: { ...current, inputValue: value, selected: names.includes(value) ? [value] : [] },
		view: ComboboxView.view,
		toParentMessage: (message) => Message.GotStepComboMessage({ id, message }),
		viewInputs: {
			items: names,
			placeholder: inputs.placeholder,
			ariaLabel: inputs.ariaLabel,
			emptyText: inputs.empty,
			size: "sm",
			showTrigger: names.length > 0,
			className: cn("min-w-0 flex-1", inputs.isMono && "font-mono text-xs"),
			renderItem: (name) => {
				const count = counts.get(name)
				return [
					h.span(
						[h.Class("flex min-w-0 items-center gap-2")],
						[
							h.span(
								[
									h.Class(
										cn("min-w-0 flex-1 truncate", inputs.isMono && "font-mono text-xs"),
									),
								],
								[name],
							),
							...(count === null || count === undefined
								? []
								: [
										h.span(
											[
												h.Class(
													"shrink-0 font-mono text-3xs tabular-nums text-muted-foreground",
												),
											],
											[formatNumber(count)],
										),
									]),
						],
					),
				]
			},
			toView: ({ field, rest }) => h.div([h.Class("contents")], [field, ...rest]),
		},
	})
}

const textField = (
	h: H,
	id: string,
	value: string,
	inputs: Readonly<{ placeholder: string; ariaLabel: string; className: string }>,
	onInput: (value: string) => Message,
): Html =>
	input(h, {
		id,
		size: "sm",
		className: inputs.className,
		attributes: [
			h.Value(value),
			h.Placeholder(inputs.placeholder),
			h.AriaLabel(inputs.ariaLabel),
			h.OnInput(onInput),
		],
	})

const SESSION_PLACEHOLDER = {
	referrerHost: "e.g. news.ycombinator.com",
	utmSource: "e.g. twitter",
	utmMedium: "e.g. cpc",
	utmCampaign: "e.g. launch-week",
	country: "e.g. DE",
	host: "e.g. app.example.com",
} as const

const text = (scope: StepScope, index: number, field: StepTextField) => (value: string) =>
	product(ProductEdit.ChangedStepText({ scope, index, field, value }))

/** The step's value inputs: an event name, a page path and host, or a session dimension and value. */
const valueInputs = (
	h: H,
	model: Model,
	options: StepBuilderOptions,
	step: StepDraft,
	index: number,
): ReadonlyArray<Html> => {
	const { scope } = options
	const label = `Step ${index + 1}`
	switch (step.kind) {
		case "event":
			return [
				suggestingInput(
					h,
					model,
					stepComboId(scope, index, "eventName"),
					step.eventName,
					options.eventNames,
					{
						placeholder: "Event name, e.g. signup_completed",
						ariaLabel: `${label} event name`,
						empty: "No events recorded in this window — type a name.",
						isMono: false,
					},
				),
			]
		case "page":
			return [
				suggestingInput(
					h,
					model,
					stepComboId(scope, index, "pagePath"),
					step.pagePath,
					options.pagePaths,
					{
						placeholder: "Page path, e.g. /pricing",
						ariaLabel: `${label} page path`,
						empty: "No page paths in this window — type a path.",
						isMono: true,
					},
				),
				textField(
					h,
					`widget-step-${scope}-${index}-host`,
					step.host ?? "",
					{
						placeholder: "host (optional)",
						ariaLabel: `${label} page host`,
						className: "w-40 min-w-0 shrink-0 font-mono text-xs",
					},
					text(scope, index, "host"),
				),
			]
		case "session":
			return [
				pageSelect(
					h,
					model,
					stepDimensionSelectId(scope, index),
					step.dimension,
					FUNNEL_SESSION_DIMENSIONS.map((dimension) => ({
						value: dimension,
						label: FUNNEL_SESSION_DIMENSION_LABEL[dimension],
					})),
					{
						size: "sm",
						className: "w-32 min-w-0 shrink-0",
						ariaLabel: "Session dimension",
						toView: (parts) => h.div([h.Class("contents")], parts),
					},
				),
				textField(
					h,
					`widget-step-${scope}-${index}-value`,
					step.value,
					{
						placeholder: SESSION_PLACEHOLDER[step.dimension],
						ariaLabel: `${label} session value`,
						className: "min-w-0 flex-1 font-mono text-xs",
					},
					text(scope, index, "value"),
				),
			]
	}
}

const rowActions = (h: H, index: number, total: number): Html =>
	h.div(
		[h.Class("flex shrink-0 items-center")],
		[
			iconButton(
				h,
				{
					label: "Move step up",
					size: "icon-xs",
					isDisabled: index === 0,
					attributes: [h.OnClick(product(ProductEdit.MovedStep({ index, delta: -1 })))],
				},
				[icon(h, "ArrowUpIcon")],
			),
			iconButton(
				h,
				{
					label: "Move step down",
					size: "icon-xs",
					isDisabled: index === total - 1,
					attributes: [h.OnClick(product(ProductEdit.MovedStep({ index, delta: 1 })))],
				},
				[icon(h, "ArrowDownIcon")],
			),
			iconButton(
				h,
				{
					label: "Remove step",
					size: "icon-xs",
					attributes: [h.OnClick(product(ProductEdit.RemovedStep({ index })))],
				},
				[icon(h, "XmarkIcon")],
			),
		],
	)

/** The event step's attribute filter line, its parse error under it. */
const filterLine = (
	h: H,
	model: Model,
	scope: StepScope,
	step: StepDraft & { kind: "event" },
	index: number,
): Html => {
	const filterClause = step.filterClause ?? ""
	const parsed = parseFunnelStepFilter(filterClause)
	return h.div(
		[h.Class("flex flex-col gap-0.5 pl-6")],
		[
			h.div(
				[h.Class("flex items-center gap-1.5")],
				[
					eyebrow(h, { className: "shrink-0" }, ["where"]),
					whereEditor(h, {
						id: `widget-step-${scope}-${index}-filter`,
						value: filterClause,
						ariaLabel: `Step ${index + 1} attribute filter`,
						placeholder: 'plan = "pro" AND source = "cli"',
						rows: 1,
						className: "min-w-0 flex-1",
						textareaClassName: "min-h-[28px] resize-none text-xs",
						onInput: text(scope, index, "filterClause"),
						autocomplete: autocompleteFor(model, stepField(scope, index, filterClause)),
					}),
				],
			),
			...(parsed.ok ? [] : [h.p([h.Class("text-2xs text-severity-error")], [parsed.error])]),
		],
	)
}

const stepRow = (h: H, model: Model, options: StepBuilderOptions, step: StepDraft, index: number): Html => {
	const isSingle = options.maxSteps <= 1
	const total = isSingle ? 1 : options.steps.length
	const kinds =
		index === 0 && !isSingle ? (["event", "page", "session"] as const) : (["event", "page"] as const)
	return panel(h, { className: "gap-1 overflow-visible px-1.5 py-1" }, [
		h.div(
			[h.Class("flex items-center gap-1.5")],
			[
				...(isSingle
					? []
					: [
							h.span(
								[
									h.Class(
										"grid shrink-0 place-items-center rounded-sm bg-muted font-mono text-3xs tabular-nums text-muted-foreground size-5",
									),
									h.AriaLabel(`Step ${index + 1}`),
								],
								[String(index + 1)],
							),
						]),
				pageSelect(
					h,
					model,
					stepKindSelectId(options.scope, index),
					step.kind,
					kinds.map((kind) => ({ value: kind, label: KIND_LABEL[kind] })),
					{
						size: "sm",
						className: "w-24 min-w-0 shrink-0",
						ariaLabel: "Step type",
						toView: (parts) => h.div([h.Class("contents")], parts),
					},
				),
				h.div(
					[h.Class("flex min-w-0 flex-1 items-center gap-1.5")],
					valueInputs(h, model, options, step, index),
				),
				...(isSingle ? [] : [rowActions(h, index, total)]),
			],
		),
		...(options.eventStepFilter && step.kind === "event"
			? [filterLine(h, model, options.scope, step, index)]
			: []),
	])
}

/** `FunnelStepBuilder compact`. */
export const stepBuilder = (h: H, model: Model, options: StepBuilderOptions): Html => {
	const isSingle = options.maxSteps <= 1
	const isFull = options.steps.length >= options.maxSteps
	return h.div(
		[h.Class("flex flex-col gap-1.5")],
		[
			...options.steps.map((step, index) => stepRow(h, model, options, step, index)),
			...(isSingle
				? []
				: [
						button(
							h,
							{
								variant: "outline",
								size: "sm",
								isDisabled: isFull,
								className: "w-fit",
								attributes: [h.OnClick(product(ProductEdit.AddedStep()))],
							},
							[
								icon(h, "PlusIcon"),
								"Add step",
								...(isFull
									? [
											h.span(
												[h.Class("text-muted-foreground")],
												[`(max ${options.maxSteps})`],
											),
										]
									: []),
							],
						),
					]),
		],
	)
}

export { FUNNEL_MAX_STEPS }

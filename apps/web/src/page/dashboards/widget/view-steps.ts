import { formatNumber } from "@maple/domain/format"
import { FUNNEL_MAX_STEPS, FUNNEL_SESSION_DIMENSION_LABEL } from "@maple/query-model"
import { cn } from "@maple/ui/lib/utils"
import { FUNNEL_SESSION_DIMENSIONS } from "../../../components/funnels/definition"
import { parseFunnelStepFilter } from "../../../lib/query-builder/funnel-filters"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import * as Combobox from "@maple/views/ui/combobox"
import * as ComboboxView from "@maple/views/ui/combobox-view"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { input } from "@maple/views/ui/input"
import { panel } from "@maple/views/ui/panel"
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
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

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
	const names = Arr.map(suggestions, (suggestion) => suggestion.name)
	const current = model.stepCombos[id] ?? Combobox.init(id, "single")
	const counts = new Map(Arr.map(suggestions, (suggestion) => [suggestion.name, suggestion.count]))
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
			className: cn("min-w-0 flex-1", inputs.isMono && typographyClass({ size: "xs", mono: true })),
			renderItem: (name) => {
				const count = counts.get(name)
				return [
					hstack(h, { gap: "2", shrink: true, as: "span" }, [
						h.span(
							[
								h.Class(
									cn(
										typographyClass({ truncate: true, className: "min-w-0 flex-1" }),
										inputs.isMono && typographyClass({ size: "xs", mono: true }),
									),
								),
							],
							[name],
						),
						...(count === null || count === undefined
							? []
							: [
									typography(
										h,
										{
											size: "3xs",
											tone: "muted",
											mono: true,
											numeric: true,
											className: "shrink-0",
										},
										[formatNumber(count)],
									),
								]),
					]),
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
						empty: "No events recorded in this window. Type a name.",
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
						empty: "No page paths in this window. Type a path.",
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
					Arr.map(FUNNEL_SESSION_DIMENSIONS, (dimension) => ({
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
	hstack(h, { className: "shrink-0" }, [
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
	])

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
	return vstack(h, { gap: "0.5", className: "pl-6" }, [
		hstack(h, { gap: "1.5" }, [
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
		]),
		...(parsed.ok ? [] : [typography(h, { size: "2xs", tone: "error", as: "p" }, [parsed.error])]),
	])
}

const stepRow = (h: H, model: Model, options: StepBuilderOptions, step: StepDraft, index: number): Html => {
	const isSingle = options.maxSteps <= 1
	const total = isSingle ? 1 : options.steps.length
	const kinds =
		index === 0 && !isSingle ? (["event", "page", "session"] as const) : (["event", "page"] as const)
	return panel(h, { className: "gap-1 overflow-visible px-1.5 py-1" }, [
		hstack(h, { gap: "1.5" }, [
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
				Arr.map(kinds, (kind) => ({ value: kind, label: KIND_LABEL[kind] })),
				{
					size: "sm",
					className: "w-24 min-w-0 shrink-0",
					ariaLabel: "Step type",
					toView: (parts) => h.div([h.Class("contents")], parts),
				},
			),
			hstack(
				h,
				{ gap: "1.5", align: "center", shrink: true, grow: true },
				valueInputs(h, model, options, step, index),
			),
			...(isSingle ? [] : [rowActions(h, index, total)]),
		]),
		...(options.eventStepFilter && step.kind === "event"
			? [filterLine(h, model, options.scope, step, index)]
			: []),
	])
}

/** `FunnelStepBuilder compact`. */
export const stepBuilder = (h: H, model: Model, options: StepBuilderOptions): Html => {
	const isSingle = options.maxSteps <= 1
	const isFull = options.steps.length >= options.maxSteps
	return vstack(h, { gap: "1.5" }, [
		...Arr.map(options.steps, (step, index) => stepRow(h, model, options, step, index)),
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
								? [typography(h, { tone: "muted" }, [`(max ${options.maxSteps})`])]
								: []),
						],
					),
				]),
	])
}

export { FUNNEL_MAX_STEPS }

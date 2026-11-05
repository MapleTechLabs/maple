import { formatNumber } from "@maple/domain/format"
import {
	FUNNEL_SESSION_DIMENSION_LABEL,
	FunnelPageStep,
	FunnelSessionDimension,
	FunnelSessionStep,
} from "@maple/query-model"
import { cn } from "@maple/ui/lib/utils"
import { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineTaggedUnion } from "foldkit/schema"
import { Option, Schema } from "effect"
import { button } from "@maple/views/ui/button"
import * as Combobox from "@maple/views/ui/combobox"
import * as ComboboxView from "@maple/views/ui/combobox-view"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { input } from "@maple/views/ui/input"
import { panel } from "@maple/views/ui/panel"
import * as Select from "@maple/views/ui/select"
import { view as selectView, type SelectOption } from "@maple/views/ui/select-view"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { FUNNEL_SESSION_DIMENSIONS } from "../../components/funnels/definition"

// The funnel step builder: an ordered list of steps, each an event name, a page path or (first
// step only) a session dimension. The dashboard funnel and paths editors and /product-analytics
// mount it; the caller keeps the combobox and select states and applies the `StepEdit`s.

const StepKind = Schema.Literals(["event", "page", "session"])
type StepKind = typeof StepKind.Type

const StepTextField = Schema.Literals(["eventName", "pagePath", "host", "value", "filterClause"])
type StepTextField = typeof StepTextField.Type

/** Which builder a control belongs to: a funnel's steps, or a paths view's single anchor. */
export const StepScope = Schema.Literals(["funnel", "paths"])
export type StepScope = typeof StepScope.Type

/** `FunnelStepDraft` (funnel-filters.ts): the wire step plus an event step's filter as typed. */
export const StepDraft = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("event"),
		eventName: Schema.String,
		attributeEquals: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
		filterClause: Schema.optionalKey(Schema.String),
	}),
	FunnelPageStep,
	FunnelSessionStep,
])
export type StepDraft = typeof StepDraft.Type

/** A name to pick for a step, with how often it was seen (`null` when unknown). */
export type StepSuggestion = Readonly<{ name: string; count: number | null }>

/** What the builder's controls ask of the step list. */
export const StepEdit = defineTaggedUnion({
	SetKind: { index: Schema.Number, kind: StepKind },
	ChangedText: { index: Schema.Number, field: StepTextField, value: Schema.String },
	SetDimension: { index: Schema.Number, dimension: FunnelSessionDimension },
	Moved: { index: Schema.Number, delta: Schema.Number },
	Removed: { index: Schema.Number },
	Added: {},
})
export type StepEdit = typeof StepEdit.Type

/** `withKind`: a step's kind changed, carrying nothing over. */
const withKind = (step: StepDraft, kind: StepKind): StepDraft => {
	if (step.kind === kind) return step
	switch (kind) {
		case "event":
			return { kind: "event", eventName: "" }
		case "page":
			return { kind: "page", pagePath: "" }
		case "session":
			return { kind: "session", dimension: "referrerHost", value: "" }
	}
}

/** A typed field of a step; an emptied host or filter drops its key. */
const withText = (step: StepDraft, field: StepTextField, value: string): StepDraft => {
	switch (step.kind) {
		case "event": {
			if (field === "eventName") return { ...step, eventName: value }
			if (field !== "filterClause") return step
			const { filterClause: _clause, ...rest } = step
			return value === "" ? rest : { ...rest, filterClause: value }
		}
		case "page": {
			if (field === "pagePath") return { ...step, pagePath: value }
			if (field !== "host") return step
			const { host: _host, ...rest } = step
			return value === "" ? rest : { ...rest, host: value }
		}
		case "session":
			return field === "value" ? { ...step, value } : step
	}
}

/** `move`: an item moved within the list; out of range is a no-op. */
const move = <T>(items: ReadonlyArray<T>, from: number, to: number): ReadonlyArray<T> => {
	const item = items[from]
	if (to < 0 || to >= items.length || item === undefined) return items
	const rest = items.filter((_, index) => index !== from)
	return [...rest.slice(0, to), item, ...rest.slice(to)]
}

/** A step moved; a session step past step 1 is demoted to an event step (`reorder`). */
const reorderSteps = (steps: ReadonlyArray<StepDraft>, from: number, to: number): ReadonlyArray<StepDraft> =>
	move(steps, from, to).map((step, index) =>
		index > 0 && step.kind === "session" ? withKind(step, "event") : step,
	)

const updateAt = <T>(items: ReadonlyArray<T>, index: number, update: (item: T) => T): ReadonlyArray<T> =>
	items.map((item, position) => (position === index ? update(item) : item))

/** A `StepEdit` applied to a step list; adding stops at `maxSteps`. */
export const applyStepEdit = (
	steps: ReadonlyArray<StepDraft>,
	edit: StepEdit,
	maxSteps: number,
): ReadonlyArray<StepDraft> => {
	switch (edit._tag) {
		case "SetKind":
			return updateAt(steps, edit.index, (step) => withKind(step, edit.kind))
		case "ChangedText":
			return updateAt(steps, edit.index, (step) => withText(step, edit.field, edit.value))
		case "SetDimension":
			return updateAt(steps, edit.index, (step) =>
				step.kind === "session" ? { ...step, dimension: edit.dimension } : step,
			)
		case "Moved":
			return reorderSteps(steps, edit.index, edit.index + edit.delta)
		case "Removed":
			return steps.filter((_, index) => index !== edit.index)
		case "Added":
			return steps.length >= maxSteps ? steps : [...steps, { kind: "event", eventName: "" }]
	}
}

/** A `StepEdit` applied to a paths anchor; an edit that would make it a session step is dropped. */
export const applyAnchorEdit = (anchor: StepDraft, edit: StepEdit): StepDraft => {
	const [next] = applyStepEdit([anchor], edit, 1)
	return next === undefined || next.kind === "session" ? anchor : next
}

// Control ids: `step-<control>-<scope>-<index>`, so one parent can hold several builders. No `:` or
// `.`: the combobox finds its input with the id in a CSS selector.

type StepControl = "kind" | "dimension" | "eventName" | "pagePath" | "host" | "value"

export const stepControlId = (scope: StepScope, index: number, control: StepControl): string =>
	`step-${control}-${scope}-${index}`

export type ScopedStepEdit = Readonly<{ scope: StepScope; edit: StepEdit }>

const decodeKind = Schema.decodeUnknownOption(StepKind)
const decodeScope = Schema.decodeUnknownOption(StepScope)
const decodeDimension = Schema.decodeUnknownOption(FunnelSessionDimension)

/** A control's new value as the edit it makes, and the builder it belongs to; `None` for another id. */
export const stepEditOf = (id: string, value: string): Option.Option<ScopedStepEdit> => {
	const match = /^step-(kind|dimension|eventName|pagePath)-(funnel|paths)-(\d+)$/.exec(id)
	const [, control, rawScope, rawIndex] = match ?? []
	const scope = decodeScope(rawScope)
	if (control === undefined || Option.isNone(scope) || rawIndex === undefined) return Option.none()
	const index = Number(rawIndex)
	const edit: Option.Option<StepEdit> =
		control === "kind"
			? Option.map(decodeKind(value), (kind) => StepEdit.SetKind({ index, kind }))
			: control === "dimension"
				? Option.map(decodeDimension(value), (dimension) =>
						StepEdit.SetDimension({ index, dimension }),
					)
				: Option.some(
						StepEdit.ChangedText({
							index,
							field: control === "pagePath" ? "pagePath" : "eventName",
							value,
						}),
					)
	return Option.map(edit, (stepEdit) => ({ scope: scope.value, edit: stepEdit }))
}

/**
 * `SuggestingInput`'s update: the value is whatever was typed, and picking a suggestion types it.
 * `edit` is the step edit that makes, and `isTyping` tells a keystroke from a pick.
 */
export const stepComboUpdate = <M>(
	combos: Readonly<Record<string, Combobox.Model>>,
	id: string,
	message: Combobox.Message,
	toMessage: (message: Combobox.Message) => M,
) => {
	const next = Combobox.update(combos[id] ?? Combobox.init(id, "single"), message)
	const typed: Option.Option<string> =
		message._tag === "ChangedInput"
			? Option.some(message.value)
			: next.outMessage?._tag === "ChangedValue"
				? Option.some(next.outMessage.value)
				: Option.none()
	return {
		combos: { ...combos, [id]: next.model },
		commands: Command.mapMessages(next.commands ?? [], toMessage),
		edit: Option.flatMap(typed, (value) => stepEditOf(id, value)),
		isTyping: message._tag === "ChangedInput",
	}
}

// View

const KIND_LABEL = { event: "Event", page: "Page", session: "Session" } as const

const SESSION_PLACEHOLDER = {
	referrerHost: "e.g. news.ycombinator.com",
	utmSource: "e.g. twitter",
	utmMedium: "e.g. cpc",
	utmCampaign: "e.g. launch-week",
	country: "e.g. DE",
	host: "e.g. app.example.com",
} as const

export type StepBuilderOptions<M> = Readonly<{
	/** Names this builder's controls apart from another one on the page. */
	scope: StepScope
	/** Prefixes the submodel slots, unique per page. */
	slotPrefix: string
	steps: ReadonlyArray<StepDraft>
	eventNames: ReadonlyArray<StepSuggestion>
	pagePaths: ReadonlyArray<StepSuggestion>
	maxSteps: number
	combos: Readonly<Record<string, Combobox.Model>>
	selects: Readonly<Record<string, Select.Model>>
	onCombo: (id: string, message: Combobox.Message) => M
	onSelect: (id: string, message: Select.Message) => M
	onEdit: (edit: StepEdit) => M
	/** Drawn under an event step's row: the dashboard's attribute filter. */
	eventStepExtra?: ((step: StepDraft & { kind: "event" }, index: number) => Html) | undefined
}>

const stepSelect = <M>(
	h: HtmlBuilder<M>,
	options: StepBuilderOptions<M>,
	id: string,
	value: string,
	items: ReadonlyArray<SelectOption>,
	inputs: Readonly<{ className: string; ariaLabel: string }>,
): Html => {
	const index = items.findIndex((item) => item.value === value)
	const current =
		options.selects[id] ?? Select.init(id, { value, selectedIndex: index === -1 ? null : index })
	return h.submodel({
		slotId: `${options.slotPrefix}-select-${id}`,
		model: { ...current, value },
		view: selectView,
		toParentMessage: (message) => options.onSelect(id, message),
		viewInputs: {
			entries: items.map((item) => ({ _tag: "Item" as const, item })),
			size: "sm",
			className: inputs.className,
			ariaLabel: inputs.ariaLabel,
			toView: (parts) => h.div([h.Class("contents")], parts),
		},
	})
}

/** `SuggestingInput`: free text, with the window's names to pick from. */
const suggestingInput = <M>(
	h: HtmlBuilder<M>,
	options: StepBuilderOptions<M>,
	id: string,
	value: string,
	suggestions: ReadonlyArray<StepSuggestion>,
	inputs: Readonly<{ placeholder: string; ariaLabel: string; empty: string; isMono: boolean }>,
): Html => {
	const names = suggestions.map((suggestion) => suggestion.name)
	const current = options.combos[id] ?? Combobox.init(id, "single")
	const counts = new Map(suggestions.map((suggestion) => [suggestion.name, suggestion.count]))
	return h.submodel({
		slotId: `${options.slotPrefix}-${id}`,
		model: { ...current, inputValue: value, selected: names.includes(value) ? [value] : [] },
		view: ComboboxView.view,
		toParentMessage: (message) => options.onCombo(id, message),
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
						typography(
							h,
							{
								truncate: true,
								size: inputs.isMono ? "xs" : undefined,
								mono: inputs.isMono,
								className: "min-w-0 flex-1",
							},
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

const textField = <M>(
	h: HtmlBuilder<M>,
	id: string,
	value: string,
	inputs: Readonly<{ placeholder: string; ariaLabel: string; className: string }>,
	onInput: (value: string) => M,
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

/** The step's value inputs: an event name, a page path and host, or a session dimension and value. */
const valueInputs = <M>(
	h: HtmlBuilder<M>,
	options: StepBuilderOptions<M>,
	step: StepDraft,
	index: number,
): ReadonlyArray<Html> => {
	const { scope } = options
	const label = `Step ${index + 1}`
	const text = (field: StepTextField) => (value: string) =>
		options.onEdit(StepEdit.ChangedText({ index, field, value }))
	switch (step.kind) {
		case "event":
			return [
				suggestingInput(
					h,
					options,
					stepControlId(scope, index, "eventName"),
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
					options,
					stepControlId(scope, index, "pagePath"),
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
					stepControlId(scope, index, "host"),
					step.host ?? "",
					{
						placeholder: "host (optional)",
						ariaLabel: `${label} page host`,
						className: "w-40 min-w-0 shrink-0 font-mono text-xs",
					},
					text("host"),
				),
			]
		case "session":
			return [
				stepSelect(
					h,
					options,
					stepControlId(scope, index, "dimension"),
					step.dimension,
					FUNNEL_SESSION_DIMENSIONS.map((dimension) => ({
						value: dimension,
						label: FUNNEL_SESSION_DIMENSION_LABEL[dimension],
					})),
					{ className: "w-32 min-w-0 shrink-0", ariaLabel: "Session dimension" },
				),
				textField(
					h,
					stepControlId(scope, index, "value"),
					step.value,
					{
						placeholder: SESSION_PLACEHOLDER[step.dimension],
						ariaLabel: `${label} session value`,
						className: "min-w-0 flex-1 font-mono text-xs",
					},
					text("value"),
				),
			]
	}
}

const rowActions = <M>(
	h: HtmlBuilder<M>,
	options: StepBuilderOptions<M>,
	index: number,
	total: number,
): Html =>
	hstack(h, { className: "shrink-0" }, [
		iconButton(
			h,
			{
				label: "Move step up",
				size: "icon-xs",
				isDisabled: index === 0,
				attributes: [h.OnClick(options.onEdit(StepEdit.Moved({ index, delta: -1 })))],
			},
			[icon(h, "ArrowUpIcon")],
		),
		iconButton(
			h,
			{
				label: "Move step down",
				size: "icon-xs",
				isDisabled: index === total - 1,
				attributes: [h.OnClick(options.onEdit(StepEdit.Moved({ index, delta: 1 })))],
			},
			[icon(h, "ArrowDownIcon")],
		),
		iconButton(
			h,
			{
				label: "Remove step",
				size: "icon-xs",
				attributes: [h.OnClick(options.onEdit(StepEdit.Removed({ index })))],
			},
			[icon(h, "XmarkIcon")],
		),
	])

const stepRow = <M>(
	h: HtmlBuilder<M>,
	options: StepBuilderOptions<M>,
	step: StepDraft,
	index: number,
): Html => {
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
			stepSelect(
				h,
				options,
				stepControlId(options.scope, index, "kind"),
				step.kind,
				kinds.map((kind) => ({ value: kind, label: KIND_LABEL[kind] })),
				{ className: "w-24 min-w-0 shrink-0", ariaLabel: "Step type" },
			),
			hstack(h, { gap: "1.5", grow: true, className: "min-w-0" }, valueInputs(h, options, step, index)),
			...(isSingle ? [] : [rowActions(h, options, index, total)]),
		]),
		...(options.eventStepExtra !== undefined && step.kind === "event"
			? [options.eventStepExtra(step, index)]
			: []),
	])
}

/** `FunnelStepBuilder compact`: one row per step, then Add step (a single anchor has neither numbers nor Add). */
export const stepBuilder = <M>(h: HtmlBuilder<M>, options: StepBuilderOptions<M>): Html => {
	const isSingle = options.maxSteps <= 1
	const isFull = options.steps.length >= options.maxSteps
	return vstack(h, { gap: "1.5" }, [
		...options.steps.map((step, index) => stepRow(h, options, step, index)),
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
							attributes: [h.OnClick(options.onEdit(StepEdit.Added()))],
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

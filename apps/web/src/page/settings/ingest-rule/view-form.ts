import {
	IngestRuleField,
	IngestRuleOp,
	IngestRuleSignal,
	SEVERITY_LEVELS,
	SPAN_KINDS,
	SPAN_STATUSES,
	opsForField,
} from "@maple/domain/ingest-rules"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Autocomplete from "../../../ui/autocomplete"
import { button } from "../../../ui/button"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { input } from "../../../ui/input"
import { label } from "../../../ui/label"
import { nativeOption, nativeSelect } from "../../../ui/native-select"
import { multiSegmentedSelect } from "../../../ui/segmented-select"
import { toggle } from "../../../ui/toggle"
import * as Combobox from "../../../ui/combobox"
import {
	type ConditionDraft,
	FIELD_LABELS,
	fieldsFor,
	isKeyed,
	isListOp,
	isPresenceOp,
	OP_LABELS,
	splitList,
} from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import { SIGNAL_LABELS } from "./summary"
import { keyBoxId } from "./update"

// The "When ... where ..." half of the sentence: signals and conditions.

export type H = HtmlBuilder<Message>

/** One clause of the sentence: a lead word beside its controls. */
export const clause = (h: H, lead: string, children: ReadonlyArray<Html>): Html =>
	h.section(
		[h.Class("flex flex-col gap-3 border-t pt-5 sm:flex-row sm:gap-4")],
		[
			eyebrow(h, { variant: "mono", className: "w-14 shrink-0 pt-1.5", as: "div" }, [lead]),
			h.div([h.Class("flex min-w-0 flex-1 flex-col gap-3")], children),
		],
	)

const isField = (value: string): value is IngestRuleField =>
	IngestRuleField.literals.some((field) => field === value)
const isOp = (value: string): value is IngestRuleOp => IngestRuleOp.literals.some((op) => op === value)

export const signalsClause = (h: H, model: Model): Html =>
	clause(h, "When", [
		multiSegmentedSelect<IngestRuleSignal, Message>(h, {
			size: "sm",
			ariaLabel: "Signals",
			value: model.draft.signals,
			onToggle: (signal) => Message.ToggledSignal({ signal }),
			options: IngestRuleSignal.literals.map((signal) => ({
				value: signal,
				label: SIGNAL_LABELS[signal],
				ariaLabel: SIGNAL_LABELS[signal],
			})),
			className: "self-start",
		}),
		h.p([h.Class("text-muted-foreground text-xs")], ["arrive at Maple"]),
	])

const select = (
	h: H,
	options: Readonly<{
		id: string
		label: string
		value: string
		entries: ReadonlyArray<{ readonly value: string; readonly label: string }>
		onChange: (value: string) => Message
		className?: string
	}>,
): Html =>
	h.div(
		// A new option set gets a new element, and `Value` keeps the shown choice on the model's.
		[
			h.Key(`${options.id}:${options.entries.map((entry) => entry.value).join(",")}`),
			h.Class(cn("flex flex-col gap-1", options.className)),
		],
		[
			label(h, { className: "sr-only", attributes: [h.For(options.id)] }, [options.label]),
			nativeSelect(
				h,
				{
					defaultValue: options.value,
					attributes: [h.Id(options.id), h.Value(options.value), h.OnChange(options.onChange)],
				},
				options.entries.map((entry) => nativeOption(entry.value, entry.label)),
			),
		],
	)

const keyInput = (h: H, model: Model, condition: ConditionDraft): Html => {
	const items =
		condition.field === "resource_attribute"
			? model.resourceKeys
			: [
					...new Set([
						...(model.draft.signals.includes("traces") ? model.spanKeys : []),
						...(model.draft.signals.includes("logs") ? model.logKeys : []),
					]),
				]
	return h.submodel({
		slotId: `ingest-rule-key-slot-${condition.id}`,
		model: model.keyBoxes[String(condition.id)] ?? Combobox.init(keyBoxId(condition.id), "autocomplete"),
		view: Autocomplete.view,
		toParentMessage: (message) => Message.GotKeyMessage({ id: condition.id, message }),
		viewInputs: {
			items,
			ariaLabel: `Condition ${condition.id} key`,
			placeholder: "http.route",
			emptyText: "No matching attributes. Press Enter to use as typed",
			hasStartAddon: false,
			toView: ({ field, rest }) => h.div([h.Class("min-w-40 flex-1")], [field, ...rest]),
		},
	})
}

const chips = (h: H, condition: ConditionDraft, choices: ReadonlyArray<string>): Html => {
	const chosen = splitList(condition.values)
	return h.div(
		[h.Role("group"), h.AriaLabel(`Condition ${condition.id} values`), h.Class("flex flex-wrap gap-1")],
		choices.map((choice) =>
			toggle(
				h,
				{
					size: "sm",
					variant: "outline",
					isPressed: chosen.includes(choice),
					onClick: Message.ToggledConditionValue({ id: condition.id, value: choice }),
				},
				[choice],
			),
		),
	)
}

const operand = (h: H, condition: ConditionDraft): ReadonlyArray<Html> => {
	const id = `ingest-rule-value-${condition.id}`
	if (isPresenceOp(condition.op)) return []
	if (condition.field === "span_kind") return [chips(h, condition, SPAN_KINDS)]
	if (condition.field === "span_status") return [chips(h, condition, SPAN_STATUSES)]
	if (condition.field === "severity")
		return [
			select(h, {
				id,
				label: `Condition ${condition.id} level`,
				value: condition.value,
				entries: Object.keys(SEVERITY_LEVELS).map((level) => ({ value: level, label: level })),
				onChange: (value) => Message.ChangedConditionValue({ id: condition.id, value }),
			}),
		]
	const isList = isListOp(condition.op)
	return [
		input(h, {
			id,
			className: "min-w-40 flex-1",
			attributes: [
				h.AriaLabel(isList ? `Condition ${condition.id} values` : `Condition ${condition.id} value`),
				h.Value(isList ? condition.values : condition.value),
				h.Placeholder(isList ? "a, b, c" : condition.op === "regex" ? "^GET /health" : "value"),
				h.OnInput((value) =>
					isList
						? Message.ChangedConditionValues({ id: condition.id, values: value })
						: Message.ChangedConditionValue({ id: condition.id, value }),
				),
			],
		}),
	]
}

const conditionRow = (h: H, model: Model, condition: ConditionDraft, index: number): Html =>
	h.div(
		[h.Key(String(condition.id)), h.Class("flex flex-wrap items-center gap-2")],
		[
			h.span([h.Class("text-muted-foreground w-8 shrink-0 text-xs")], [index === 0 ? "" : "and"]),
			select(h, {
				id: `ingest-rule-field-${condition.id}`,
				label: `Condition ${condition.id} field`,
				value: condition.field,
				entries: fieldsFor(model.draft.signals).map((field) => ({
					value: field,
					label: FIELD_LABELS[field],
				})),
				onChange: (value) =>
					Message.ChangedConditionField({
						id: condition.id,
						field: isField(value) ? value : "service_name",
					}),
			}),
			...(isKeyed(condition.field) ? [keyInput(h, model, condition)] : []),
			select(h, {
				id: `ingest-rule-op-${condition.id}`,
				label: `Condition ${condition.id} operator`,
				value: condition.op,
				entries: opsForField(condition.field).map((op) => ({ value: op, label: OP_LABELS[op] })),
				onChange: (value) =>
					Message.ChangedConditionOp({ id: condition.id, op: isOp(value) ? value : "eq" }),
			}),
			...operand(h, condition),
			iconButton(
				h,
				{
					label: `Remove condition ${condition.id}`,
					attributes: [h.OnClick(Message.RemovedCondition({ id: condition.id }))],
				},
				[icon(h, "XmarkIcon")],
			),
		],
	)

export const conditionsClause = (h: H, model: Model): Html =>
	clause(h, "Where", [
		...(model.draft.conditions.length === 0
			? [
					h.p(
						[h.Class("text-muted-foreground text-sm")],
						["Every record matches. Add a condition to narrow it."],
					),
				]
			: model.draft.conditions.map((condition, index) => conditionRow(h, model, condition, index))),
		h.div(
			[],
			[
				button(
					h,
					{ variant: "outline", size: "sm", attributes: [h.OnClick(Message.AddedCondition())] },
					[
						icon(h, "PlusIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }),
						"Add condition",
					],
				),
			],
		),
	])

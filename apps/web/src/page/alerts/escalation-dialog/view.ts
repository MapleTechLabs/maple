import { MAX_ESCALATION_STEPS } from "@maple/domain/http"
import type { AlertDestinationRow } from "@maple/web-data/collections/alerts"
import { Option, Array as Arr } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button } from "@maple/views/ui/button"
import {
	fieldDescription,
	fieldError,
	fieldErrorText,
	type FieldIds,
	fieldLabel,
	input,
} from "@maple/views/ui/field"
import { formDialog } from "@maple/views/ui/form-dialog"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import type { FieldState } from "@maple/views/ui/input"
import * as Menu from "@maple/views/ui/menu"
import { panel } from "@maple/views/ui/panel"
import { hstack, vstack } from "@maple/views/ui/stack"
import { textarea } from "@maple/views/ui/textarea"
import { typography } from "@maple/views/ui/typography"
import { destinationPicker } from "../../kit/destination-picker"
import { formatWait } from "../shared/escalation-chains"
import {
	descriptionError,
	menuIdOf,
	Message,
	type Model,
	nameError,
	numberOf,
	repeatError,
	type StepDraft,
	stepsError,
	targetsError,
	waitError,
} from "./dialog"

type H = HtmlBuilder<Message>

export type ViewInputs = Readonly<{
	id: string
	/** The synced destinations steps pick from; `null` until they arrive. */
	destinations: ReadonlyArray<AlertDestinationRow> | null
}>

const stateOf = (value: string, isInvalid: boolean): FieldState => ({
	isInvalid,
	isDirty: false,
	isFilled: value !== "",
	isFocused: false,
	isTouched: false,
})

const idsOf = (id: string, name: string, hasDescription = false): FieldIds => ({
	control: `${id}-${name}`,
	label: `${id}-${name}-label`,
	error: `${id}-${name}-error`,
	...(hasDescription ? { description: `${id}-${name}-description` } : undefined),
})

/** A field's error once a save was tried, or at once for a number typed out of range. */
const shownError = (model: Model, error: Option.Option<string>, isImmediate = false): Option.Option<string> =>
	model.isShowingErrors || isImmediate ? error : Option.none()

const errorLine = (
	h: H,
	ids: FieldIds,
	state: FieldState,
	error: Option.Option<string>,
): ReadonlyArray<Html> =>
	Option.match(error, {
		onNone: () => [],
		onSome: (text) => [fieldError(h, { ids, state, attributes: [h.Role("alert")] }, [text])],
	})

const textField = (
	h: H,
	options: Readonly<{
		ids: FieldIds
		label: string
		value: string
		placeholder: string
		error: Option.Option<string>
		onInput: (value: string) => Message
	}>,
): Html => {
	const state = stateOf(options.value, Option.isSome(options.error))
	return vstack(h, { gap: "1.5" }, [
		fieldLabel(h, { ids: options.ids, state }, options.label),
		input(h, {
			ids: options.ids,
			state,
			attributes: [
				h.Value(options.value),
				h.Placeholder(options.placeholder),
				h.OnInput(options.onInput),
				h.Attribute("autocomplete", "off"),
			],
		}),
		...errorLine(h, options.ids, state, options.error),
	])
}

/** A short number input on one line with its label. */
const numberField = (
	h: H,
	options: Readonly<{
		ids: FieldIds
		label: string
		value: string
		min: number
		max: number
		description?: string
		error: Option.Option<string>
		onInput: (value: string) => Message
	}>,
): Html => {
	const state = stateOf(options.value, Option.isSome(options.error))
	return vstack(h, { gap: "1.5" }, [
		hstack(h, { gap: "3", wrap: true }, [
			fieldLabel(h, { ids: options.ids, state, className: "font-normal" }, options.label),
			input(h, {
				ids: options.ids,
				state,
				className: "w-20",
				attributes: [
					h.Type("number"),
					h.Min(String(options.min)),
					h.Attribute("max", String(options.max)),
					h.Attribute("step", "1"),
					h.Value(options.value),
					h.OnInput(options.onInput),
				],
			}),
		]),
		...(options.description === undefined
			? []
			: [fieldDescription(h, { ids: options.ids, state }, [options.description])]),
		...errorLine(h, options.ids, state, options.error),
	])
}

const isOutOfRange = (raw: string, error: Option.Option<string>) => raw !== "" && Option.isSome(error)

const waitLabel = (model: Model, index: number): string =>
	index < model.steps.length - 1
		? "Then wait, in minutes"
		: (numberOf(model.repeatCount) ?? 0) > 0
			? "Wait before repeating, in minutes"
			: // The run ends as soon as the last step pages, so this wait only matters once it repeats.
				"Wait before repeating, in minutes (unused unless the chain repeats)"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** The step's member and schedule targets, which this dialog keeps but cannot edit yet. */
const carriedLine = (h: H, step: StepDraft): ReadonlyArray<Html> => {
	const members = Arr.filter(step.otherTargets, (target) => target.type === "user").length
	const schedules = Arr.filter(step.otherTargets, (target) => target.type === "schedule").length
	const parts = [
		...(members === 0 ? [] : [plural(members, "member", "members")]),
		...(schedules === 0 ? [] : [`whoever is on call on ${plural(schedules, "schedule", "schedules")}`]),
	]
	return parts.length === 0
		? []
		: [
				typography(h, { size: "xs", tone: "muted" }, [
					`Also pages ${Arr.join(parts, " and ")}. Saving keeps them.`,
				]),
			]
}

const stepBlock = (h: H, model: Model, inputs: ViewInputs, step: StepDraft, index: number): Html => {
	const count = model.steps.length
	const previous = index === 0 ? undefined : model.steps[index - 1]
	const wait = waitError(step.waitMinutes)
	const destinations = shownError(model, targetsError(step))
	const key = step.key
	return panel(h, { padded: "sm", className: "gap-3", attributes: [h.Key(key)] }, [
		hstack(h, { gap: "2", justify: "between" }, [
			hstack(h, { gap: "2", shrink: true }, [
				typography(h, { size: "sm", weight: "medium", className: "shrink-0 whitespace-nowrap" }, [
					`Step ${index + 1}`,
				]),
				typography(h, { size: "xs", tone: "muted", truncate: true }, [
					previous === undefined
						? "pages at once"
						: Option.isNone(waitError(previous.waitMinutes))
							? `after ${formatWait(Number(previous.waitMinutes))} without an ack`
							: "after the wait above",
				]),
			]),
			hstack(h, { gap: "0.5" }, [
				iconButton(
					h,
					{
						label: `Move step ${index + 1} up`,
						isDisabled: index === 0,
						attributes: [h.OnClick(Message.ClickedMoveStep({ key, direction: "up" }))],
					},
					[icon(h, "ArrowUpIcon")],
				),
				iconButton(
					h,
					{
						label: `Move step ${index + 1} down`,
						isDisabled: index === count - 1,
						attributes: [h.OnClick(Message.ClickedMoveStep({ key, direction: "down" }))],
					},
					[icon(h, "ArrowDownIcon")],
				),
				iconButton(
					h,
					{
						label: `Remove step ${index + 1}`,
						isDisabled: count === 1,
						attributes: [h.OnClick(Message.ClickedRemoveStep({ key }))],
					},
					[icon(h, "TrashIcon")],
				),
			]),
		]),
		destinationPicker(h, {
			rows: inputs.destinations,
			selectedIds: step.destinationIds,
			menu: model.menus[key] ?? Menu.init(menuIdOf(model, key)),
			toMenuMessage: (message) => Message.GotStepMenuMessage({ key, message }),
			onRemove: (id) => Message.ClickedRemoveDestination({ key, id }),
			emptyText:
				inputs.destinations !== null && inputs.destinations.length === 0
					? "No destinations exist yet. Add one in Routing first."
					: "Pick who this step pages",
		}),
		...carriedLine(h, step),
		...Option.match(destinations, {
			onNone: () => [],
			onSome: (text) => [fieldErrorText(h, { attributes: [h.Role("alert")] }, [text])],
		}),
		numberField(h, {
			ids: idsOf(model.dialog.id, `wait-${key}`),
			label: waitLabel(model, index),
			value: step.waitMinutes,
			min: 1,
			max: 1440,
			error: shownError(model, wait, isOutOfRange(step.waitMinutes, wait)),
			onInput: (value) => Message.ChangedWait({ key, value }),
		}),
	])
}

const stepsSection = (h: H, model: Model, inputs: ViewInputs): Html =>
	vstack(h, { gap: "3" }, [
		hstack(h, { gap: "2", justify: "between" }, [
			typography(h, { size: "sm", weight: "medium" }, ["Steps"]),
			typography(h, { size: "xs", tone: "muted", numeric: true }, [
				`${model.steps.length} of ${MAX_ESCALATION_STEPS}`,
			]),
		]),
		...Arr.map(model.steps, (step, index) => stepBlock(h, model, inputs, step, index)),
		...Option.match(shownError(model, stepsError(model.steps)), {
			onNone: () => [],
			onSome: (text) => [fieldErrorText(h, { attributes: [h.Role("alert")] }, [text])],
		}),
		button(
			h,
			{
				variant: "outline",
				size: "sm",
				className: "self-start",
				isDisabled: model.steps.length >= MAX_ESCALATION_STEPS,
				attributes: [h.OnClick(Message.ClickedAddStep())],
			},
			[icon(h, "PlusIcon"), "Add step"],
		),
	])

const descriptionField = (h: H, model: Model): Html => {
	const ids = idsOf(model.dialog.id, "description")
	const error = shownError(model, descriptionError(model.description))
	const state = stateOf(model.description, Option.isSome(error))
	return vstack(h, { gap: "1.5" }, [
		fieldLabel(h, { ids, state }, "Description"),
		textarea(h, {
			id: ids.control,
			defaultValue: model.description,
			attributes: [
				h.AriaLabelledBy(ids.label),
				h.Placeholder("Optional: who is on this chain and when to change it"),
				h.Rows(2),
				h.OnInput((value) => Message.ChangedDescription({ value })),
			],
		}),
		...errorLine(h, ids, state, error),
	])
}

/** The escalation chain dialog: name, ordered steps of destinations and waits, and repeats. */
export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const repeat = repeatError(model.repeatCount)
	const isEditing = model.editingId !== null
	return formDialog(h, {
		slotId: `${inputs.id}-dialog`,
		model: model.dialog,
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
		className: "sm:max-w-xl",
		title: isEditing ? "Edit escalation chain" : "New escalation chain",
		description:
			"Each step pages its destinations, then waits for someone to acknowledge before paging the next. Acknowledging pauses the chain and resolving ends it.",
		panelClassName: "space-y-5",
		fields: [
			textField(h, {
				ids: idsOf(model.dialog.id, "name"),
				label: "Name",
				value: model.name,
				placeholder: "Checkout on-call",
				error: shownError(model, nameError(model.name)),
				onInput: (value) => Message.ChangedName({ value }),
			}),
			descriptionField(h, model),
			stepsSection(h, model, inputs),
			numberField(h, {
				ids: idsOf(model.dialog.id, "repeat", true),
				label: "Repeat the whole chain",
				value: model.repeatCount,
				min: 0,
				max: 5,
				description: "Extra passes after the first, 0 to 5. 0 runs it once.",
				error: shownError(model, repeat, isOutOfRange(model.repeatCount, repeat)),
				onInput: (value) => Message.ChangedRepeatCount({ value }),
			}),
			...(model.saveError === null
				? []
				: [
						alert(h, { variant: "crit", size: "sm" }, [
							icon(h, "CircleXmarkIcon"),
							alertTitle(h, [isEditing ? "Couldn't save chain" : "Couldn't create chain"]),
							alertDescription(h, [model.saveError]),
						]),
					]),
		],
		onSubmit: Message.ClickedSave(),
		submitLabel: isEditing ? "Save chain" : "Create chain",
		isPending: model.isSaving,
	})
})

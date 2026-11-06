import { MAX_ESCALATION_REPEATS, MAX_ESCALATION_STEPS, MAX_ESCALATION_WAIT_MINUTES } from "@maple/domain/http"
import type { V2EscalationTarget, V2OnCallSchedule } from "@maple/domain/http/v2"
import type { AlertDestinationRow } from "@maple/web-data/collections/alerts"
import { Option, Array as Arr, String as Str } from "effect"
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
import type { MenuEntry } from "@maple/views/ui/menu-view"
import { panel } from "@maple/views/ui/panel"
import { personAvatar } from "@maple/views/ui/person-avatar"
import { hstack, vstack } from "@maple/views/ui/stack"
import { textarea } from "@maple/views/ui/textarea"
import { typography } from "@maple/views/ui/typography"
import { type PickedEntry, pickList } from "../../kit/pick-list"
import { formatWait } from "../shared/escalation-chains"
import { memberName, memberOf, type OrgMember } from "../shared/org-members"
import {
	descriptionError,
	targetKey,
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
	/** The org's members a step can page; `null` until they load. */
	members: ReadonlyArray<OrgMember> | null
	/** The on-call schedules a step can page; `null` until they load. */
	schedules: ReadonlyArray<V2OnCallSchedule> | null
}>

const nameOr = <A extends { readonly id: string; readonly name: string }>(
	rows: ReadonlyArray<A> | null,
	id: string,
	fallback: string,
): string =>
	Option.getOrElse(
		Option.map(
			Arr.findFirst(rows ?? [], (row) => row.id === id),
			(row) => row.name,
		),
		() => (rows === null ? fallback : `Unavailable ${Str.toLowerCase(fallback)}`),
	)

/** A picked target's row: a destination's bell, a member's avatar, a schedule's calendar. */
const targetEntry = (
	h: H,
	inputs: ViewInputs,
	key: string,
	target: V2EscalationTarget,
): PickedEntry<Message> => {
	const onRemove = Message.ClickedRemoveTarget({ key, target: targetKey(target) })
	switch (target.type) {
		case "destination": {
			const name = nameOr(inputs.destinations, target.destination_id, "Destination")
			return {
				key: targetKey(target),
				label: name,
				media: icon(h, "BellIcon", { className: "text-muted-foreground" }),
				removeLabel: `Stop notifying ${name}`,
				onRemove,
			}
		}
		case "user": {
			const name = memberName(inputs.members, target.user_id)
			return {
				key: targetKey(target),
				label: name,
				media: personAvatar(h, {
					name,
					size: "xs",
					imageUrl: Option.getOrUndefined(
						Option.map(memberOf(inputs.members, target.user_id), (member) => member.imageUrl),
					),
				}),
				detail: "email and chat DM",
				removeLabel: `Stop paging ${name}`,
				onRemove,
			}
		}
		case "schedule": {
			const name = nameOr(inputs.schedules, target.schedule_id, "Schedule")
			return {
				key: targetKey(target),
				label: name,
				media: icon(h, "CalendarIcon", { className: "text-muted-foreground" }),
				detail: "whoever is on call",
				removeLabel: `Stop paging ${name}`,
				onRemove,
			}
		}
	}
}

/** The "Add target" menu: destinations, people and schedules not yet on the step, by kind. */
const addEntries = (inputs: ViewInputs, step: StepDraft): ReadonlyArray<MenuEntry> => {
	const picked = new Set(Arr.map(step.targets, targetKey))
	const group = (
		label: string,
		items: ReadonlyArray<Readonly<{ value: string; label: string }>>,
	): ReadonlyArray<MenuEntry> => {
		const open = Arr.filter(items, (item) => !picked.has(item.value))
		return open.length === 0
			? []
			: [
					{
						_tag: "Group",
						label,
						entries: Arr.map(open, (item): MenuEntry => ({ _tag: "Item", ...item })),
					},
				]
	}
	return [
		...group(
			"Destinations",
			Arr.map(inputs.destinations ?? [], (row) => ({
				value: `destination:${row.id}`,
				label: row.name,
			})),
		),
		...group(
			"People",
			Arr.map(inputs.members ?? [], (member) => ({
				value: `user:${member.userId}`,
				label: member.name,
			})),
		),
		...group(
			"Whoever is on call on",
			Arr.map(inputs.schedules ?? [], (schedule) => ({
				value: `schedule:${schedule.id}`,
				label: schedule.name,
			})),
		),
	]
}

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
		isDisabled: boolean
		onInput: (value: string) => Message
	}>,
): Html => {
	const state = stateOf(options.value, Option.isSome(options.error))
	return vstack(h, { gap: "1.5" }, [
		fieldLabel(h, { ids: options.ids, state }, options.label),
		input(h, {
			ids: options.ids,
			state,
			isDisabled: options.isDisabled,
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
		isDisabled: boolean
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
				isDisabled: options.isDisabled,
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

const stepBlock = (h: H, model: Model, inputs: ViewInputs, step: StepDraft, index: number): Html => {
	const count = model.steps.length
	const previous = index === 0 ? undefined : model.steps[index - 1]
	const wait = waitError(step.waitMinutes)
	const targets = shownError(model, targetsError(step.targets))
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
						isDisabled: model.isSaving || index === 0,
						attributes: [h.OnClick(Message.ClickedMoveStep({ key, direction: "up" }))],
					},
					[icon(h, "ArrowUpIcon")],
				),
				iconButton(
					h,
					{
						label: `Move step ${index + 1} down`,
						isDisabled: model.isSaving || index === count - 1,
						attributes: [h.OnClick(Message.ClickedMoveStep({ key, direction: "down" }))],
					},
					[icon(h, "ArrowDownIcon")],
				),
				iconButton(
					h,
					{
						label: `Remove step ${index + 1}`,
						isDisabled: model.isSaving || count === 1,
						attributes: [h.OnClick(Message.ClickedRemoveStep({ key }))],
					},
					[icon(h, "TrashIcon")],
				),
			]),
		]),
		pickList(h, {
			entries: Arr.map(step.targets, (target) => targetEntry(h, inputs, key, target)),
			menu: model.menus[key] ?? Menu.init(menuIdOf(model, key)),
			toMenuMessage: (message) => Message.GotStepMenuMessage({ key, message }),
			addEntries: addEntries(inputs, step),
			addLabel: "Add destination, person or schedule",
			isDisabled: model.isSaving,
			emptyText: "Pick who this step pages",
		}),
		...Option.match(targets, {
			onNone: () => [],
			onSome: (text) => [fieldErrorText(h, { attributes: [h.Role("alert")] }, [text])],
		}),
		numberField(h, {
			ids: idsOf(model.dialog.id, `wait-${key}`),
			label: waitLabel(model, index),
			value: step.waitMinutes,
			min: 1,
			max: MAX_ESCALATION_WAIT_MINUTES,
			error: shownError(model, wait, isOutOfRange(step.waitMinutes, wait)),
			isDisabled: model.isSaving,
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
				isDisabled: model.isSaving || model.steps.length >= MAX_ESCALATION_STEPS,
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
			isDisabled: model.isSaving,
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

/** The escalation chain dialog: name, ordered steps of targets and waits, and repeats. */
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
			"Each step pages its destinations, people and whoever is on call, then waits for someone to acknowledge before paging the next. Acknowledging pauses the chain and resolving ends it.",
		panelClassName: "space-y-5",
		fields: [
			textField(h, {
				ids: idsOf(model.dialog.id, "name"),
				label: "Name",
				value: model.name,
				placeholder: "Checkout on-call",
				error: shownError(model, nameError(model.name)),
				isDisabled: model.isSaving,
				onInput: (value) => Message.ChangedName({ value }),
			}),
			descriptionField(h, model),
			stepsSection(h, model, inputs),
			numberField(h, {
				ids: idsOf(model.dialog.id, "repeat", true),
				label: "Repeat the whole chain",
				value: model.repeatCount,
				min: 0,
				max: MAX_ESCALATION_REPEATS,
				description: `Extra passes after the first, 0 to ${MAX_ESCALATION_REPEATS}. 0 runs it once.`,
				error: shownError(model, repeat, isOutOfRange(model.repeatCount, repeat)),
				isDisabled: model.isSaving,
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

import {
	AlertDestinationId,
	EscalationChainDescription,
	EscalationChainId,
	EscalationChainName,
	EscalationRepeatCount,
	EscalationWaitMinutes,
	MAX_ESCALATION_REPEATS,
	MAX_ESCALATION_STEPS,
	MAX_ESCALATION_STEP_TARGETS,
	MAX_ESCALATION_WAIT_MINUTES,
} from "@maple/domain/http"
import {
	V2EscalationChain,
	V2EscalationChainCreateParams,
	type V2EscalationStep,
} from "@maple/domain/http/v2"
import { Effect, Option, Result, Schema, Array as Arr, String as Str } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import type { Resources } from "../../../platform/resources"
import { saveEscalationChain } from "../shared/escalation-chains"

// "New escalation chain" / "Edit escalation chain": the Routing tab's dialog, as one Submodel.

/** One step as the form holds it; `key` keeps a step's row (and its menu) across reorders. */
export const StepDraft = Schema.Struct({
	key: Schema.String,
	destinationIds: Schema.Array(AlertDestinationId),
	waitMinutes: Schema.String,
})
export type StepDraft = typeof StepDraft.Type

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	editingId: Schema.NullOr(EscalationChainId),
	name: Schema.String,
	description: Schema.String,
	steps: Schema.Array(StepDraft),
	repeatCount: Schema.String,
	nextKey: Schema.Number,
	/** Each step's "Add destination" menu, by step key. */
	menus: Schema.Record(Schema.String, Menu.Model),
	isSaving: Schema.Boolean,
	/** A save was tried: every field shows what is wrong with it. */
	isShowingErrors: Schema.Boolean,
	saveError: Schema.NullOr(Schema.String),
	/** Bumped on every open: a save's result only settles the form it was sent from. */
	openCount: Schema.Number,
})
export type Model = typeof Model.Type

export const DEFAULT_WAIT_MINUTES = "10"

const emptyStep = (key: number): StepDraft => ({
	key: `s${key}`,
	destinationIds: [],
	waitMinutes: DEFAULT_WAIT_MINUTES,
})

export const init = (id: string): Model => ({
	dialog: Dialog.init(id, "dialog"),
	editingId: null,
	name: "",
	description: "",
	steps: [emptyStep(0)],
	repeatCount: "0",
	nextKey: 1,
	menus: {},
	isSaving: false,
	isShowingErrors: false,
	saveError: null,
	openCount: 0,
})

export const Direction = Schema.Literals(["up", "down"])

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	ChangedName: { value: Schema.String },
	ChangedDescription: { value: Schema.String },
	ChangedRepeatCount: { value: Schema.String },
	ChangedWait: { key: Schema.String, value: Schema.String },
	ClickedAddStep: {},
	ClickedRemoveStep: { key: Schema.String },
	ClickedMoveStep: { key: Schema.String, direction: Direction },
	GotStepMenuMessage: { key: Schema.String, message: Menu.Message },
	ClickedRemoveDestination: { key: Schema.String, id: AlertDestinationId },
	ClickedSave: {},
	CompletedSave: { openCount: Schema.Number, result: Schema.Result(V2EscalationChain, LoadFailure) },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	SavedChain: { chain: V2EscalationChain, isNew: Schema.Boolean },
})
export type OutMessage = typeof OutMessage.Type

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

export const menuIdOf = (model: Pick<Model, "dialog">, key: string): string =>
	`${model.dialog.id}-step-${key}`

// VALIDATION: the same limits the API's schemas hold.

const isName = Schema.is(EscalationChainName)
const isDescription = Schema.is(EscalationChainDescription)
const isWait = Schema.is(EscalationWaitMinutes)
const isRepeat = Schema.is(EscalationRepeatCount)

export const numberOf = (raw: string): number | null =>
	Str.isEmpty(Str.trim(raw)) ? null : Number(Str.trim(raw))

export const nameError = (name: string): Option.Option<string> =>
	Str.isEmpty(Str.trim(name))
		? Option.some("Name the chain")
		: isName(Str.trim(name))
			? Option.none()
			: Option.some("Keep the name to 120 characters")

export const descriptionError = (description: string): Option.Option<string> =>
	isDescription(Str.trim(description))
		? Option.none()
		: Option.some("Keep the description to 500 characters")

export const waitError = (raw: string): Option.Option<string> =>
	isWait(numberOf(raw)) ? Option.none() : Option.some(`Wait 1 to ${MAX_ESCALATION_WAIT_MINUTES} minutes`)

export const repeatError = (raw: string): Option.Option<string> =>
	isRepeat(numberOf(raw)) ? Option.none() : Option.some(`Repeat 0 to ${MAX_ESCALATION_REPEATS} times`)

export const destinationsError = (ids: ReadonlyArray<AlertDestinationId>): Option.Option<string> =>
	ids.length === 0
		? Option.some("Pick at least one destination")
		: ids.length > MAX_ESCALATION_STEP_TARGETS
			? Option.some(`A step notifies at most ${MAX_ESCALATION_STEP_TARGETS} destinations`)
			: Option.none()

export const stepsError = (steps: ReadonlyArray<StepDraft>): Option.Option<string> =>
	steps.length === 0
		? Option.some("Add at least one step")
		: steps.length > MAX_ESCALATION_STEPS
			? Option.some(`A chain has at most ${MAX_ESCALATION_STEPS} steps`)
			: Option.none()

const stepOf = (step: StepDraft): Option.Option<V2EscalationStep> => {
	const targets = Arr.map(step.destinationIds, (id) => ({
		type: "destination" as const,
		destination_id: id,
	}))
	const minutes = numberOf(step.waitMinutes)
	return Arr.isReadonlyArrayNonEmpty(targets) &&
		Option.isNone(destinationsError(step.destinationIds)) &&
		minutes !== null &&
		isWait(minutes)
		? Option.some({ targets, wait_minutes: minutes })
		: Option.none()
}

/** The create payload the form describes, or none while any field is wrong. */
export const payloadOf = (model: Model): Option.Option<V2EscalationChainCreateParams> => {
	const steps = Option.all(Arr.map(model.steps, stepOf))
	const repeat = numberOf(model.repeatCount)
	if (
		Option.isSome(nameError(model.name)) ||
		Option.isSome(descriptionError(model.description)) ||
		Option.isSome(stepsError(model.steps)) ||
		repeat === null ||
		!isRepeat(repeat)
	)
		return Option.none()
	return Option.flatMap(steps, (all) =>
		Arr.isReadonlyArrayNonEmpty(all)
			? Option.some({
					name: Str.trim(model.name),
					description: Str.isEmpty(Str.trim(model.description))
						? null
						: Str.trim(model.description),
					steps: all,
					repeat_count: repeat,
				})
			: Option.none(),
	)
}

// COMMANDS

export const SaveEscalationChain = Command.define("SaveEscalationChain", {
	args: {
		openCount: Schema.Number,
		editingId: Schema.NullOr(EscalationChainId),
		payload: V2EscalationChainCreateParams,
	},
	messages: [Message.CompletedSave],
	execute: ({ openCount, editingId, payload }) =>
		saveEscalationChain(editingId, payload).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedSave({ openCount, result })),
		),
})

// UPDATE

const liftDialog = (model: Model, result: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, dialog: result.model },
	commands: Command.mapMessages(result.commands ?? [], (message) => Message.GotDialogMessage({ message })),
})

const open = (
	model: Model,
	fields: Pick<Model, "editingId" | "name" | "description" | "steps" | "repeatCount" | "nextKey">,
): Return =>
	liftDialog(
		{
			...model,
			...fields,
			menus: {},
			isSaving: false,
			isShowingErrors: false,
			saveError: null,
			openCount: model.openCount + 1,
		},
		Dialog.open(model.dialog),
	)

export const openNew = (model: Model): Return =>
	open(model, {
		editingId: null,
		name: "",
		description: "",
		steps: [emptyStep(0)],
		repeatCount: "0",
		nextKey: 1,
	})

export const openEdit = (model: Model, chain: V2EscalationChain): Return =>
	open(model, {
		editingId: chain.id,
		name: chain.name,
		description: chain.description ?? "",
		steps: Arr.map(chain.steps, (step, index) => ({
			key: `s${index}`,
			destinationIds: Arr.map(step.targets, (target) => target.destination_id),
			waitMinutes: String(step.wait_minutes),
		})),
		repeatCount: String(chain.repeat_count),
		nextKey: chain.steps.length,
	})

const editStep = (model: Model, key: string, edit: (step: StepDraft) => StepDraft): Return => ({
	model: { ...model, steps: Arr.map(model.steps, (step) => (step.key === key ? edit(step) : step)) },
})

const moveStep = (steps: ReadonlyArray<StepDraft>, key: string, direction: "up" | "down") => {
	const from = Arr.findFirstIndex(steps, (step) => step.key === key)
	if (Option.isNone(from)) return steps
	const to = direction === "up" ? from.value - 1 : from.value + 1
	const moving = steps[from.value]
	const other = steps[to]
	if (moving === undefined || other === undefined) return steps
	return Arr.map(steps, (step, index) => (index === from.value ? other : index === to ? moving : step))
}

const decodeDestinationId = Schema.decodeUnknownOption(AlertDestinationId)

const stepMenu = (model: Model, key: string, message: Menu.Message): Return => {
	const id = menuIdOf(model, key)
	const result = Menu.update(model.menus[key] ?? Menu.init(id), message)
	const next: Model = { ...model, menus: { ...model.menus, [key]: result.model } }
	const commands = Command.mapMessages(result.commands ?? [], (child) =>
		Message.GotStepMenuMessage({ key, message: child }),
	)
	const picked = Option.flatMap(
		result.outMessage?._tag === "SelectedItem" ? Option.some(result.outMessage.value) : Option.none(),
		decodeDestinationId,
	)
	return Option.match(picked, {
		onNone: () => ({ model: next, commands }),
		onSome: (destinationId) => ({
			...editStep(next, key, (step) =>
				step.destinationIds.includes(destinationId)
					? step
					: { ...step, destinationIds: [...step.destinationIds, destinationId] },
			),
			commands,
		}),
	})
}

const save = (model: Model): Return =>
	model.isSaving
		? { model }
		: Option.match(payloadOf(model), {
				onNone: () => ({ model: { ...model, isShowingErrors: true } }),
				onSome: (payload) => ({
					model: { ...model, isSaving: true, isShowingErrors: true, saveError: null },
					commands: [
						SaveEscalationChain({
							openCount: model.openCount,
							editingId: model.editingId,
							payload,
						}),
					],
				}),
			})

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotDialogMessage: ({ message: child }) =>
			// The dialog stays open while a save is in flight.
			model.isSaving ? { model } : liftDialog(model, Dialog.update(model.dialog, child)),
		ChangedName: ({ value }) => ({ model: { ...model, name: value } }),
		ChangedDescription: ({ value }) => ({ model: { ...model, description: value } }),
		ChangedRepeatCount: ({ value }) => ({ model: { ...model, repeatCount: value } }),
		ChangedWait: ({ key, value }) => editStep(model, key, (step) => ({ ...step, waitMinutes: value })),
		ClickedAddStep: () =>
			model.steps.length >= MAX_ESCALATION_STEPS
				? { model }
				: {
						model: {
							...model,
							steps: [...model.steps, emptyStep(model.nextKey)],
							nextKey: model.nextKey + 1,
						},
					},
		ClickedRemoveStep: ({ key }) => ({
			model: { ...model, steps: Arr.filter(model.steps, (step) => step.key !== key) },
		}),
		ClickedMoveStep: ({ key, direction }) => ({
			model: { ...model, steps: moveStep(model.steps, key, direction) },
		}),
		GotStepMenuMessage: ({ key, message: child }) => stepMenu(model, key, child),
		ClickedRemoveDestination: ({ key, id }) =>
			editStep(model, key, (step) => ({
				...step,
				destinationIds: Arr.filter(step.destinationIds, (existing) => existing !== id),
			})),
		ClickedSave: () => save(model),
		CompletedSave: ({ openCount, result }) =>
			openCount !== model.openCount
				? { model }
				: Result.match(result, {
						onSuccess: (chain) => ({
							...liftDialog({ ...model, isSaving: false }, Dialog.close(model.dialog)),
							outMessage: OutMessage.SavedChain({ chain, isNew: model.editingId === null }),
						}),
						onFailure: (failure) => ({
							model: { ...model, isSaving: false, saveError: failure.message },
						}),
					}),
	})

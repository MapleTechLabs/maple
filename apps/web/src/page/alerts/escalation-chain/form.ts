import {
	AlertDestinationId,
	EscalationChainDescription,
	EscalationChainName,
	EscalationRepeatCount,
	EscalationWaitMinutes,
	MAX_ESCALATION_REPEATS,
	MAX_ESCALATION_STEPS,
	MAX_ESCALATION_STEP_TARGETS,
	MAX_ESCALATION_WAIT_MINUTES,
	OnCallScheduleId,
	UserId,
} from "@maple/domain/http"
import {
	type V2EscalationChain,
	type V2EscalationChainCreateParams,
	type V2EscalationStep,
	V2EscalationTarget,
} from "@maple/domain/http/v2"
import { Equal, Option, Schema, Array as Arr, String as Str } from "effect"
import type { ChainOutline } from "../shared/escalation-chains"

// The escalation chain editor's form: its drafts, the API's limits as field errors, and step edits.

/** One step as the form holds it; `key` keeps a step's card (and its menus) across reorders. */
export const StepDraft = Schema.Struct({
	key: Schema.String,
	/** Destinations, people and schedules, in the order they were added; all kept on load. */
	targets: Schema.Array(V2EscalationTarget),
	waitMinutes: Schema.String,
})
export type StepDraft = typeof StepDraft.Type

export const Form = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	steps: Schema.Array(StepDraft),
	repeatCount: Schema.String,
	nextKey: Schema.Number,
})
export type Form = typeof Form.Type

export const DEFAULT_WAIT_MINUTES = "10"

export const emptyStep = (key: number): StepDraft => ({
	key: `s${key}`,
	targets: [],
	waitMinutes: DEFAULT_WAIT_MINUTES,
})

export const emptyForm: Form = {
	name: "",
	description: "",
	steps: [emptyStep(0)],
	repeatCount: "0",
	nextKey: 1,
}

export const formFromChain = (chain: V2EscalationChain): Form => ({
	name: chain.name,
	description: chain.description ?? "",
	steps: Arr.map(chain.steps, (step, index) => ({
		key: `s${index}`,
		targets: step.targets,
		waitMinutes: String(step.wait_minutes),
	})),
	repeatCount: String(chain.repeat_count),
	nextKey: chain.steps.length,
})

const contentOf = (form: Form) => ({
	name: form.name,
	description: form.description,
	repeatCount: form.repeatCount,
	steps: Arr.map(form.steps, (step) => ({ targets: step.targets, waitMinutes: step.waitMinutes })),
})

/** Two forms describe the same chain: step keys aside, nothing a save sends differs. */
export const isSameChain = (a: Form, b: Form): boolean => Equal.equals(contentOf(a), contentOf(b))

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
	isDescription(Str.trim(description)) ? Option.none() : Option.some("Keep the notes to 500 characters")

export const waitError = (raw: string): Option.Option<string> =>
	isWait(numberOf(raw)) ? Option.none() : Option.some(`Wait 1 to ${MAX_ESCALATION_WAIT_MINUTES} minutes`)

export const repeatError = (raw: string): Option.Option<string> =>
	isRepeat(numberOf(raw)) ? Option.none() : Option.some(`Repeat 0 to ${MAX_ESCALATION_REPEATS} times`)

export const targetsError = (targets: ReadonlyArray<V2EscalationTarget>): Option.Option<string> =>
	targets.length === 0
		? Option.some("Pick at least one destination, person or schedule")
		: targets.length > MAX_ESCALATION_STEP_TARGETS
			? Option.some(`A step notifies at most ${MAX_ESCALATION_STEP_TARGETS} targets`)
			: Option.none()

export const stepsError = (steps: ReadonlyArray<StepDraft>): Option.Option<string> =>
	steps.length === 0
		? Option.some("Add at least one step")
		: steps.length > MAX_ESCALATION_STEPS
			? Option.some(`A chain has at most ${MAX_ESCALATION_STEPS} steps`)
			: Option.none()

/** Every field's problem, in form order, for the action bar. */
export const formIssues = (form: Form): ReadonlyArray<string> =>
	Arr.getSomes([
		nameError(form.name),
		descriptionError(form.description),
		stepsError(form.steps),
		...Arr.flatMap(form.steps, (step) => [targetsError(step.targets), waitError(step.waitMinutes)]),
		repeatError(form.repeatCount),
	])

/** A target as a menu value and a row key: `destination:<id>`, `user:<id>`, `schedule:<id>`. */
export const targetKey = (target: V2EscalationTarget): string => {
	switch (target.type) {
		case "destination":
			return `destination:${target.destination_id}`
		case "user":
			return `user:${target.user_id}`
		case "schedule":
			return `schedule:${target.schedule_id}`
	}
}

const decodeDestinationId = Schema.decodeUnknownOption(AlertDestinationId)
const decodeUserId = Schema.decodeUnknownOption(UserId)
const decodeScheduleId = Schema.decodeUnknownOption(OnCallScheduleId)

/** The target a menu value names, if it is well formed. */
export const targetOfKey = (key: string): Option.Option<V2EscalationTarget> => {
	const [kind, ...rest] = Str.split(":")(key)
	const id = Arr.join(rest, ":")
	switch (kind) {
		case "destination":
			return Option.map(decodeDestinationId(id), (destination_id): V2EscalationTarget => ({
				type: "destination",
				destination_id,
			}))
		case "user":
			return Option.map(decodeUserId(id), (user_id): V2EscalationTarget => ({ type: "user", user_id }))
		case "schedule":
			return Option.map(decodeScheduleId(id), (schedule_id): V2EscalationTarget => ({
				type: "schedule",
				schedule_id,
			}))
		default:
			return Option.none()
	}
}

const stepOf = (step: StepDraft): Option.Option<V2EscalationStep> => {
	const targets = step.targets
	const minutes = numberOf(step.waitMinutes)
	return Arr.isReadonlyArrayNonEmpty(targets) &&
		Option.isNone(targetsError(targets)) &&
		minutes !== null &&
		isWait(minutes)
		? Option.some({ targets, wait_minutes: minutes })
		: Option.none()
}

/** The create payload the form describes, or none while any field is wrong. */
export const payloadOf = (form: Form): Option.Option<V2EscalationChainCreateParams> => {
	const steps = Option.all(Arr.map(form.steps, stepOf))
	const repeat = numberOf(form.repeatCount)
	if (
		Option.isSome(nameError(form.name)) ||
		Option.isSome(descriptionError(form.description)) ||
		Option.isSome(stepsError(form.steps)) ||
		repeat === null ||
		!isRepeat(repeat)
	)
		return Option.none()
	return Option.flatMap(steps, (all) =>
		Arr.isReadonlyArrayNonEmpty(all)
			? Option.some({
					name: Str.trim(form.name),
					description: Str.isEmpty(Str.trim(form.description)) ? null : Str.trim(form.description),
					steps: all,
					repeat_count: repeat,
				})
			: Option.none(),
	)
}

/** The chain the form describes so far, for the live preview: only steps with targets count. */
export const previewOf = (form: Form): ChainOutline => ({
	steps: Arr.map(
		Arr.filter(form.steps, (step) => step.targets.length > 0),
		(step) => ({
			targets: step.targets,
			wait_minutes: Option.isNone(waitError(step.waitMinutes)) ? Number(step.waitMinutes) : 0,
		}),
	),
	repeat_count: Option.isNone(repeatError(form.repeatCount)) ? Number(form.repeatCount) : 0,
})

// STEP EDITS

export const Direction = Schema.Literals(["up", "down"])
export type Direction = typeof Direction.Type

export const canAddStep = (form: Form): boolean => form.steps.length < MAX_ESCALATION_STEPS

/** A new empty step at `index` (0 puts it first, `steps.length` last). */
export const insertStep = (form: Form, index: number): Form =>
	canAddStep(form)
		? {
				...form,
				steps: Arr.insertAt(
					form.steps,
					Math.max(0, Math.min(index, form.steps.length)),
					emptyStep(form.nextKey),
				).pipe(Option.getOrElse(() => form.steps)),
				nextKey: form.nextKey + 1,
			}
		: form

/** A copy of the step right after it, with its own key. */
export const duplicateStep = (form: Form, key: string): Form =>
	Option.match(
		Arr.findFirstIndex(form.steps, (step) => step.key === key),
		{
			onNone: () => form,
			onSome: (index) => {
				const source = form.steps[index]
				if (source === undefined || !canAddStep(form)) return form
				const copy: StepDraft = { ...source, key: `s${form.nextKey}` }
				return {
					...form,
					steps: Option.getOrElse(Arr.insertAt(form.steps, index + 1, copy), () => form.steps),
					nextKey: form.nextKey + 1,
				}
			},
		},
	)

/** Removes a step; the last one stays, since a chain needs at least one. */
export const removeStep = (form: Form, key: string): Form =>
	form.steps.length <= 1 ? form : { ...form, steps: Arr.filter(form.steps, (step) => step.key !== key) }

/** Swaps a step with its neighbour; at either end the steps stay as they are. */
export const moveStep = (form: Form, key: string, direction: Direction): Form =>
	Option.match(
		Arr.findFirstIndex(form.steps, (step) => step.key === key),
		{
			onNone: () => form,
			onSome: (from) => {
				const to = direction === "up" ? from - 1 : from + 1
				const moving = form.steps[from]
				const other = form.steps[to]
				if (moving === undefined || other === undefined) return form
				return {
					...form,
					steps: Arr.map(form.steps, (step, index) =>
						index === from ? other : index === to ? moving : step,
					),
				}
			},
		},
	)

export const editStep = (form: Form, key: string, edit: (step: StepDraft) => StepDraft): Form => ({
	...form,
	steps: Arr.map(form.steps, (step) => (step.key === key ? edit(step) : step)),
})

export const addTarget = (form: Form, key: string, target: V2EscalationTarget): Form =>
	editStep(form, key, (step) =>
		Arr.some(step.targets, (existing) => targetKey(existing) === targetKey(target))
			? step
			: { ...step, targets: [...step.targets, target] },
	)

export const removeTarget = (form: Form, key: string, target: string): Form =>
	editStep(form, key, (step) => ({
		...step,
		targets: Arr.filter(step.targets, (existing) => targetKey(existing) !== target),
	}))

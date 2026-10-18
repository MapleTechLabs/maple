import { ONBOARDING_INTENT_IDS } from "@maple/web/lib/onboarding-intent"
import { ONBOARDING_ROLE_IDS } from "@maple/web/lib/onboarding-role"
import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import type { Resources } from "../../platform/resources"
import {
	completeStep,
	pickedRole,
	QuickStartState,
	readQuickStartState,
	STEP_IDS,
	toggledIntent,
	writeQuickStartState,
} from "./quick-start-state"

// `/quick-start` (apps/web/src/routes/quick-start.tsx): role, intent, team and plan, one step at a
// time, resumed from localStorage. The plan and region gates around it are the root's (`plan-gate.ts`).

export const Step = Schema.Literals(STEP_IDS)

export const Model = Schema.TaggedStruct("QuickStart", {
	storageKey: Schema.String,
	/** `null` until the saved progress is read. */
	state: Schema.NullOr(QuickStartState),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	LoadedQuickStartState: { state: QuickStartState },
	PickedRole: { role: Schema.Literals(ONBOARDING_ROLE_IDS) },
	ChangedRoleDetail: { value: Schema.String },
	ToggledIntent: { intent: Schema.Literals(ONBOARDING_INTENT_IDS) },
	ClickedContinue: { step: Step },
	ClickedBack: { to: Step },
	CompletedSaveQuickStartState: {},
})
export type Message = typeof Message.Type

export const LoadQuickStartState = Command.define("LoadQuickStartState", {
	args: { key: Schema.String },
	messages: [Message.LoadedQuickStartState],
	execute: ({ key }) => Effect.map(readQuickStartState(key), (state) => Message.LoadedQuickStartState({ state })),
})

export const SaveQuickStartState = Command.define("SaveQuickStartState", {
	args: { key: Schema.String, state: QuickStartState },
	messages: [Message.CompletedSaveQuickStartState],
	execute: ({ key, state }) =>
		writeQuickStartState(key, state).pipe(Effect.as(Message.CompletedSaveQuickStartState())),
})

type UpdateReturn = Update.Return<Model, Message, Resources>

export const init = (storageKey: string): UpdateReturn => ({
	model: { _tag: "QuickStart", storageKey, state: null },
	commands: [LoadQuickStartState({ key: storageKey })],
})

/** Every change is written through, as the atom's `setState` is. */
const saved = (model: Model, next: (state: QuickStartState) => QuickStartState): UpdateReturn => {
	if (model.state === null) return { model }
	const state = next(model.state)
	return {
		model: { ...model, state },
		commands: [SaveQuickStartState({ key: model.storageKey, state })],
	}
}

/** "Something else" needs its free-text answer before the role step can continue. */
export const roleNeedsDetail = (state: QuickStartState): boolean =>
	state.qualifyAnswers.role === "other" && state.qualifyAnswers.roleDetail.trim() === ""

const canContinue = (state: QuickStartState, step: (typeof STEP_IDS)[number]): boolean =>
	step === "role"
		? state.qualifyAnswers.role !== null && !roleNeedsDetail(state)
		: step === "intent"
			? state.qualifyAnswers.intents.length > 0
			: true

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		LoadedQuickStartState: ({ state }) => ({ model: { ...model, state } }),
		PickedRole: ({ role }) =>
			saved(model, (state) => ({
				...state,
				qualifyAnswers: pickedRole(
					state.qualifyAnswers,
					role,
					role === "other" ? state.qualifyAnswers.roleDetail : "",
				),
			})),
		ChangedRoleDetail: ({ value }) =>
			saved(model, (state) => ({ ...state, qualifyAnswers: pickedRole(state.qualifyAnswers, "other", value) })),
		ToggledIntent: ({ intent }) =>
			saved(model, (state) => ({ ...state, qualifyAnswers: toggledIntent(state.qualifyAnswers, intent) })),
		ClickedContinue: ({ step }) =>
			model.state !== null && canContinue(model.state, step)
				? saved(model, (state) => completeStep(state, step))
				: { model },
		ClickedBack: ({ to }) => saved(model, (state) => ({ ...state, activeStep: to })),
		CompletedSaveQuickStartState: () => ({ model }),
	})

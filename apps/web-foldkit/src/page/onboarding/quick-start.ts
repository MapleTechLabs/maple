import { ONBOARDING_INTENT_IDS } from "@maple/web/lib/onboarding-intent"
import { ONBOARDING_ROLE_IDS } from "@maple/web/lib/onboarding-role"
import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { isClerkAuthEnabled } from "@maple/web/lib/services/common/auth-mode"
import type { Resources } from "../../platform/resources"
import * as PricingCards from "./pricing-cards"
import { LoadTeam, loadingTeam, selfHostedTeam, Team, TeamMessage, updateTeam } from "./quick-start-team"
import {
	completeStep,
	pickedRole,
	QuickStartState,
	readQuickStartState,
	resolveQuickStartStep,
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
	/** The team step's workspace and invitations, read when the step is shown. */
	team: Team,
	/** The plan step's pricing cards; the catalog is read the first time the step is shown. */
	pricing: PricingCards.Model,
	isPlansRequested: Schema.Boolean,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotTeamMessage: { message: TeamMessage },
	GotPricingMessage: { message: PricingCards.Message },
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

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, PricingCards.OutMessage, Resources>

export const init = (storageKey: string): UpdateReturn => ({
	model: {
		_tag: "QuickStart",
		storageKey,
		state: null,
		team: isClerkAuthEnabled ? loadingTeam() : selfHostedTeam(),
		pricing: PricingCards.init(),
		isPlansRequested: false,
	},
	commands: [LoadQuickStartState({ key: storageKey })],
})

const toTeam = (message: TeamMessage) => Message.GotTeamMessage({ message })
const toPricing = (message: PricingCards.Message) => Message.GotPricingMessage({ message })

/**
 * A step's data is read when it mounts: the Clerk team (its name and pending invitations) on the
 * team step, the plan catalog on the plan step (cached after the first read, like the atom).
 */
const entered = (previous: Model, result: UpdateReturn): UpdateReturn => {
	const { model } = result
	if (model.state === null) return result
	const step = resolveQuickStartStep(model.state)
	const wasOn = previous.state === null ? null : resolveQuickStartStep(previous.state)
	if (step === wasOn) return result
	if (step === "team" && isClerkAuthEnabled)
		return {
			...result,
			model: { ...model, team: loadingTeam() },
			commands: [...(result.commands ?? []), Command.mapMessage(toTeam)(LoadTeam())],
		}
	if (step === "plan" && !model.isPlansRequested)
		return {
			...result,
			model: { ...model, isPlansRequested: true },
			commands: [...(result.commands ?? []), Command.mapMessage(toPricing)(PricingCards.LoadPlans())],
		}
	return result
}

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

export const update = (model: Model, message: Message): UpdateReturn => entered(model, step(model, message))

const step = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		GotTeamMessage: ({ message: child }) => {
			const next = updateTeam(model.team, child)
			return { model: { ...model, team: next.team }, commands: Command.mapMessages(next.commands, toTeam) }
		},
		GotPricingMessage: ({ message: child }) => {
			const next = PricingCards.update(model.pricing, child)
			return {
				model: { ...model, pricing: next.model },
				commands: Command.mapMessages(next.commands ?? [], toPricing),
				outMessage: next.outMessage,
			}
		},
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

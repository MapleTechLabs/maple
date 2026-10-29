import { V2OnboardingChecklist } from "@maple/domain/http/v2"
import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import { displayError } from "@maple/web-data/lib/error-messages"
import { Clock, Effect, Layer, Option, Schema } from "effect"
import { Block, Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { trackProduct } from "../data/analytics"
import { SessionTenant } from "../data/session-tenant"
import { MapleApiV2Client } from "../platform/api-clients"
import * as Popover from "../ui/popover"

// The onboarding checklist button:
// the Clerk top bar's reward pill, its one-time pointer and the checklist popover with the claim.

export const Model = Schema.Struct({
	/** `null` until the first read lands (and when it fails): no pill. */
	checklist: Schema.NullOr(V2OnboardingChecklist),
	/** `useIsOrgAdmin()`: only an admin claims the credit. */
	isAdmin: Schema.Boolean,
	/** `maple-onboarding-reward-seen-v3-<org>:<user>`: the pointer is retired once true. */
	seenKey: Schema.NullOr(Schema.String),
	isSeen: Schema.Boolean,
	popover: Popover.PopoverBlock.Model,
	/** Keeps the popover on its "credits added" beat after a claim, until it closes. */
	isJustClaimed: Schema.Boolean,
	isClaimPending: Schema.Boolean,
	claimError: Schema.NullOr(Schema.String),
	/** `useLiveClock`: the countdown's clock, ticking each second while one is shown. */
	nowMs: Schema.Number,
})
export type Model = typeof Model.Type

const initialModel = (): Model => ({
	checklist: null,
	isAdmin: false,
	seenKey: null,
	isSeen: true,
	popover: Popover.init("onboarding-checklist", { align: "end" }),
	isJustClaimed: false,
	isClaimPending: false,
	claimError: null,
	nowMs: 0,
})

export const Message = defineMessageUnion({
	SucceededLoadChecklist: { checklist: V2OnboardingChecklist, nowMs: Schema.Number },
	FailedLoadChecklist: {},
	LoadedViewer: { isAdmin: Schema.Boolean, seenKey: Schema.String, isSeen: Schema.Boolean },
	/** The pill itself: it opens the popover (re-reading the checklist) or closes it. */
	ClickedTrigger: {},
	/** The panel left the popover: it closed, whatever closed it. */
	UnmountedPanel: {},
	/** Operation: the shell entered an org; the checklist and its viewer are read. */
	RequestedLoad: {},
	/** Operation: a navigation re-reads the checklist (`onResolved`). */
	RequestedRefresh: {},
	ClickedPointer: {},
	ClickedGotIt: {},
	ClickedStep: {},
	ClickedClaim: {},
	ClickedDone: {},
	SucceededClaim: {},
	FailedClaim: { message: Schema.String },
	TickedClock: { nowMs: Schema.Number },
	CompletedSaveSeen: {},
})
export type Message = typeof Message.Type

/** `onboardingChecklistAtom`: `GET /v2/onboarding/checklist`, with the clock it was read at. */
export const ChecklistDefinition = Block.makeDefinition("OnboardingChecklist", { Model, Message })
const { makeStep, makeFieldsStep, makeNoopStep } = ChecklistDefinition

export const LoadChecklist = ChecklistDefinition.makeCommand("LoadOnboardingChecklist", {
	messages: [Message.SucceededLoadChecklist, Message.FailedLoadChecklist],
	handler: function* () {
		return () =>
			Effect.gen(function* () {
				const client = yield* MapleApiV2Client
				const checklist = yield* client.onboardingChecklist.retrieve()
				const nowMs = yield* Clock.currentTimeMillis
				return Message.SucceededLoadChecklist({ checklist, nowMs })
			}).pipe(Effect.orElseSucceed(() => Message.FailedLoadChecklist()))
	},
})

const SEEN_PREFIX = "maple-onboarding-reward-seen-v3-"

/** The session's roles (admin) and this viewer's pointer memory for the org. */
export const LoadViewer = ChecklistDefinition.makeCommand("LoadOnboardingChecklistViewer", {
	messages: [Message.LoadedViewer],
	handler: function* () {
		return () =>
			Effect.gen(function* () {
				const tenant = yield* (yield* SessionTenant).get
				const seenKey = `${SEEN_PREFIX}${tenant.orgId}:${tenant.userId}`
				return Message.LoadedViewer({
					isAdmin: tenant.roles.some((role) => role === "root" || role === "org:admin"),
					seenKey,
					isSeen: Option.contains(readLocalStorage(seenKey), "true"),
				})
			}).pipe(
				Effect.orElseSucceed(() =>
					Message.LoadedViewer({ isAdmin: false, seenKey: "", isSeen: true }),
				),
			)
	},
})

export const SaveSeen = ChecklistDefinition.makeCommand("SaveOnboardingRewardSeen", {
	args: { key: Schema.String },
	messages: [Message.CompletedSaveSeen],
	handler: function* () {
		return ({ key }) =>
			Effect.sync(() => writeLocalStorage(key, "true")).pipe(Effect.as(Message.CompletedSaveSeen()))
	},
})

/** `claimOnboardingRewardMutation`: `POST /v2/onboarding/checklist/claim`. */
export const ClaimReward = ChecklistDefinition.makeCommand("ClaimOnboardingReward", {
	messages: [Message.SucceededClaim, Message.FailedClaim],
	handler: function* () {
		return () =>
			Effect.gen(function* () {
				const client = yield* MapleApiV2Client
				yield* client.onboardingChecklist.claim()
				// `onboarding_reward_claimed` once the credit landed.
				yield* trackProduct("onboarding_reward_claimed")
				return Message.SucceededClaim()
			}).pipe(
				Effect.catch((error) =>
					Effect.succeed(Message.FailedClaim({ message: displayError(error).message })),
				),
			)
	},
})

/** The popover's own init builds the field; its open and close are this Block's to ask for. */
export const PopoverBinding = ChecklistDefinition.makeBinding(Popover.PopoverBlock, {
	field: "popover",
	init: false,
})

export const ChecklistComposition = ChecklistDefinition.makeComposition({ bindings: [PopoverBinding] })
export type ChecklistViewBuilder = Block.ViewBuilderFor<typeof ChecklistComposition>

type StepReturn = Readonly<{
	model: Model
	commands?: ReadonlyArray<ReturnType<typeof LoadChecklist> | ReturnType<typeof SaveSeen>>
}>

const markSeen = (model: Model): StepReturn =>
	model.isSeen || model.seenKey === null
		? { model: { ...model, isSeen: true } }
		: { model: { ...model, isSeen: true }, commands: [SaveSeen({ key: model.seenKey })] }

/** `handleOpenChange(true)`: opening re-reads the checklist and retires the pointer. */
const openStep = makeStep((model) => {
	const seen = markSeen(model)
	return Update.combineSteps([
		makeStep(() => ({ model: seen.model, commands: [LoadChecklist(), ...(seen.commands ?? [])] })),
		PopoverBinding.requestOpen({ isPressOpened: true }),
	])
})

/** `handleOpenChange(false)`: closing ends the claimed beat. */
const closeStep = Update.combineSteps([
	makeFieldsStep(() => ({ isJustClaimed: () => false })),
	PopoverBinding.requestClose(),
])

export const init = ChecklistComposition.makeInit(() => ({ model: initialModel() }))

export const update = ChecklistComposition.makeUpdate({
	SucceededLoadChecklist: (model, { checklist, nowMs }) => ({ model: { ...model, checklist, nowMs } }),
	FailedLoadChecklist: (model) => ({ model }),
	LoadedViewer: (model, { isAdmin, seenKey, isSeen }) => ({
		model: { ...model, isAdmin, seenKey: seenKey === "" ? null : seenKey, isSeen },
	}),
	ClickedTrigger: (model) => (model.popover.isOpen ? closeStep(model) : openStep(model)),
	UnmountedPanel: makeFieldsStep(() => ({ isJustClaimed: () => false })),
	RequestedLoad: (model) => ({ model, commands: [LoadChecklist(), LoadViewer()] }),
	RequestedRefresh: (model) => ({ model, commands: [LoadChecklist()] }),
	ClickedPointer: (model) => (model.popover.isOpen ? makeNoopStep()(model) : openStep(model)),
	ClickedGotIt: (model) => markSeen(model),
	ClickedStep: closeStep,
	ClickedDone: closeStep,
	ClickedClaim: (model) =>
		model.isClaimPending
			? { model }
			: { model: { ...model, isClaimPending: true, claimError: null }, commands: [ClaimReward()] },
	SucceededClaim: (model) => ({
		model: { ...model, isClaimPending: false, isJustClaimed: true },
		commands: [LoadChecklist()],
	}),
	FailedClaim: (model, { message: failure }) => ({
		model: { ...model, isClaimPending: false, claimError: failure },
	}),
	TickedClock: (model, { nowMs }) => ({ model: { ...model, nowMs } }),
	CompletedSaveSeen: (model) => ({ model }),
})

/** The pill counts down each second while the checklist is in progress. */
export const isCounting = (model: Model): boolean => model.checklist?.status === "in_progress"

/** Parent-initiated transitions; each enters `update`. */
export const operations = {
	requestLoad: Message.RequestedLoad,
	requestRefresh: Message.RequestedRefresh,
	informOfClock: Message.TickedClock,
}

export const EffectsLayer = Layer.mergeAll(
	LoadChecklist.layer,
	LoadViewer.layer,
	SaveSeen.layer,
	ClaimReward.layer,
)

import { V2OnboardingChecklist } from "@maple/domain/http/v2"
import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import { displayError } from "@maple/web-data/lib/error-messages"
import { Clock, Effect, Option, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { trackProduct } from "../data/analytics"
import { SessionTenant } from "../data/session-tenant"
import { MapleApiV2Client } from "../platform/api-clients"
import type { Resources } from "../platform/resources"
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
	popover: Popover.Model,
	/** Keeps the popover on its "credits added" beat after a claim, until it closes. */
	isJustClaimed: Schema.Boolean,
	isClaimPending: Schema.Boolean,
	claimError: Schema.NullOr(Schema.String),
	/** `useLiveClock`: the countdown's clock, ticking each second while one is shown. */
	nowMs: Schema.Number,
})
export type Model = typeof Model.Type

export const init = (): Model => ({
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
	GotPopoverMessage: { message: Popover.Message },
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
export const LoadChecklist = Command.define("LoadOnboardingChecklist", {
	messages: [Message.SucceededLoadChecklist, Message.FailedLoadChecklist],
	execute: Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const checklist = yield* client.onboardingChecklist.retrieve()
		const nowMs = yield* Clock.currentTimeMillis
		return Message.SucceededLoadChecklist({ checklist, nowMs })
	}).pipe(Effect.orElseSucceed(() => Message.FailedLoadChecklist())),
})

const SEEN_PREFIX = "maple-onboarding-reward-seen-v3-"

/** The session's roles (admin) and this viewer's pointer memory for the org. */
export const LoadViewer = Command.define("LoadOnboardingChecklistViewer", {
	messages: [Message.LoadedViewer],
	execute: Effect.gen(function* () {
		const tenant = yield* (yield* SessionTenant).get
		const seenKey = `${SEEN_PREFIX}${tenant.orgId}:${tenant.userId}`
		return Message.LoadedViewer({
			isAdmin: tenant.roles.some((role) => role === "root" || role === "org:admin"),
			seenKey,
			isSeen: Option.contains(readLocalStorage(seenKey), "true"),
		})
	}).pipe(Effect.orElseSucceed(() => Message.LoadedViewer({ isAdmin: false, seenKey: "", isSeen: true }))),
})

export const SaveSeen = Command.define("SaveOnboardingRewardSeen", {
	args: { key: Schema.String },
	messages: [Message.CompletedSaveSeen],
	execute: ({ key }) =>
		Effect.sync(() => writeLocalStorage(key, "true")).pipe(Effect.as(Message.CompletedSaveSeen())),
})

type UpdateReturn = Update.Return<Model, Message, Resources>

const toPopover = (message: Popover.Message) => Message.GotPopoverMessage({ message })

/** `handleOpenChange`: opening re-reads the checklist and retires the pointer; closing ends the claimed beat. */
const popoverStep = (model: Model, message: Popover.Message): UpdateReturn => {
	const next = Popover.update(model.popover, message)
	const commands = Command.mapMessages(next.commands ?? [], toPopover)
	const isOpening = !model.popover.isOpen && next.model.isOpen
	const isClosing = model.popover.isOpen && !next.model.isOpen
	if (isOpening) {
		const seen = markSeen(model)
		return {
			model: { ...seen.model, popover: next.model },
			commands: [...commands, LoadChecklist(), ...(seen.commands ?? [])],
		}
	}
	return {
		model: { ...model, popover: next.model, isJustClaimed: isClosing ? false : model.isJustClaimed },
		commands,
	}
}

const markSeen = (model: Model): UpdateReturn =>
	model.isSeen || model.seenKey === null
		? { model: { ...model, isSeen: true } }
		: { model: { ...model, isSeen: true }, commands: [SaveSeen({ key: model.seenKey })] }

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		SucceededLoadChecklist: ({ checklist, nowMs }) => ({ model: { ...model, checklist, nowMs } }),
		FailedLoadChecklist: () => ({ model }),
		LoadedViewer: ({ isAdmin, seenKey, isSeen }) => ({
			model: { ...model, isAdmin, seenKey: seenKey === "" ? null : seenKey, isSeen },
		}),
		GotPopoverMessage: ({ message: child }) => popoverStep(model, child),
		ClickedPointer: () =>
			model.popover.isOpen ? { model } : popoverStep(model, Popover.Message.ClickedTrigger()),
		ClickedGotIt: () => markSeen(model),
		ClickedStep: () => popoverStep(model, Popover.Message.ClickedClose()),
		ClickedDone: () => popoverStep(model, Popover.Message.ClickedClose()),
		ClickedClaim: () =>
			model.isClaimPending
				? { model }
				: { model: { ...model, isClaimPending: true, claimError: null }, commands: [ClaimReward()] },
		SucceededClaim: () => ({
			model: { ...model, isClaimPending: false, isJustClaimed: true },
			commands: [LoadChecklist()],
		}),
		FailedClaim: ({ message: failure }) => ({
			model: { ...model, isClaimPending: false, claimError: failure },
		}),
		TickedClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedSaveSeen: () => ({ model }),
	})

/** The pill counts down each second while the checklist is in progress. */
export const isCounting = (model: Model): boolean => model.checklist?.status === "in_progress"

/** `claimOnboardingRewardMutation`: `POST /v2/onboarding/checklist/claim`. */
export const ClaimReward = Command.define("ClaimOnboardingReward", {
	messages: [Message.SucceededClaim, Message.FailedClaim],
	execute: Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		yield* client.onboardingChecklist.claim()
		// `onboarding_reward_claimed` once the credit landed.
		yield* trackProduct("onboarding_reward_claimed")
		return Message.SucceededClaim()
	}).pipe(
		Effect.catch((error) =>
			Effect.succeed(Message.FailedClaim({ message: displayError(error).message })),
		),
	),
})

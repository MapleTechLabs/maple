import { STACK_LANGUAGE_IDS, STACK_PLATFORM_IDS, toggled } from "../../lib/onboarding-stack"
import { ChooseOrganizationRegionRequest } from "@maple/domain/http"
import { MapleRegion } from "@maple/domain/organization-regions"
import { currentRegion, regionAppUrl } from "../../lib/region"
import { Effect, Schema } from "effect"
import { Command, Mount, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { isClerkAuthEnabled } from "../../lib/services/common/auth-mode"
import { load, replaceUrl } from "foldkit/navigation"
import { trackProduct } from "../../data/analytics"
import { MapleInternalApiClient } from "../../platform/api-clients"
import { clerkTry, currentClerkOrganization } from "../../platform/clerk"
import { startDitherField } from "../../ui/dither-field"
import type { Resources } from "../../platform/resources"
import * as PricingCards from "./pricing-cards"
import { LoadTeam, loadingTeam, selfHostedTeam, Team, TeamMessage, updateTeam } from "./quick-start-team"
import {
	completeStep,
	isQuickStartFinished,
	QuickStartState,
	readQuickStartState,
	reopenedForPlan,
	resolveQuickStartStep,
	STEP_IDS,
	withStack,
	writeQuickStartState,
} from "./quick-start-state"

// `/quick-start`: plan, stack and team, one step at a time, resumed from localStorage, then the app.
// The region gate and the plan step's skip once a plan exists come from the root (`plan-gate.ts`).

export const Step = Schema.Literals(STEP_IDS)

/** `StepRegion`: the picked card, the save in flight, and the API's refusal. */
export const RegionChoice = Schema.Struct({
	selected: MapleRegion,
	isSaving: Schema.Boolean,
	errorMessage: Schema.NullOr(Schema.String),
})
export type RegionChoice = typeof RegionChoice.Type

export const Model = Schema.TaggedStruct("QuickStart", {
	storageKey: Schema.String,
	/** `null` until the saved progress is read. */
	state: Schema.NullOr(QuickStartState),
	/** The team step's workspace and invitations, read when the step is shown. */
	team: Team,
	/** The plan step's pricing cards; the catalog is read the first time the step is shown. */
	pricing: PricingCards.Model,
	isPlansRequested: Schema.Boolean,
	/** Back from Stripe (`?checkout=complete`): the plan step's cards wait on the sync. */
	isCheckoutReturn: Schema.Boolean,
	region: RegionChoice,
	/** Counted for the rest of the visit once shown, so the step total does not shrink. */
	isRegionStepShown: Schema.Boolean,
	/** Where the last step sends them (`redirect_url`, else home). */
	redirectUrl: Schema.String,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotTeamMessage: { message: TeamMessage },
	GotPricingMessage: { message: PricingCards.Message },
	LoadedQuickStartState: { state: QuickStartState },
	ToggledLanguage: { language: Schema.Literals(STACK_LANGUAGE_IDS) },
	ToggledPlatform: { platform: Schema.Literals(STACK_PLATFORM_IDS) },
	ClickedContinue: { step: Step },
	ClickedBack: { to: Step },
	CompletedSaveQuickStartState: {},
	/** `trackProduct("onboarding_step_completed")` was handed to the session SDK. */
	CompletedTrackStepCompleted: {},
	PickedRegion: { region: MapleRegion },
	ClickedRegionContinue: {},
	SucceededChooseRegion: { region: MapleRegion },
	FailedChooseRegion: { message: Schema.String },
	CompletedReloadOrganization: {},
	CompletedLeaveForRegion: {},
	CompletedFinish: {},
	CompletedMountDitherField: {},
})
export type Message = typeof Message.Type

export const LoadQuickStartState = Command.define("LoadQuickStartState", {
	args: { key: Schema.String },
	messages: [Message.LoadedQuickStartState],
	execute: ({ key }) =>
		Effect.map(readQuickStartState(key), (state) => Message.LoadedQuickStartState({ state })),
})

/** `completeStep(id)`'s funnel event, sent once per Continue. */
export const TrackStepCompleted = Command.define("TrackOnboardingStepCompleted", {
	args: { step: Schema.String },
	messages: [Message.CompletedTrackStepCompleted],
	execute: ({ step }) =>
		trackProduct("onboarding_step_completed", { step }).pipe(
			Effect.as(Message.CompletedTrackStepCompleted()),
		),
})

export const SaveQuickStartState = Command.define("SaveQuickStartState", {
	args: { key: Schema.String, state: QuickStartState },
	messages: [Message.CompletedSaveQuickStartState],
	execute: ({ key, state }) =>
		writeQuickStartState(key, state).pipe(Effect.as(Message.CompletedSaveQuickStartState())),
})

/** `organizationRegion.choose`: answers with the region stored, which another admin may have set first. */
export const ChooseRegion = Command.define("ChooseOrganizationRegion", {
	args: { region: MapleRegion },
	messages: [Message.SucceededChooseRegion, Message.FailedChooseRegion],
	execute: ({ region }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const result = yield* client.organizationRegion.choose({
				payload: new ChooseOrganizationRegionRequest({ region }),
			})
			return Message.SucceededChooseRegion({ region: result.region })
		}).pipe(
			Effect.catch((error) => Effect.succeed(Message.FailedChooseRegion({ message: error.message }))),
		),
})

/** Onboarding is done: on to where they were going, replacing the wizard so Back does not return to it. */
export const Finish = Command.define("FinishQuickStart", {
	args: { url: Schema.String },
	messages: [Message.CompletedFinish],
	execute: ({ url }) => replaceUrl(url).pipe(Effect.as(Message.CompletedFinish())),
})

/** The steps' dithered backdrop, drawn until the canvas unmounts. */
export const MountDitherField = Mount.define("MountQuickStartDitherField", {
	messages: [Message.CompletedMountDitherField],
	execute: ({ element }) =>
		Effect.acquireRelease(
			Effect.sync(() =>
				element instanceof HTMLCanvasElement ? startDitherField(element) : () => undefined,
			),
			(stop) => Effect.sync(stop),
		).pipe(Effect.as(Message.CompletedMountDitherField())),
})

type FollowedRegion = ReturnType<
	typeof Message.CompletedLeaveForRegion | typeof Message.CompletedReloadOrganization
>

/**
 * Another region continues onboarding on its own dashboard (the save stays pending as the page
 * leaves); this one reloads the org, and the step closes once Clerk hands back the region.
 */
export const FollowChosenRegion = Command.define("FollowChosenRegion", {
	args: { region: MapleRegion },
	messages: [Message.CompletedLeaveForRegion, Message.CompletedReloadOrganization],
	execute: ({ region }) =>
		Effect.suspend((): Effect.Effect<FollowedRegion> => {
			const url = region === currentRegion ? undefined : regionAppUrl(region)
			return url === undefined
				? currentClerkOrganization.pipe(
						Effect.flatMap((organization) => clerkTry("", () => organization.reload())),
						Effect.ignore,
						Effect.as(Message.CompletedReloadOrganization()),
					)
				: load(`${url}/quick-start`).pipe(Effect.as(Message.CompletedLeaveForRegion()))
		}),
})

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, PricingCards.OutMessage, Resources>

/** `needsRegion`: the org has no region yet, so the region step comes first. */
export const init = (
	storageKey: string,
	isCheckoutReturn = false,
	needsRegion = false,
	redirectUrl = "/",
): UpdateReturn => ({
	model: {
		_tag: "QuickStart",
		storageKey,
		isCheckoutReturn,
		region: { selected: currentRegion, isSaving: false, errorMessage: null },
		isRegionStepShown: needsRegion,
		state: null,
		team: isClerkAuthEnabled ? loadingTeam() : selfHostedTeam(),
		pricing: PricingCards.init(),
		isPlansRequested: false,
		redirectUrl,
	},
	commands: [LoadQuickStartState({ key: storageKey })],
})

const toTeam = (message: TeamMessage) => Message.GotTeamMessage({ message })
const toPricing = (message: PricingCards.Message) => Message.GotPricingMessage({ message })

/**
 * A step's data is read when it mounts: the Clerk team (its name and pending invitations) on the
 * team step, the plan catalog on the plan step (cached after the first read, like the atom).
 */
const entered = (previous: Model, result: UpdateReturn, hasPlan: boolean): UpdateReturn => {
	const { model } = result
	if (model.state === null || isQuickStartFinished(model.state)) return result
	const step = resolveQuickStartStep(model.state, hasPlan)
	const wasOn = previous.state === null ? null : resolveQuickStartStep(previous.state, hasPlan)
	if (step === wasOn) return result
	if (step === "team" && isClerkAuthEnabled)
		return {
			...result,
			model: { ...model, team: loadingTeam() },
			commands: [...(result.commands ?? []), Command.mapMessage(toTeam)(LoadTeam())],
		}
	if (step === "plan" && !model.isPlansRequested) {
		const pricing = PricingCards.initReturning(model.isCheckoutReturn)
		return {
			...result,
			model: { ...model, isPlansRequested: true, pricing: pricing.model },
			commands: [...(result.commands ?? []), ...Command.mapMessages(pricing.commands, toPricing)],
		}
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

/** `hasPlan` is the root's (`hasPlanOf`): the steps resolve as the view shows them. */
export const update = (model: Model, message: Message, hasPlan: boolean): UpdateReturn =>
	entered(model, step(model, message, hasPlan), hasPlan)

const step = (model: Model, message: Message, hasPlan: boolean): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		GotTeamMessage: ({ message: child }) => {
			const next = updateTeam(model.team, child)
			return {
				model: { ...model, team: next.team },
				commands: Command.mapMessages(next.commands, toTeam),
			}
		},
		GotPricingMessage: ({ message: child }) => {
			const next = PricingCards.update(model.pricing, child)
			return {
				model: { ...model, pricing: next.model },
				commands: Command.mapMessages(next.commands ?? [], toPricing),
				outMessage: next.outMessage,
			}
		},
		// Someone who already finished is sent straight on; without a plan the gate would send them
		// back, so they land on the plan step instead.
		LoadedQuickStartState: ({ state }) =>
			!isQuickStartFinished(state)
				? { model: { ...model, state } }
				: hasPlan
					? { model: { ...model, state }, commands: [Finish({ url: model.redirectUrl })] }
					: { model: { ...model, state: reopenedForPlan(state) } },
		ToggledLanguage: ({ language }) =>
			saved(model, (state) =>
				withStack(state, { ...state.stack, languages: toggled(state.stack.languages, language) }),
			),
		ToggledPlatform: ({ platform }) =>
			saved(model, (state) =>
				withStack(state, { ...state.stack, platforms: toggled(state.stack.platforms, platform) }),
			),
		ClickedContinue: ({ step }) => {
			if (model.state === null) return { model }
			const next = saved(model, (state) => completeStep(state, step, hasPlan))
			const isLast = hasPlan && next.model.state !== null && isQuickStartFinished(next.model.state)
			return {
				...next,
				commands: [
					TrackStepCompleted({ step }),
					...(next.commands ?? []),
					...(isLast ? [Finish({ url: model.redirectUrl })] : []),
				],
			}
		},
		ClickedBack: ({ to }) => saved(model, (state) => ({ ...state, activeStep: to })),
		CompletedSaveQuickStartState: () => ({ model }),
		CompletedTrackStepCompleted: () => ({ model }),
		PickedRegion: ({ region }) =>
			model.region.isSaving
				? { model }
				: { model: { ...model, region: { ...model.region, selected: region } } },
		ClickedRegionContinue: () =>
			model.region.isSaving
				? { model }
				: {
						model: {
							...model,
							isRegionStepShown: true,
							region: { ...model.region, isSaving: true, errorMessage: null },
						},
						commands: [ChooseRegion({ region: model.region.selected })],
					},
		SucceededChooseRegion: ({ region }) => ({ model, commands: [FollowChosenRegion({ region })] }),
		FailedChooseRegion: ({ message: failure }) => ({
			model: {
				...model,
				region: {
					...model.region,
					isSaving: false,
					errorMessage: failure === "" ? "Could not save the data region" : failure,
				},
			},
		}),
		CompletedReloadOrganization: () => ({
			model: { ...model, region: { ...model.region, isSaving: false } },
		}),
		CompletedLeaveForRegion: () => ({ model }),
		CompletedFinish: () => ({ model }),
		CompletedMountDitherField: () => ({ model }),
	})

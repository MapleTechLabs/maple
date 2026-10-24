import {
	STACK_LANGUAGE_IDS,
	STACK_PLATFORM_IDS,
	type StackPlatform,
	toggled,
} from "../../lib/onboarding-stack"
import { ChooseOrganizationRegionRequest } from "@maple/domain/http"
import { MapleRegion } from "@maple/domain/organization-regions"
import { currentRegion, regionAppUrl } from "../../lib/region"
import { Effect, Option, Schema } from "effect"
import { AsyncData, Command, Mount, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { isClerkAuthEnabled } from "../../lib/services/common/auth-mode"
import { load, replaceUrl } from "foldkit/navigation"
import { trackProduct } from "../../data/analytics"
import { MapleInternalApiClient } from "../../platform/api-clients"
import { clerkTry, currentClerkOrganization } from "../../platform/clerk"
import { startDitherField } from "../../ui/dither-field"
import type { Resources } from "../../platform/resources"
import * as PricingCards from "./pricing-cards"
import type { PageContext, PageOutMessage } from "../contract"
import {
	ConnectDrawer,
	type DrawerStep,
	DrawerMessage,
	openDrawer,
	pendingOAuthPlatform,
	updateDrawer,
} from "./quick-start-drawer"
import {
	closeConnect,
	Connect,
	ConnectMessage,
	initConnect,
	openConnect,
	refreshConnected,
	updateConnect,
} from "./quick-start-connect"
import { LiveData, LiveMessage, LoadLiveFindings, updateLive } from "./quick-start-live"
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
	orgId: Schema.String,
	connect: Connect,
	live: LiveData.schema,
	/** A picked platform's connect flow, open over the step (kept while it animates out). */
	drawer: Schema.NullOr(ConnectDrawer),
	/** Whether an update has run with the plan known: the save can load before the customer read. */
	isPlanKnown: Schema.Boolean,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotTeamMessage: { message: TeamMessage },
	GotConnectMessage: { message: ConnectMessage },
	GotLiveMessage: { message: LiveMessage },
	GotPricingMessage: { message: PricingCards.Message },
	ClickedSetUp: { platform: Schema.Literals(STACK_PLATFORM_IDS) },
	GotDrawerMessage: { message: DrawerMessage },
	/** An OAuth return is waiting in this tab: the drawer opens on its provider to finish it. */
	FoundOAuthReturn: { platform: Schema.Literals(STACK_PLATFORM_IDS) },
	CompletedPeekOAuthReturn: {},
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
	/** The root read the customer: the save that loaded before it is settled now. */
	SettledPlan: {},
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

/** A provider's return that landed on `/quick-start` (its popup, or a redirect back). */
export const PeekOAuthReturn = Command.define("PeekOnboardingOAuthReturn", {
	messages: [Message.FoundOAuthReturn, Message.CompletedPeekOAuthReturn],
	execute: Effect.map(pendingOAuthPlatform, (maybePlatform) =>
		Option.match(maybePlatform, {
			onNone: () => Message.CompletedPeekOAuthReturn(),
			onSome: (platform) => Message.FoundOAuthReturn({ platform }),
		}),
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

/** A connect flow's page fact (a toast, a link it followed), for the root to act on. */
export type ConnectFlowOut = Readonly<{ _tag: "RequestedConnectFlowOut"; out: PageOutMessage }>
export type OutMessage = PricingCards.OutMessage | ConnectFlowOut

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

/** `needsRegion`: the org has no region yet, so the region step comes first. */
export const init = (
	storageKey: string,
	isCheckoutReturn = false,
	needsRegion = false,
	redirectUrl = "/",
	orgId = "",
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
		orgId,
		connect: initConnect(),
		live: AsyncData.Idle(),
		drawer: null,
		isPlanKnown: false,
	},
	commands: [LoadQuickStartState({ key: storageKey }), PeekOAuthReturn()],
})

const toTeam = (message: TeamMessage) => Message.GotTeamMessage({ message })
const toConnect = (message: ConnectMessage) => Message.GotConnectMessage({ message })
const toLive = (message: LiveMessage) => Message.GotLiveMessage({ message })
const toPricing = (message: PricingCards.Message) => Message.GotPricingMessage({ message })
const toDrawer = (message: DrawerMessage) => Message.GotDrawerMessage({ message })

/** The drawer's step lifted: a closed drawer re-reads the providers, a page fact goes to the root. */
const withDrawer = (model: Model, step: DrawerStep): UpdateReturn => {
	const next: Model = { ...model, drawer: step.drawer }
	const commands = Command.mapMessages(step.commands, toDrawer)
	const out = step.outMessage
	if (out === undefined) return { model: next, commands }
	if (out._tag !== "ClosedDrawer")
		return { model: next, commands, outMessage: { _tag: "RequestedConnectFlowOut", out } }
	// A source made in the drawer counts as connected for the visit, read or not.
	const connected = out.isDone
		? { ...next.connect.connected, [out.platform]: true }
		: next.connect.connected
	return {
		model: { ...next, connect: { ...next.connect, connected } },
		commands: [
			...commands,
			...Command.mapMessages(
				refreshConnected(model.orgId, model.state?.stack.platforms ?? []),
				toConnect,
			),
		],
	}
}

const openedDrawer = (model: Model, platform: StackPlatform, context: PageContext | null): UpdateReturn =>
	context === null || model.drawer?.dialog.isOpen === true
		? { model }
		: withDrawer(model, openDrawer(platform, context))

/**
 * A step's data is read when it mounts: the Clerk team (its name and pending invitations) on the
 * team step, the plan catalog on the plan step (cached after the first read, like the atom).
 */
const entered = (previous: Model, result: UpdateReturn, hasPlan: boolean): UpdateReturn => {
	if (result.model.state === null || isQuickStartFinished(result.model.state)) return result
	const step = resolveQuickStartStep(result.model.state, hasPlan)
	const wasOn = previous.state === null ? null : resolveQuickStartStep(previous.state, hasPlan)
	if (step === wasOn) return result
	// Leaving the connect step (or the last screen, which re-reads what arrived) stops their polling.
	const model =
		wasOn === "connect" || wasOn === "live"
			? { ...result.model, connect: closeConnect(result.model.connect) }
			: result.model
	const state = result.model.state
	const commands = result.commands ?? []
	if (step === "live") {
		const opened = openConnect(model.connect, model.orgId, state.stack.platforms)
		return {
			...result,
			model: { ...model, connect: opened.connect, live: AsyncData.Loading() },
			commands: [
				...commands,
				...Command.mapMessages(opened.commands, toConnect),
				Command.mapMessage(toLive)(LoadLiveFindings({ timeZone: "UTC" })),
			],
		}
	}
	if (step === "connect") {
		const opened = openConnect(model.connect, model.orgId, state.stack.platforms)
		return {
			...result,
			model: { ...model, connect: opened.connect },
			commands: [...commands, ...Command.mapMessages(opened.commands, toConnect)],
		}
	}
	if (step === "team" && isClerkAuthEnabled)
		return {
			...result,
			model: { ...model, team: loadingTeam() },
			commands: [...commands, Command.mapMessage(toTeam)(LoadTeam())],
		}
	if (step === "plan" && !model.isPlansRequested) {
		const pricing = PricingCards.initReturning(model.isCheckoutReturn)
		return {
			...result,
			model: { ...model, isPlansRequested: true, pricing: pricing.model },
			commands: [...commands, ...Command.mapMessages(pricing.commands, toPricing)],
		}
	}
	return { ...result, model }
}

/** How many signals the last presence read found arriving. */
const presentCount = (connect: Connect): number =>
	Object.values(AsyncData.getOrElse(connect.presence, () => ({}))).filter(
		(presence) => presence.status === "present",
	).length

/** Every change is written through, as the atom's `setState` is. */
const saved = (model: Model, next: (state: QuickStartState) => QuickStartState): UpdateReturn => {
	if (model.state === null) return { model }
	const state = next(model.state)
	return {
		model: { ...model, state },
		commands: [SaveQuickStartState({ key: model.storageKey, state })],
	}
}

/** A loaded save: a finished one is sent on, or without a plan back to the plan step. */
const arrived = (model: Model, state: QuickStartState, hasPlan: boolean): UpdateReturn =>
	!isQuickStartFinished(state)
		? { model: { ...model, state } }
		: hasPlan
			? { model: { ...model, state }, commands: [Finish({ url: model.redirectUrl })] }
			: { model: { ...model, state: reopenedForPlan(state) } }

/**
 * `hasPlan` is the root's (`planOf`), so the steps resolve as the view shows them; `null` while the
 * customer read is out (the view shows the boot splash), when a loaded save waits for it.
 */
export const update = (
	model: Model,
	message: Message,
	hasPlan: boolean | null,
	/** The active org's, for the connect drawer's flow; without it the drawer stays shut. */
	context: PageContext | null = null,
): UpdateReturn => {
	if (hasPlan === null)
		return message._tag === "LoadedQuickStartState"
			? { model: { ...model, state: message.state } }
			: step(model, message, false, context)
	const known = model.isPlanKnown ? model : { ...model, isPlanKnown: true }
	// The root's word that the plan is known: settle a save that loaded before it, and enter its step.
	if (message._tag === "SettledPlan" && !model.isPlanKnown && model.state !== null)
		return entered({ ...known, state: null }, arrived(known, model.state, hasPlan), hasPlan)
	return entered(model, step(known, message, hasPlan, context), hasPlan)
}

const step = (model: Model, message: Message, hasPlan: boolean, context: PageContext | null): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		GotTeamMessage: ({ message: child }) => {
			const next = updateTeam(model.team, child)
			return {
				model: { ...model, team: next.team },
				commands: Command.mapMessages(next.commands, toTeam),
			}
		},
		GotConnectMessage: ({ message: child }) => {
			const platforms = model.state?.stack.platforms ?? []
			const next = updateConnect(model.connect, child, model.orgId, platforms)
			// On the last screen, a signal that just arrived re-reads the cards' findings.
			const isOnLive = model.state !== null && resolveQuickStartStep(model.state, hasPlan) === "live"
			const isNewSignal = presentCount(next.connect) > presentCount(model.connect)
			return {
				model: { ...model, connect: next.connect },
				commands: [
					...Command.mapMessages(next.commands, toConnect),
					...(isOnLive && isNewSignal
						? [Command.mapMessage(toLive)(LoadLiveFindings({ timeZone: "UTC" }))]
						: []),
				],
			}
		},
		GotLiveMessage: ({ message: child }) => ({
			model: { ...model, live: updateLive(model.live, child) },
		}),
		GotPricingMessage: ({ message: child }) => {
			const next = PricingCards.update(model.pricing, child)
			return {
				model: { ...model, pricing: next.model },
				commands: Command.mapMessages(next.commands ?? [], toPricing),
				outMessage: next.outMessage,
			}
		},
		ClickedSetUp: ({ platform }) => openedDrawer(model, platform, context),
		FoundOAuthReturn: ({ platform }) => openedDrawer(model, platform, context),
		CompletedPeekOAuthReturn: () => ({ model }),
		GotDrawerMessage: ({ message: child }) =>
			model.drawer === null || context === null
				? { model }
				: withDrawer(model, updateDrawer(model.drawer, child, context)),
		// Someone who already finished is sent straight on; without a plan the gate would send them
		// back, so they land on the plan step instead.
		LoadedQuickStartState: ({ state }) => arrived(model, state, hasPlan),
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
			// Done without a plan (a save from before the plan came first): back to the plan step, not on.
			const next = saved(model, (state) => {
				const completed = completeStep(state, step, hasPlan)
				return !hasPlan && isQuickStartFinished(completed) ? reopenedForPlan(completed) : completed
			})
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
		SettledPlan: () => ({ model }),
	})

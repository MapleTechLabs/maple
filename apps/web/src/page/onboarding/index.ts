import { validateInternalRedirect } from "@maple/ui/lib/sanitizers"
import { isClerkAuthEnabled } from "../../lib/services/common/auth-mode"
import { Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { load } from "foldkit/navigation"
import { clearSessionToken } from "../../platform/auth-api"
import { signOutOfClerk } from "../../platform/clerk"
import type { Resources } from "../../platform/resources"
import { AppRoute, hrefOf } from "../../route"
import { needsRegion, planOf, wrongRegionOf } from "./plan-gate"
import * as OrgSwitcher from "../../shell/clerk-org-switcher"
import * as Menu from "../../ui/menu"
import type { PageContext, PageSubscriptionInput } from "../contract"
import type * as SourcesFlow from "../sources/new/embed"
import * as CliLogin from "./cli-login"
import * as ClerkScreens from "./clerk-screens"
import * as ClerkSignIn from "./clerk-sign-in"
import * as CreateOrg from "./create-org"
import type { Inputs } from "./inputs"
import * as McpAuthorize from "./mcp-authorize"
import * as QuickStart from "./quick-start"
import { DrawerMessage, isDrawerListening } from "./quick-start-drawer"
import { storageKeyOf } from "./quick-start-state"
import * as SelectPlan from "./select-plan"
import * as Unsubscribe from "./unsubscribe"
import * as PricingCards from "./pricing-cards"

export type { Inputs } from "./inputs"

/**
 * The onboarding and auth-handoff screens rendered without `DashboardLayout`: CLI login,
 * MCP consent, unsubscribe, quick start, plan selection, org selection and sign-up. Some are
 * public or org-less, so they cannot take a `PageContext`; the root holds the open one here.
 */

// MODEL

export const Screen = Schema.Union([
	CliLogin.Model,
	McpAuthorize.Model,
	Unsubscribe.Model,
	ClerkSignIn.Model,
	CreateOrg.Model,
	ClerkScreens.SignUp,
	ClerkScreens.WrongRegion,
	QuickStart.Model,
	SelectPlan.Model,
])
export type Screen = typeof Screen.Type

/** The open screen, the route key it was built for, and its Clerk org switcher ("Switch"). */
export const Model = Schema.Struct({
	key: Schema.String,
	screen: Screen,
	switcher: OrgSwitcher.Model,
	/** The onboarding header's account menu (`OnboardingUserMenu`). */
	userMenu: Menu.Model,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
	GotCliLoginMessage: { message: CliLogin.Message },
	GotMcpAuthorizeMessage: { message: McpAuthorize.Message },
	GotUnsubscribeMessage: { message: Unsubscribe.Message },
	GotSwitcherMessage: { message: OrgSwitcher.Message },
	GotClerkSignInMessage: { message: ClerkSignIn.Message },
	GotQuickStartMessage: { message: QuickStart.Message },
	GotCreateOrgMessage: { message: CreateOrg.Message },
	GotSelectPlanMessage: { message: SelectPlan.Message },
	GotUserMenuMessage: { message: Menu.Message },
	CompletedLogOut: {},
	CompletedMountClerkCard: {},
})
export type Message = typeof Message.Type

/** What the root does for a screen: a changed plan refreshes the customer, a failure toasts. */
export const PricingOutMessage = PricingCards.OutMessage
/** Plus the connect drawer's page facts (a flow's toast or a link it followed). */
export type OutMessage = QuickStart.OutMessage

export interface Step {
	readonly model: Model
	readonly commands: ReadonlyArray<Command.Command<Message, never, Resources>>
	readonly outMessage?: OutMessage
}

export const toCliLogin = (message: CliLogin.Message) => Message.GotCliLoginMessage({ message })
export const toMcpAuthorize = (message: McpAuthorize.Message) => Message.GotMcpAuthorizeMessage({ message })
export const toUnsubscribe = (message: Unsubscribe.Message) => Message.GotUnsubscribeMessage({ message })
export const toSwitcher = (message: OrgSwitcher.Message) => Message.GotSwitcherMessage({ message })
export const toClerkSignIn = (message: ClerkSignIn.Message) => Message.GotClerkSignInMessage({ message })
export const toQuickStart = (message: QuickStart.Message) => Message.GotQuickStartMessage({ message })
/** Sent by the root once the customer read settles (`QuickStart.SettledPlan`). */
export const settledPlanMessage = toQuickStart(QuickStart.Message.SettledPlan())
export const toCreateOrg = (message: CreateOrg.Message) => Message.GotCreateOrgMessage({ message })
export const toSelectPlan = (message: SelectPlan.Message) => Message.GotSelectPlanMessage({ message })
export const toUserMenu = (message: Menu.Message) => Message.GotUserMenuMessage({ message })

type ScreenResult<ScreenModel, ScreenMessage> = {
	readonly model: ScreenModel
	readonly commands?: ReadonlyArray<Command.Command<ScreenMessage, never, Resources>>
}

const withScreen = <ScreenModel extends Screen, ScreenMessage>(
	model: Model,
	result: ScreenResult<ScreenModel, ScreenMessage>,
	wrap: (message: ScreenMessage) => Message,
): Step => ({
	model: { ...model, screen: result.model },
	commands: Command.mapMessages(result.commands ?? [], wrap),
})

// ROUTES

/** The screen's key for a route it renders in this session, or `None` (a redirect is due). */
export const keyOf = (route: AppRoute, inputs: Inputs): Option.Option<string> => {
	const isSignedOut = inputs.session === "SignedOut"
	const withOrg = (key: string) =>
		!isSignedOut && Option.isSome(inputs.maybeOrgId) ? Option.some(key) : Option.none()
	// `WrongRegionScreen` replaces every org-scoped route; the auth pages redirect first.
	const isWrongRegion =
		isClerkAuthEnabled &&
		Option.isSome(wrongRegionOf(inputs.maybeOrganization)) &&
		Option.isSome(withOrg(""))
	if (isWrongRegion && !AppRoute.isAnyOf(["Unsubscribe", "SignIn", "SignUp", "OrgRequired"])(route))
		return Option.some(`WrongRegion:${hrefOf(route)}`)
	return AppRoute.matchOrElse<Option.Option<string>>(
		route,
		{
			CliLogin: () => withOrg("CliLogin"),
			McpAuthorize: () => withOrg("McpAuthorize"),
			QuickStart: () => withOrg("QuickStart"),
			SelectPlan: () => (isClerkAuthEnabled ? withOrg("SelectPlan") : Option.none()),
			Unsubscribe: ({ search }) => Option.some(Unsubscribe.keyOf(search.token)),
			SignIn: () => (isClerkAuthEnabled && isSignedOut ? Option.some("ClerkSignIn") : Option.none()),
			SignUp: () => (isClerkAuthEnabled && isSignedOut ? Option.some("SignUp") : Option.none()),
			OrgRequired: () =>
				isClerkAuthEnabled && !isSignedOut && Option.isNone(inputs.maybeOrgId)
					? Option.some("OrgRequired")
					: Option.none(),
		},
		() => Option.none(),
	)
}

const fresh = <ScreenModel extends Screen, ScreenMessage>(
	key: string,
	result: ScreenResult<ScreenModel, ScreenMessage>,
	wrap: (message: ScreenMessage) => Message,
): Option.Option<Step> =>
	Option.some(
		withScreen(
			{
				key,
				screen: result.model,
				switcher: OrgSwitcher.init("onboarding-org-switcher"),
				userMenu: Menu.init("onboarding-user-menu"),
			},
			result,
			wrap,
		),
	)

export const init = (route: AppRoute, key: string, inputs: Inputs): Option.Option<Step> =>
	key.startsWith("WrongRegion:")
		? Option.flatMap(wrongRegionOf(inputs.maybeOrganization), (region) =>
				fresh(
					key,
					{ model: ClerkScreens.WrongRegion.make({ region, href: hrefOf(route) }) },
					toClerkSignIn,
				),
			)
		: AppRoute.matchOrElse<Option.Option<Step>>(
				route,
				{
					CliLogin: ({ search }) => fresh(key, CliLogin.init(search.user_code), toCliLogin),
					McpAuthorize: ({ search }) =>
						fresh(key, McpAuthorize.init(search.request_id), toMcpAuthorize),
					QuickStart: ({ search }) =>
						fresh(
							key,
							QuickStart.init(
								storageKeyOf(inputs.maybeOrgId),
								search.checkout === "complete",
								needsRegion(inputs.maybeOrganization),
								validateInternalRedirect(search.redirect_url ?? null) ?? "/",
								Option.getOrElse(inputs.maybeOrgId, () => ""),
							),
							toQuickStart,
						),
					SelectPlan: ({ search }) =>
						fresh(key, SelectPlan.init(search.checkout === "complete"), toSelectPlan),
					Unsubscribe: ({ search }) =>
						fresh(key, { model: Unsubscribe.init(search.token) }, toUnsubscribe),
					SignIn: ({ search }) =>
						fresh(
							key,
							ClerkSignIn.init(validateInternalRedirect(search.redirect_url ?? null)),
							toClerkSignIn,
						),
					// Without a redirect Clerk would send a fresh sign-up to "/"; new users belong in onboarding.
					SignUp: ({ search }) =>
						fresh(
							key,
							{
								model: ClerkScreens.SignUp.make({
									target:
										validateInternalRedirect(search.redirect_url ?? null) ??
										"/quick-start",
								}),
							},
							toClerkSignIn,
						),
					OrgRequired: () => fresh(key, CreateOrg.init(inputs.maybeUser), toCreateOrg),
				},
				() => Option.none(),
			)

// UPDATE

/** The connect drawer's flow reads as a page does, in the active org (no namespace pin here). */
const contextOf = (inputs: Inputs): PageContext | null =>
	Option.match(inputs.maybeOrgId, {
		onNone: () => null,
		onSome: (orgId) => ({ orgId, pinnedNamespace: null, timeZone: inputs.timeZone }),
	})

/** The connect drawer's live flow, as its Subscriptions (the OAuth popup, the polls) read it. */
export const connectFlowOf = (
	model: Model,
	inputs: Inputs,
): Option.Option<PageSubscriptionInput<SourcesFlow.Model>> => {
	const { screen } = model
	const context = contextOf(inputs)
	return screen._tag === "QuickStart" && isDrawerListening(screen.drawer) && context !== null
		? Option.some({ model: screen.drawer.flow, context })
		: Option.none()
}

export const fromConnectFlow = (message: SourcesFlow.Message): Message =>
	toQuickStart(
		QuickStart.Message.GotDrawerMessage({
			message: DrawerMessage.GotFlowMessage({ instance: null, message }),
		}),
	)

const unchanged = (model: Model): Step => ({ model, commands: [] })

/** `signOut()` (Clerk routes to its sign-in), or the self-hosted token cleared and `/sign-in`. */
export const LogOut = Command.define("OnboardingLogOut", {
	messages: [Message.CompletedLogOut],
	execute: (isClerkAuthEnabled ? signOutOfClerk : Effect.andThen(clearSessionToken, load("/sign-in"))).pipe(
		Effect.as(Message.CompletedLogOut()),
	),
})

/** The account menu's only item logs out. */
const updateUserMenu = (model: Model, message: Menu.Message): Step => {
	const next = Menu.update(model.userMenu, message)
	const isLogOut = next.outMessage !== undefined && next.outMessage._tag === "SelectedItem"
	return {
		model: { ...model, userMenu: next.model },
		commands: [...Command.mapMessages(next.commands ?? [], toUserMenu), ...(isLogOut ? [LogOut()] : [])],
	}
}

/** A picked org other than the active one: `setActive`, then its region's app or a reload. */
const updateSwitcher = (model: Model, message: OrgSwitcher.Message, inputs: Inputs): Step => {
	const next = OrgSwitcher.update(model.switcher, message)
	const out = next.outMessage
	const picked =
		out !== undefined &&
		out._tag === "SelectedOrganization" &&
		!Option.contains(inputs.maybeOrgId, out.orgId)
			? inputs.memberships.find((organization) => organization.id === out.orgId)
			: undefined
	return {
		model: { ...model, switcher: next.model },
		commands: [
			...Command.mapMessages(next.commands ?? [], toSwitcher),
			...(picked === undefined
				? []
				: [
						Command.mapMessage(toSwitcher)(
							OrgSwitcher.SwitchOrganization({
								orgId: picked.id,
								targetUrl: OrgSwitcher.switchTargetOf(picked),
							}),
						),
					]),
		],
	}
}

export const update = (model: Model, message: Message, inputs: Inputs): Step => {
	const { screen } = model
	return Message.match<Step>(message, {
		GotCliLoginMessage: ({ message: child }) =>
			screen._tag === "CliLogin"
				? withScreen(model, CliLogin.update(screen, child), toCliLogin)
				: unchanged(model),
		GotMcpAuthorizeMessage: ({ message: child }) =>
			screen._tag === "McpAuthorize"
				? withScreen(model, McpAuthorize.update(screen, child), toMcpAuthorize)
				: unchanged(model),
		GotUnsubscribeMessage: ({ message: child }) =>
			screen._tag === "Unsubscribe"
				? withScreen(model, Unsubscribe.update(screen, child), toUnsubscribe)
				: unchanged(model),
		GotSwitcherMessage: ({ message: child }) => updateSwitcher(model, child, inputs),
		GotClerkSignInMessage: ({ message: child }) =>
			screen._tag === "ClerkSignIn"
				? withScreen(model, ClerkSignIn.update(screen, child), toClerkSignIn)
				: unchanged(model),
		CompletedMountClerkCard: () => unchanged(model),
		GotQuickStartMessage: ({ message: child }) => {
			if (screen._tag !== "QuickStart") return unchanged(model)
			const next = QuickStart.update(screen, child, planOf(inputs.customer), contextOf(inputs))
			const step = withScreen(model, next, toQuickStart)
			return next.outMessage === undefined ? step : { ...step, outMessage: next.outMessage }
		},
		GotSelectPlanMessage: ({ message: child }) => {
			if (screen._tag !== "SelectPlan") return unchanged(model)
			const next = SelectPlan.update(screen, child)
			const step = withScreen(model, next, toSelectPlan)
			return next.outMessage === undefined ? step : { ...step, outMessage: next.outMessage }
		},
		GotCreateOrgMessage: ({ message: child }) =>
			screen._tag === "OrgRequired"
				? withScreen(model, CreateOrg.update(screen, child), toCreateOrg)
				: unchanged(model),
		GotUserMenuMessage: ({ message: child }) => updateUserMenu(model, child),
		CompletedLogOut: () => unchanged(model),
	})
}

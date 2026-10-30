import { OrgId as OrgIdSchema, type OrgId } from "@maple/domain"
import { isClerkAuthEnabled } from "./lib/services/common/auth-mode"
import { validateInternalRedirect } from "@maple/ui/lib/sanitizers"
import { Option, Schema, Struct } from "effect"
import { AsyncData, Command, Update } from "foldkit"
import { UrlRequest } from "foldkit/navigation"
import { Transition } from "foldkit/route"
import { modifyFields } from "foldkit/struct"
import { fromString as urlFromString, toString as urlToString, type Url } from "foldkit/url"
import {
	CheckSession,
	LoadCustomer,
	WaitCustomerGrace,
	HoldPreloads,
	ReleaseReads,
	LoadExternal,
	ReadSessionTimeRange,
	NavigateInternal,
	ReconnectOrgCollections,
	RestoreDashboardWidgets,
	ReplaceUrl,
	SaveSelectedPlanKnown,
	SignOutOfClerk,
	IdentifySession,
	SaveSessionToken,
	WaitForAuthSettle,
	WaitPreloadDelay,
	WriteSessionTimeRange,
} from "./command"
import { Message } from "./message"
import { ClerkPhase, type Model, Session } from "./model"
import { isRedirectOnlyRoute, rendersShell } from "./page/chrome"
import * as Onboarding from "./page/onboarding"
import {
	accessOf,
	CustomerData,
	customerOf,
	type CustomerSlot,
	type Gate,
	isRouteHeld,
	planGate,
} from "./page/onboarding/plan-gate"
import { type PageContext, PageOutMessage, type RootToastAction } from "./page/contract"
import * as Preload from "./page/preload"
import {
	changeContext,
	settleInfraSurfaces,
	blockNavigation,
	enterRoute,
	parkPages,
	isBarePageRoute,
	PageMessage,
	pageHasSource,
	pageIdentity,
	pageSource,
	preloadRoute,
	type PageTransition,
	updatePage,
} from "./page/registry"
import * as SignIn from "./page/sign-in"
import type { Resources } from "./platform/resources"
import { ClerkSnapshot } from "./platform/clerk"
import { identityOf, isSameIdentity } from "./platform/session-identity"
import { AppRoute, hrefOf, isPublicRoute, type Redirect, routeRedirect, urlToAppRoute } from "./route"
import { completeRangeOf, isWithin, withSessionRange } from "./route/session-time-range"
import * as Shell from "./shell"
import * as OrgSwitcher from "./shell/clerk-org-switcher"
import { presenceOf } from "./shell/view-nav"
import { isResolved } from "./shell/source-link"
import * as Toast from "./ui/toast"

type UpdateReturn = Update.Return<Model, Message, Resources>
type Step = Update.Step<Model, Message, Resources>

// CHILDREN

const foldSignInOutMessage = SignIn.OutMessage.match<Step>({
	SucceededSignIn:
		({ token }) =>
		(model) => ({
			model: modifyFields(model, { session: () => Session.Resolving() }),
			commands: [
				SaveSessionToken({ token }),
				NavigateInternal({ url: targetAfterSignIn(model.route) }),
			],
		}),
})

const foldSignIn = Update.foldChild({
	update: SignIn.update,
	read: (model: Model) => Option.some(model.signIn),
	write: (model, nextSignIn) => modifyFields(model, { signIn: () => nextSignIn }),
	toParentMessage: (message: SignIn.Message) => Message.GotSignInMessage({ message }),
	foldOutMessage: foldSignInOutMessage,
})

const shellFoldConfig = {
	read: (model: Model) => Option.some(model.shell),
	write: (model: Model, nextShell: Shell.Model) => modifyFields(model, { shell: () => nextShell }),
	toParentMessage: (message: Shell.Message) => Message.GotShellMessage({ message }),
	// Pages rebuild their queries under the new pin.
	foldOutMessage: Shell.OutMessage.match<Step>({
		ChangedGlobalNamespace: () => (model) =>
			Option.match(pageContextOf(model), {
				onNone: () => ({ model }),
				onSome: (context) => applyPage(changeContext(model.page, context))(model),
			}),
		// A page waiting on the org's surfaces (the /infra overview) requests its reads now.
		SettledInfraSurfaces: () => (model) =>
			Option.match(pageContextOf(model), {
				onNone: () => ({ model }),
				onSome: (context) => applyPage(settleInfraSurfaces(model.page, context))(model),
			}),
		RequestedOrganizationSwitch:
			({ orgId }) =>
			(model) => {
				const picked = model.clerkSnapshot?.memberships.find(
					(organization) => organization.id === orgId,
				)
				return picked === undefined
					? { model }
					: {
							model,
							commands: [
								Command.mapMessage((message: OrgSwitcher.Message) =>
									Message.GotShellMessage({
										message: Shell.Message.GotClerkOrgMenuMessage({ message }),
									}),
								)(
									OrgSwitcher.SwitchOrganization({
										orgId,
										targetUrl: OrgSwitcher.switchTargetOf(picked),
									}),
								),
							],
						}
			},
		RequestedSignOut: () => (model) => ({ model, commands: [SignOutOfClerk()] }),
		RequestedNavigation:
			({ url }) =>
			(model) => ({ model, commands: [navigateTo(model, url, false)] }),
		RequestedCustomerRefresh: () => (model) =>
			model.customer.orgId === null
				? { model }
				: { model, commands: [LoadCustomer({ orgId: model.customer.orgId, refresh: true })] },
		RequestedErrorToast:
			({ title }) =>
			(model) =>
				showPageToast(
					model,
					PageOutMessage.RequestedToast({ type: "error", title, description: "" }),
				),
	}),
}

const foldShell = Update.foldChild({ update: Shell.update, ...shellFoldConfig })

/** A page Message for whatever page is open; another page's Message is dropped by the registry. */
const toPage = (model: Model, message: PageMessage | undefined) =>
	message === undefined
		? { model }
		: Option.match(pageContextOf(model), {
				onNone: () => ({ model }),
				onSome: (context) => applyPage(updatePage(model.page, message, context))(model),
			})

const foldShellStep = (
	step: (
		shell: Shell.Model,
	) => Update.ReturnWithOutMessage<Shell.Model, Shell.Message, Shell.OutMessage, Resources>,
) => Update.foldChildStep({ update: step, ...shellFoldConfig })

/** App-wide toasts; pages add one with `Toast.add` through this fold. */
const foldToasts = Update.foldChild({
	update: Toast.update,
	read: (model: Model) => Option.some(model.toasts),
	write: (model, toasts) => modifyFields(model, { toasts: () => toasts }),
	toParentMessage: (message: Toast.Message) => Message.GotToastMessage({ message }),
})

// PAGES

/** The org a bare public page (a share link) is keyed under when nobody is signed in. */
const PUBLIC_ORG = Schema.decodeUnknownOption(OrgIdSchema)("public")

/** A public page's context: the viewer's org when signed in, else `PUBLIC_ORG`; no shell state. */
const publicContextOf = (model: Model, maybeOrgId: Option.Option<OrgId>): Option.Option<PageContext> =>
	isBarePageRoute(model.route)
		? Option.map(
				Option.orElse(maybeOrgId, () => PUBLIC_ORG),
				(orgId) => ({
					orgId,
					pinnedNamespace: null,
					timeZone: model.timeZone,
				}),
			)
		: Option.none()

/** What every page reads from the root: a signed-in org on a shell route, or a bare public page. */
export const pageContextOf = (model: Model): Option.Option<PageContext> =>
	Session.match(model.session, {
		Resolving: () => Option.none(),
		SignedOut: () => publicContextOf(model, Option.none()),
		SignedIn: ({ maybeOrgId }) =>
			isBarePageRoute(model.route)
				? publicContextOf(model, maybeOrgId)
				: // `WrongRegionScreen` replaces the page, so it reads nothing this region would refuse.
					Option.filter(maybeOrgId, () => rendersShell(model.route) && !isWrongRegion(model)).pipe(
						Option.map((orgId) => ({
							orgId,
							pinnedNamespace: model.shell.pinnedNamespaces[orgId] ?? null,
							timeZone: model.timeZone,
							infra: {
								presence: presenceOf(model.shell),
								isPresenceFailed: AsyncData.isFailure(model.shell.infraPresence),
								integrations: model.shell.integrations,
								remembered: model.shell.rememberedSurfaces[orgId],
							},
						})),
					),
	})

/** A page's request the shell answers: the namespace pin or its infra surfaces. */
const shellRequestOf = (out: PageOutMessage): Option.Option<Shell.Message> =>
	out._tag === "RequestedNamespacePin"
		? Option.some(Shell.Message.ClickedNamespace({ maybeNamespace: out.maybeNamespace }))
		: out._tag === "RequestedInfraSurfaces"
			? Option.some(Shell.Message.RequestedInfraSurfaces())
			: Option.none()

/**
 * Entering a page that links to its source reads the org's sources once; a source the last read
 * does not know (just connected) re-reads them.
 */
const requestPageSources =
	(previousIdentity: string): Step =>
	(model) => {
		const slot = model.page
		if (slot === null || !pageHasSource(slot) || pageIdentity(slot) === previousIdentity) return { model }
		const ref = pageSource(slot)
		const isRefresh = Option.match(AsyncData.getData(model.shell.sources), {
			onNone: () => false,
			onSome: (sources) => ref !== null && !isResolved(ref, sources),
		})
		return foldShell(model, Shell.Message.RequestedSources({ isRefresh }))
	}

/** Writes the page slot, lifts its Commands and follows its navigation and shell requests. */
const applyPage =
	(transition: PageTransition): Step =>
	(model) =>
		Update.combine([
			Option.match(Option.flatMap(transition.outMessage, shellRequestOf), {
				onNone: () => writePage(transition),
				onSome: (shellMessage) =>
					Update.combine([writePage(transition), (next: Model) => foldShell(next, shellMessage)]),
			}),
			requestPageSources(pageIdentity(model.page)),
		])(model)

const isPageMessage = Schema.is(PageMessage)

type PageToast = Extract<PageOutMessage, { readonly _tag: "RequestedToast" }>

/** A page's `toastManager.add`; its action's page Message waits under the toast's id. */
const showPageToast = (model: Model, request: PageToast) => {
	const toastId = Toast.nextToastId(model.toasts)
	const added = Toast.add(model.toasts, {
		type: request.type,
		title: request.title,
		description: request.description,
		...(request.timeoutMs === null || request.timeoutMs === undefined
			? undefined
			: { timeoutMs: request.timeoutMs }),
		...(request.action === null || request.action === undefined
			? request.rootAction === undefined
				? undefined
				: { actionLabel: request.rootAction.label }
			: { actionLabel: request.action.label }),
	})
	const action = request.action ?? null
	const rootAction = action === null ? (request.rootAction ?? null) : null
	return {
		model: modifyFields(model, {
			toasts: () => added.model,
			toastActions: (actions) =>
				action !== null && isPageMessage(action.message)
					? { ...actions, [toastId]: action.message }
					: actions,
			toastRootActions: (actions) =>
				rootAction === null ? actions : { ...actions, [toastId]: rootAction.action },
		}),
		commands: (added.commands ?? []).map(
			Command.mapMessage((message) => Message.GotToastMessage({ message })),
		),
	}
}

/** A toast left the screen: its action button is gone, so is what it would send. */
const withoutToastActions = (model: Model, toastId: string): Model =>
	modifyFields(model, {
		toastActions: (actions) => Struct.omit(actions, [toastId]),
		toastRootActions: (actions) => Struct.omit(actions, [toastId]),
	})

/** A page's out message as the root acts on it: its toasts shown, its navigation and reads to send. */
const actOnPageOut = (model: Model, outMessage: Option.Option<PageOutMessage>) => {
	const toasted = Option.match(
		Option.flatMap(outMessage, (out): Option.Option<PageToast> =>
			out._tag === "RequestedToast"
				? Option.some(out)
				: (out._tag === "RequestedNavigation" || out._tag === "RequestedCustomerRefresh") &&
					  out.toast !== undefined
					? Option.some(
							PageOutMessage.RequestedToast({
								...out.toast,
								timeoutMs: null,
								action: null,
							}),
						)
					: Option.none(),
		),
		{ onNone: () => ({ model, commands: [] }), onSome: (request) => showPageToast(model, request) },
	)
	const followUp = Option.flatMap(outMessage, (out) =>
		out._tag === "RequestedNavigation" && out.followUpToast !== undefined
			? Option.some(
					PageOutMessage.RequestedToast({ ...out.followUpToast, timeoutMs: null, action: null }),
				)
			: Option.none(),
	)
	const followed = Option.match(followUp, {
		onNone: () => toasted,
		onSome: (request) => {
			const shown = showPageToast(toasted.model, request)
			return { model: shown.model, commands: [...toasted.commands, ...shown.commands] }
		},
	})
	const outCommands = Option.match(outMessage, {
		onNone: () => [],
		onSome: PageOutMessage.match({
			RequestedNavigation: ({ url, isReplace, refreshesCustomer }) => [
				navigateTo(model, url, isReplace),
				...(refreshesCustomer === true && model.customer.orgId !== null
					? [LoadCustomer({ orgId: model.customer.orgId, refresh: true })]
					: []),
			],
			RequestedNamespacePin: () => [],
			RequestedInfraSurfaces: () => [],
			RequestedToast: () => [],
			RequestedReconnectOrgCollections: () => [ReconnectOrgCollections()],
			RequestedCustomerRefresh: () =>
				model.customer.orgId === null
					? []
					: [LoadCustomer({ orgId: model.customer.orgId, refresh: true })],
		}),
	})
	return { model: followed.model, outCommands, toastCommands: followed.commands }
}

const writePage =
	(transition: PageTransition): Step =>
	(model) => {
		const followed = actOnPageOut(model, transition.outMessage)
		const held = Preload.held(
			followed.model.preload,
			pageIdentity(transition.slot),
			transition.commands,
			() => Preload.liveKeysOf(transition.slot?.model),
		)
		return {
			model: modifyFields(followed.model, {
				page: () => transition.slot,
				parkedPages: (parked) => parkPages(parked, followed.model.page, transition.slot),
				pageInstances: (built) => Math.max(built, transition.slot?.instance ?? 0),
				preload: () => held.model,
			}),
			commands: [
				...(held.isNewHolder || held.released.length > 0
					? [ReleaseReads({ orgId: transition.slot?.orgId ?? null, keys: held.released })]
					: []),
				...transition.commands.map(
					Command.mapMessage((message) => Message.GotPageMessage({ message })),
				),
				...followed.outCommands,
				...followed.toastCommands,
			],
		}
	}

/** Route entry or leave: the route's page is built, kept (same key) or dropped. */
/** `ClerkReverseRedirects` renders a splash or redirects before the route mounts: no page yet. */
const isPlanGated = (model: Model) => Option.exists(planGateOf(model), isRouteHeld)

const loadPage: Step = (model) =>
	Option.match(
		Option.filter(pageContextOf(model), () => !isPlanGated(model)),
		{
			// Leaving every page (signed out) releases what the last one held, like any page change.
			// Parked pages go too: none may come back in the next session or org.
			onNone: () => {
				const cleared =
					model.parkedPages.length === 0 ? model : modifyFields(model, { parkedPages: () => [] })
				if (model.page === null && model.preload.holder === "") return { model: cleared }
				const left = writePage({ slot: null, commands: [], outMessage: Option.none() })(cleared)
				return left.model.parkedPages.length === 0
					? left
					: { ...left, model: modifyFields(left.model, { parkedPages: () => [] }) }
			},
			onSome: (context) =>
				applyPage(
					enterRoute(model.page, model.route, context, model.pageInstances + 1, model.parkedPages),
				)(model),
		},
	)

// ONBOARDING

/** The session as the onboarding screens read it. */
export const onboardingInputsOf = (model: Model): Option.Option<Onboarding.Inputs> => {
	const snapshot = Option.fromNullishOr(model.clerkSnapshot)
	const clerk = {
		maybeOrganization: Option.flatMap(snapshot, (clerkSnapshot) => clerkSnapshot.maybeOrganization),
		memberships: Option.match(snapshot, {
			onNone: () => [],
			onSome: (clerkSnapshot) => clerkSnapshot.memberships,
		}),
		maybeUser: Option.flatMap(snapshot, (clerkSnapshot) => clerkSnapshot.maybeUser),
		customer: model.customer,
		timeZone: model.timeZone,
		maybePendingTask: Option.flatMap(snapshot, (clerkSnapshot) => clerkSnapshot.maybePendingTask),
	}
	return Session.match(model.session, {
		Resolving: (): Option.Option<Onboarding.Inputs> => Option.none(),
		SignedOut: (): Option.Option<Onboarding.Inputs> =>
			Option.some({ session: "SignedOut", maybeOrgId: Option.none(), ...clerk }),
		SignedIn: ({ maybeOrgId }): Option.Option<Onboarding.Inputs> =>
			Option.some({ session: "SignedIn", maybeOrgId, ...clerk }),
	})
}

/** The Clerk user, orgs and customer the shell reads; `null` self-hosted. */
export const shellClerkOf = (model: Model): Shell.ShellClerk | null =>
	isClerkAuthEnabled
		? Option.match(onboardingInputsOf(model), {
				onNone: () => null,
				onSome: (inputs) => ({
					maybeUser: inputs.maybeUser,
					maybeOrganization: inputs.maybeOrganization,
					memberships: inputs.memberships,
					customer: customerOf(model.customer),
				}),
			})
		: null

const toOnboardingCommands = (step: Onboarding.Step) =>
	step.commands.map(Command.mapMessage((message) => Message.GotOnboardingMessage({ message })))

/** Route entry: the screen is kept while its key holds, rebuilt on a new one, dropped on leave. */
const loadOnboarding: Step = (model) => {
	const maybeInputs = onboardingInputsOf(model)
	const maybeKey = Option.flatMap(maybeInputs, (inputs) => Onboarding.keyOf(model.route, inputs))
	if (Option.isNone(maybeKey) || Option.isNone(maybeInputs)) {
		return { model: model.onboarding === null ? model : modifyFields(model, { onboarding: () => null }) }
	}
	if (model.onboarding !== null && model.onboarding.key === maybeKey.value) return { model }
	return Option.match(Onboarding.init(model.route, maybeKey.value, maybeInputs.value), {
		onNone: () => ({ model: modifyFields(model, { onboarding: () => null }) }),
		onSome: (step) => ({
			model: modifyFields(model, { onboarding: () => step.model }),
			commands: toOnboardingCommands(step),
		}),
	})
}

/** The connect drawer's flow toasts and navigates as a page does (a link it followed leaves onboarding). */
const connectFlowOut =
	(out: PageOutMessage): Step =>
	(model) => {
		const acted = actOnPageOut(model, Option.some(out))
		return { model: acted.model, commands: [...acted.outCommands, ...acted.toastCommands] }
	}

/** A plan change re-reads the customer (`refreshCustomer()`) and toasts, as `PricingCards` does. */
const onboardingOut =
	(out: Onboarding.OutMessage): Step =>
	(model) =>
		out._tag === "RequestedConnectFlowOut"
			? connectFlowOut(out.out)(model)
			: Onboarding.PricingOutMessage.match(out, {
					ChangedPlan: ({ isLeavingForCheckout }) => {
						const toasted = isLeavingForCheckout
							? { model, commands: [] }
							: showPageToast(
									model,
									PageOutMessage.RequestedToast({
										type: "success",
										title: "Plan updated successfully",
										description: "",
									}),
								)
						const orgId = model.customer.orgId
						return orgId === null
							? toasted
							: {
									...toasted,
									commands: [...toasted.commands, LoadCustomer({ orgId, refresh: true })],
								}
					},
					FailedChangePlan: ({ message }) =>
						showPageToast(
							model,
							PageOutMessage.RequestedToast({
								type: "error",
								title: "Failed to update your plan",
								description: message,
							}),
						),
					RequestedCustomerRefresh: () =>
						model.customer.orgId === null
							? { model }
							: {
									model,
									commands: [LoadCustomer({ orgId: model.customer.orgId, refresh: true })],
								},
					RequestedClearCheckoutMarker: () =>
						Option.match(withoutCheckoutMarker(model.route), {
							onNone: () => ({ model }),
							onSome: (url) => ({ model, commands: [ReplaceUrl({ url })] }),
						}),
				})

/** `withoutCheckoutReturn`: the page's own URL without `checkout=complete`. */
const withoutCheckoutMarker = (route: AppRoute): Option.Option<string> =>
	AppRoute.matchOrElse<Option.Option<string>>(
		route,
		{
			SelectPlan: ({ search }) =>
				Option.some(hrefOf(AppRoute.SelectPlan({ search: Struct.omit(search, ["checkout"]) }))),
			QuickStart: ({ search }) =>
				Option.some(hrefOf(AppRoute.QuickStart({ search: Struct.omit(search, ["checkout"]) }))),
			Settings: ({ search }) =>
				Option.some(hrefOf(AppRoute.Settings({ search: Struct.omit(search, ["checkout"]) }))),
		},
		() => Option.none(),
	)

const updateOnboarding = (model: Model, message: Onboarding.Message): UpdateReturn => {
	const onboarding = model.onboarding
	return Option.match(onboardingInputsOf(model), {
		onNone: () => ({ model }),
		onSome: (inputs) => {
			if (onboarding === null) return { model }
			const step = Onboarding.update(onboarding, message, inputs)
			const next = {
				model: modifyFields(model, { onboarding: () => step.model }),
				commands: toOnboardingCommands(step),
			}
			return step.outMessage === undefined
				? next
				: Update.combine([() => next, onboardingOut(step.outMessage)])(model)
		},
	})
}

// ROUTING

/** Where sign-in lands: a same-origin `redirect_url`, else `/`. */
const targetAfterSignIn = (route: AppRoute): string =>
	AppRoute.matchOrElse(
		route,
		{ SignIn: ({ search }) => validateInternalRedirect(search.redirect_url) ?? "/" },
		() => "/",
	)

/** Clerk's reverse redirects: signed in, leave the auth pages. */
const clerkReverseRedirect = (route: AppRoute, maybeOrgId: Option.Option<unknown>): Option.Option<Redirect> =>
	AppRoute.matchOrElse<Option.Option<Redirect>>(
		route,
		{
			SignIn: ({ search }) =>
				Option.some({ url: validateInternalRedirect(search.redirect_url) ?? "/", isReplace: true }),
			SignUp: ({ search }) => {
				const target = validateInternalRedirect(search.redirect_url)
				return Option.some({
					url: target === null || target === "/" ? "/quick-start" : target,
					isReplace: true,
				})
			},
			OrgRequired: ({ search }) =>
				Option.isSome(maybeOrgId)
					? Option.some({
							url: validateInternalRedirect(search.redirect_url) ?? "/",
							isReplace: true,
						})
					: Option.none(),
		},
		() => Option.none(),
	)

const toHome: Redirect = { url: "/", isReplace: true }

/** Self-hosted has no Clerk: its sign-up and org pages `<Navigate to="/" replace />`. */
const selfHostedRedirect = (route: AppRoute): Option.Option<Redirect> =>
	route._tag === "SignUp" || route._tag === "OrgRequired" ? Option.some(toHome) : Option.none()

/** A pending session's task screen is `/sign-in`, returning to where the user was headed. */
const pendingTaskRedirect = (route: AppRoute): Option.Option<Redirect> => {
	if (route._tag === "SignIn" || (isPublicRoute(route) && !isClerkAuthPage(route))) return Option.none()
	const target = AppRoute.matchOrElse(
		route,
		{
			// As `clerkReverseRedirect`: a fresh sign-up belongs in onboarding.
			SignUp: ({ search }) => {
				const signUpTarget = validateInternalRedirect(search.redirect_url)
				return signUpTarget === null || signUpTarget === "/" ? "/quick-start" : signUpTarget
			},
			OrgRequired: ({ search }) => validateInternalRedirect(search.redirect_url),
		},
		() => hrefOf(route),
	)
	return Option.some({
		url: hrefOf(AppRoute.SignIn({ search: { redirect_url: target ?? "/" } })),
		isReplace: true,
	})
}

const pendingTaskOf = (model: Model) =>
	Option.flatMap(Option.fromNullishOr(model.clerkSnapshot), (snapshot) => snapshot.maybePendingTask)

/** The root `beforeLoad` gate: sign-in when signed out, `/org-required` without an org. */
const sessionRedirect = (model: Model): Option.Option<Redirect> =>
	Session.match(model.session, {
		Resolving: () => Option.none(),
		SignedOut: () =>
			isPublicRoute(model.route)
				? Option.none()
				: Option.some({
						url: hrefOf(AppRoute.SignIn({ search: { redirect_url: hrefOf(model.route) } })),
						isReplace: true,
					}),
		SignedIn: ({ maybeOrgId }) => {
			if (isClerkAuthEnabled && Option.isSome(pendingTaskOf(model)))
				return pendingTaskRedirect(model.route)
			if (isPublicRoute(model.route)) {
				return isClerkAuthEnabled
					? clerkReverseRedirect(model.route, maybeOrgId)
					: selfHostedRedirect(model.route)
			}
			if (!isClerkAuthEnabled && model.route._tag === "SelectPlan") return Option.some(toHome)
			return Option.isNone(maybeOrgId)
				? Option.some({
						url: hrefOf(AppRoute.OrgRequired({ search: { redirect_url: hrefOf(model.route) } })),
						isReplace: true,
					})
				: Option.none()
		},
	})

/** The Clerk auth pages: `clerkReverseRedirect` settles those before any plan gate. */
const isClerkAuthPage = AppRoute.isAnyOf(["SignIn", "SignUp", "OrgRequired"])

/** The org Clerk has active, as `useOrganization()` reads it. */
const clerkOrganizationOf = (model: Model) =>
	Option.flatMap(Option.fromNullishOr(model.clerkSnapshot), (snapshot) => snapshot.maybeOrganization)

/** `ClerkReverseRedirects`' plan and region gates, for a signed-in Clerk org off the auth pages. */
export const planGateOf = (model: Model): Option.Option<Gate> =>
	Session.match(model.session, {
		Resolving: () => Option.none<Gate>(),
		SignedOut: () => Option.none<Gate>(),
		SignedIn: ({ maybeOrgId }) =>
			Option.filter(maybeOrgId, () => isClerkAuthEnabled && !isClerkAuthPage(model.route)).pipe(
				Option.map((orgId) =>
					planGate({
						route: model.route,
						organization: clerkOrganizationOf(model),
						customer: model.customer,
						isKnownToRenderApp: model.knownToRenderApp[orgId] ?? false,
					}),
				),
			),
	})

const isWrongRegion = (model: Model): boolean =>
	Option.exists(planGateOf(model), (gate) => gate.wrongRegion !== null)

const followRedirects: Step = (model) => {
	const maybeRedirect = Session.match(model.session, {
		Resolving: () => Option.none<Redirect>(),
		SignedOut: () => Option.orElse(routeRedirect(model.route), () => sessionRedirect(model)),
		SignedIn: () =>
			Option.orElse(routeRedirect(model.route), () => sessionRedirect(model)).pipe(
				Option.orElse(() => Option.flatMap(planGateOf(model), (gate) => gate.redirect)),
			),
	})
	return Option.match(maybeRedirect, {
		onNone: () => ({ model }),
		onSome: ({ url, isReplace }) => ({
			model,
			commands: [navigateTo(model, url, isReplace)],
		}),
	})
}

/** Route-driven loads, shared by the cold load and every navigation: the shell boots on its first route. */
const loadRoute: Step = (model) =>
	Session.match(model.session, {
		Resolving: () => ({ model }),
		SignedOut: () => ({ model }),
		SignedIn: ({ maybeOrgId }) =>
			// `WrongRegionScreen` replaces the whole frame: no shell, nothing it reads.
			Option.isNone(maybeOrgId) ||
			isPublicRoute(model.route) ||
			isWrongRegion(model) ||
			!rendersShell(model.route)
				? { model }
				: foldShellStep(Shell.enter(maybeOrgId.value))(model),
	})

/**
 * `useMapleCustomer` in `ClerkReverseRedirects`: once Clerk has an org that this region serves,
 * its customer is read once (the atom is shared app-wide).
 */
const loadCustomer: Step = (model) => {
	if (!isClerkAuthEnabled) return { model }
	const maybeOrgId = Session.match(model.session, {
		Resolving: () => Option.none<OrgId>(),
		SignedOut: () => Option.none<OrgId>(),
		SignedIn: ({ maybeOrgId: orgId }) => orgId,
	})
	const isServed = Option.exists(clerkOrganizationOf(model), (organization) => organization.isServedHere)
	if (Option.isNone(maybeOrgId) || !isServed || model.customer.orgId === maybeOrgId.value) return { model }
	return {
		model: modifyFields(model, {
			customer: () => ({ orgId: maybeOrgId.value, data: CustomerData.Loading() }),
		}),
		commands: [
			LoadCustomer({ orgId: maybeOrgId.value, refresh: false }),
			...(model.knownToRenderApp[maybeOrgId.value] === true
				? []
				: [WaitCustomerGrace({ orgId: maybeOrgId.value })]),
		],
	}
}

/** A first visit's customer read outlived the grace: render the app as a known org would, in memory only. */
const elapsedCustomerGrace = (model: Model, orgId: string): UpdateReturn =>
	model.customer.orgId !== orgId || accessOf(model.customer) !== "loading"
		? { model }
		: settle(
				modifyFields(model, {
					knownToRenderApp: () => ({ ...model.knownToRenderApp, [orgId]: true }),
				}),
			)

/** A customer read for the current org settled: remember the access, then re-run the gates. */
/** The quick start learns the plan is known: a save it loaded before the customer read settles. */
const withSettledPlan = (step: UpdateReturn): UpdateReturn => {
	if (step.model.onboarding?.screen._tag !== "QuickStart") return step
	const next = updateOnboarding(step.model, Onboarding.settledPlanMessage)
	return { ...next, commands: [...(step.commands ?? []), ...(next.commands ?? [])] }
}

const settledCustomer = (model: Model, orgId: string, data: CustomerSlot["data"]): UpdateReturn => {
	if (model.customer.orgId !== orgId) return { model }
	const next = modifyFields(model, { customer: () => ({ orgId, data }) })
	const access = accessOf(next.customer)
	const settled = withSettledPlan(settle(next))
	return access === "app" || access === "onboarding"
		? {
				model: settled.model,
				commands: [
					...(settled.commands ?? []),
					SaveSelectedPlanKnown({ orgId, mayRenderApp: access === "app" }),
				],
			}
		: settled
}

// SESSION TIME RANGE

/** The signed-in org, on a shell route. */
const shellOrgOf = (model: Model): Option.Option<string> =>
	Session.match(model.session, {
		Resolving: () => Option.none(),
		SignedOut: () => Option.none(),
		SignedIn: ({ maybeOrgId }) => maybeOrgId,
	})

/** `persistSessionTimeRange` after a navigation settles; the org's memory is read once first. */
const syncSessionTimeRange: Step = (model) =>
	Option.match(shellOrgOf(model), {
		onNone: () => ({ model }),
		onSome: (orgId) => {
			const state = model.sessionTimeRange
			if (state === null || state.orgId !== orgId)
				return {
					model: modifyFields(model, {
						sessionTimeRange: () => ({ orgId, value: {}, nowMs: 0, isLoaded: false }),
					}),
					commands: [ReadSessionTimeRange({ orgId })],
				}
			if (!state.isLoaded) return { model }
			return Option.match(
				Option.filter(
					completeRangeOf(model.route),
					(value) =>
						JSON.stringify(value) !== JSON.stringify(state.value) &&
						isWithin(value, Number.POSITIVE_INFINITY, state.nowMs, model.timeZone),
				),
				{
					onNone: () => ({ model }),
					onSome: (value) => ({
						model: modifyFields(model, { sessionTimeRange: () => ({ ...state, value }) }),
						commands: [WriteSessionTimeRange({ orgId, value })],
					}),
				},
			)
		},
	})

const pathOf = (url: Url): string =>
	`${url.pathname}${Option.match(url.search, { onNone: () => "", onSome: (search) => `?${search}` })}`

/** `sessionTimeRangeSearchMiddleware`: the URL a navigation lands on, the remembered window added. */
const sessionRangeUrl = (model: Model, url: Url): Option.Option<string> => {
	const state = model.sessionTimeRange
	return state === null || !state.isLoaded || !Option.contains(shellOrgOf(model), state.orgId)
		? Option.none()
		: withSessionRange(urlToAppRoute(url), pathOf(url), state.value, state.nowMs, model.timeZone)
}

/**
 * `navigate()`/`<Link>`: TanStack runs the search middleware in `buildLocation`, so the remembered
 * window joins the URL a navigation builds; Back/Forward (`ChangedUrl` alone) are left as they are.
 */
const navigateTo = (model: Model, url: string, isReplace: boolean) => {
	const target = Option.getOrElse(
		Option.flatMap(urlFromString(new URL(url, "http://app.invalid").href), (parsed) =>
			sessionRangeUrl(model, parsed),
		),
		() => url,
	)
	return isReplace ? ReplaceUrl({ url: target }) : NavigateInternal({ url: target })
}

/** Everything that reads the route or the session. */
export const settle: Step = Update.combine([
	followRedirects,
	loadCustomer,
	loadRoute,
	loadPage,
	loadOnboarding,
	syncSessionTimeRange,
])

// SESSION

const signedIn =
	(maybeOrgId: Option.Option<OrgId>): Step =>
	(model) =>
		settle(modifyFields(model, { session: () => Session.SignedIn({ maybeOrgId }) }))

const signedOut: Step = (model) => settle(modifyFields(model, { session: () => Session.SignedOut() }))

const isSameClerkSnapshot = Schema.toEquivalence(ClerkSnapshot)

/** Clerk emits on every token refresh and tab focus. An unchanged snapshot was already settled, so it keeps the model. */
const changedClerkSession = (model: Model, snapshot: ClerkSnapshot): UpdateReturn =>
	model.clerkSnapshot !== null && isSameClerkSnapshot(model.clerkSnapshot, snapshot)
		? { model }
		: appliedClerkSnapshot(snapshot, false)(model)

/** `useClerkAuthSettled`: a signed-out first answer waits for a refreshing session, except on public pages. */
const appliedClerkSnapshot =
	(snapshot: ClerkSnapshot, isFirstAnswer: boolean): Step =>
	(previous) => {
		const model = modifyFields(previous, { clerkSnapshot: () => snapshot })
		const identity = identityOf(snapshot)
		const known = previous.clerkSnapshot === null ? undefined : identityOf(previous.clerkSnapshot)
		const identify =
			known !== undefined && isSameIdentity(known, identity) ? [] : [IdentifySession({ identity })]
		if (Option.isSome(snapshot.maybeUserId)) {
			// The API rejects a pending session: nothing org-scoped (shell, customer) loads until the task is done.
			const step = signedIn(
				Option.isSome(snapshot.maybePendingTask) ? Option.none() : snapshot.maybeOrgId,
			)(model)
			return { ...step, commands: [...identify, ...(step.commands ?? [])] }
		}
		if (identify.length > 0 && model.session._tag !== "Resolving") {
			const step = signedOut(model)
			return { ...step, commands: [...identify, ...(step.commands ?? [])] }
		}
		if (model.session._tag !== "Resolving") {
			return signedOut(model)
		}
		if (!isFirstAnswer) {
			return { model }
		}
		return isPublicRoute(model.route) ? signedOut(model) : { model, commands: [WaitForAuthSettle()] }
	}

// PRELOAD

const withPreload = (model: Model, preload: Preload.Model) => modifyFields(model, { preload: () => preload })

/** The delay elapsed on a link still intended: run its route's page preload under that route's context. */
const preloadLink = (model: Model, href: string, nowMs: number): UpdateReturn =>
	Option.match(
		Option.flatMap(urlFromString(href), (hovered) => {
			// The link's location goes through the session-range middleware, so the preload sees its window.
			const url = Option.getOrElse(
				Option.flatMap(sessionRangeUrl(model, hovered), (path) =>
					urlFromString(new URL(path, href).href),
				),
				() => hovered,
			)
			const route = urlToAppRoute(url)
			return Option.map(pageContextOf(modifyFields(model, { route: () => route })), (context) =>
				preloadRoute(route, context, nowMs),
			)
		}),
		{
			onNone: () => ({ model }),
			onSome: (commands) => {
				const keys = Preload.keysOf(commands)
				return {
					model,
					commands: [
						...commands.map(
							Command.mapMessage((message) => Message.GotPreloadMessage({ message })),
						),
						...(keys.length === 0 ? [] : [HoldPreloads({ keys })]),
					],
				}
			},
		},
	)

/** A new URL: the route and the page it enters. The remembered window joined in `navigateTo`, never here. */
const changedUrlStep = (model: Model, changedUrl: Url): UpdateReturn => {
	const nextRoute = urlToAppRoute(changedUrl)
	const isEnteringSignIn = Transition.isEntering(Transition.make(model.route, nextRoute), "SignIn")
	const routed = modifyFields(model, {
		route: () => nextRoute,
		signIn: (signIn) => (isEnteringSignIn ? SignIn.init() : signIn),
	})
	const hasTopBar = rendersShell(nextRoute) && !isRedirectOnlyRoute(model.route)
	return Update.combine([
		foldShellStep(Shell.routeChanged(model.route._tag === nextRoute._tag, hasTopBar)),
		settle,
	])(routed)
}

/** The Command behind a root toast action. */
const rootToastCommand = (action: RootToastAction | undefined) =>
	action !== undefined && action._tag === "RestoreDashboardWidgets"
		? RestoreDashboardWidgets(action)
		: ReconnectOrgCollections()

/** `useBlocker`: the open page holds a navigation that would leave it, and asks instead. */
const heldNavigation = (model: Model, url: Url): Option.Option<UpdateReturn> =>
	Option.flatMap(pageContextOf(model), (context) =>
		Option.map(blockNavigation(model.page, urlToAppRoute(url), urlToString(url), context), (transition) =>
			applyPage(transition)(model),
		),
	)

// UPDATE

const foldMessage = (model: Model, message: Message) =>
	Message.match<UpdateReturn>(message, {
		ClickedLink: ({ request }) =>
			UrlRequest.match<UpdateReturn>(request, {
				Internal: ({ url }) =>
					Option.getOrElse(heldNavigation(model, url), () => ({
						model,
						commands: [navigateTo(model, urlToString(url), false)],
					})),
				External: ({ href }) => ({ model, commands: [LoadExternal({ href })] }),
			}),
		ChangedUrl: ({ url: changedUrl }) =>
			Option.getOrElse(
				// Back or Forward away from a page that blocks it: the URL goes back while it asks.
				Option.map(heldNavigation(model, changedUrl), (held) => ({
					...held,
					commands: [NavigateInternal({ url: hrefOf(model.route) }), ...(held.commands ?? [])],
				})),
				() => changedUrlStep(model, changedUrl),
			),
		CompletedNavigateInternal: () => ({ model }),
		CompletedReplaceUrl: () => ({ model }),
		CompletedLoadExternal: () => ({ model }),
		SucceededCheckSession: ({ orgId }) => signedIn(Option.some(orgId))(model),
		FailedCheckSession: () => signedOut(model),
		ChangedSelfHostedSession: () => ({ model, commands: [CheckSession()] }),
		CompletedSaveSessionToken: () => ({ model, commands: [CheckSession()] }),
		CompletedLoadClerk: ({ snapshot }) =>
			appliedClerkSnapshot(snapshot, true)(modifyFields(model, { clerk: () => ClerkPhase.Loaded() })),
		FailedLoadClerk: ({ message }) =>
			signedOut(modifyFields(model, { clerk: () => ClerkPhase.Failed({ message }) })),
		ChangedClerkSession: ({ snapshot }) => changedClerkSession(model, snapshot),
		CompletedWaitForAuthSettle: () => (model.session._tag === "Resolving" ? signedOut(model) : { model }),
		SucceededLoadCustomer: ({ orgId, customer }) =>
			settledCustomer(model, orgId, CustomerData.Success({ data: customer })),
		FailedLoadCustomer: ({ orgId }) =>
			settledCustomer(model, orgId, CustomerData.Failure({ error: "Failed" })),
		ElapsedCustomerGrace: ({ orgId }) => elapsedCustomerGrace(model, orgId),
		CompletedSaveSelectedPlanKnown: () => ({ model }),
		CompletedSignOutOfClerk: () => ({ model }),
		CompletedIdentifySession: () => ({ model }),
		GotSignInMessage: ({ message }) => foldSignIn(model, message),
		GotShellMessage: ({ message }) => foldShell(model, message),
		GotToastMessage: ({ message }) =>
			message._tag === "ClickedToastAction" && model.toastActions[message.toastId] !== undefined
				? toPage(model, model.toastActions[message.toastId])
				: message._tag === "ClickedToastAction" &&
					  model.toastRootActions[message.toastId] !== undefined
					? { model, commands: [rootToastCommand(model.toastRootActions[message.toastId])] }
					: message._tag === "EndedToastTransition"
						? foldToasts(withoutToastActions(model, message.toastId), message)
						: foldToasts(model, message),
		CompletedReconnectOrgCollections: () => ({ model }),
		CompletedRestoreDashboardWidgets: () => ({ model }),
		GotPageMessage: ({ message }) => toPage(model, message),
		GotOnboardingMessage: ({ message }) => updateOnboarding(model, message),
		IntendedLink: ({ href, isImmediate }) =>
			Option.match(Preload.intended(model.preload, href), {
				onNone: () => ({ model }),
				onSome: (next) => ({
					model: withPreload(model, next.model),
					commands: [
						WaitPreloadDelay({
							href,
							version: next.version,
							delayMs: isImmediate ? 0 : Preload.PRELOAD_DELAY_MS,
						}),
					],
				}),
			}),
		EndedLinkIntent: ({ href }) => ({ model: withPreload(model, Preload.ended(model.preload, href)) }),
		ElapsedPreloadDelay: ({ href, version, nowMs }) =>
			Option.match(Preload.elapsed(model.preload, href, version), {
				onNone: () => ({ model }),
				onSome: (preload) => preloadLink(withPreload(model, preload), href, nowMs),
			}),
		// The answer is in the read cache, where the opening page's own read finds it.
		GotPreloadMessage: () => ({ model }),
		ExpiredPreloads: ({ keys }) => {
			const released = Preload.expired(model.preload, keys)
			return {
				model,
				commands: released.length === 0 ? [] : [ReleaseReads({ orgId: null, keys: released })],
			}
		},
		CompletedReleaseReads: () => ({ model }),
		LoadedSessionTimeRange: ({ orgId, value, nowMs }) =>
			model.sessionTimeRange?.orgId === orgId
				? syncSessionTimeRange(
						modifyFields(model, {
							sessionTimeRange: () => ({ orgId, value, nowMs, isLoaded: true }),
						}),
					)
				: { model },
		// Every reader of `effectiveTimezone` re-renders: the open page re-resolves under the new zone.
		ChangedTimeZonePreference: ({ timeZone }) => {
			if (timeZone === model.timeZone) return { model }
			const zoned = modifyFields(model, { timeZone: () => timeZone })
			return Option.match(pageContextOf(zoned), {
				onNone: () => ({ model: zoned }),
				onSome: (context) => applyPage(changeContext(zoned.page, context))(zoned),
			})
		},
		CompletedWriteSessionTimeRange: ({ nowMs }) => ({
			model: modifyFields(model, {
				sessionTimeRange: (state) => (state === null ? null : { ...state, nowMs }),
			}),
		}),
	})

/**
 * A child fold that changed nothing still writes a fresh root object; hand back the old one so
 * the runtime, which re-renders on any new Model reference, skips the frame.
 */
export const update = (model: Model, message: Message): UpdateReturn => {
	const result = foldMessage(model, message)
	const next = result.model
	return next !== model && Struct.keys(model).every((key) => model[key] === next[key])
		? { ...result, model }
		: result
}

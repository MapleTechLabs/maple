import { OrgId as OrgIdSchema, type OrgId } from "@maple/domain"
import { isClerkAuthEnabled } from "@maple/web/lib/services/common/auth-mode"
import { validateInternalRedirect } from "@maple/ui/lib/sanitizers"
import { Option, Schema } from "effect"
import { Command, Update } from "foldkit"
import { UrlRequest } from "foldkit/navigation"
import { Transition } from "foldkit/route"
import { modifyFields } from "foldkit/struct"
import { toString as urlToString } from "foldkit/url"
import {
	CheckSession,
	LoadExternal,
	NavigateInternal,
	ReplaceUrl,
	SaveSessionToken,
	WaitForAuthSettle,
} from "./command"
import { Message } from "./message"
import { ClerkPhase, type Model, Session } from "./model"
import { rendersShell } from "./page/chrome"
import { type PageContext, PageOutMessage } from "./page/contract"
import {
	changeContext,
	enterRoute,
	isBarePageRoute,
	PageMessage,
	type PageTransition,
	updatePage,
} from "./page/registry"
import * as SignIn from "./page/sign-in"
import type { Resources } from "./platform/resources"
import type { ClerkSnapshot } from "./platform/clerk"
import { AppRoute, hrefOf, isPublicRoute, type Redirect, routeRedirect, urlToAppRoute } from "./route"
import * as Shell from "./shell"
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
		? Option.map(Option.orElse(maybeOrgId, () => PUBLIC_ORG), (orgId) => ({
				orgId,
				pinnedNamespace: null,
				timeZone: model.timeZone,
			}))
		: Option.none()

/** What every page reads from the root: a signed-in org on a shell route, or a bare public page. */
export const pageContextOf = (model: Model): Option.Option<PageContext> =>
	Session.match(model.session, {
		Resolving: () => Option.none(),
		SignedOut: () => publicContextOf(model, Option.none()),
		SignedIn: ({ maybeOrgId }) =>
			isBarePageRoute(model.route)
				? publicContextOf(model, maybeOrgId)
				: Option.filter(maybeOrgId, () => rendersShell(model.route)).pipe(
				Option.map((orgId) => ({
					orgId,
					pinnedNamespace: model.shell.pinnedNamespaces[orgId] ?? null,
					timeZone: model.timeZone,
				})),
			),
	})

/** Writes the page slot, lifts its Commands and follows its navigation and pin requests. */
const applyPage =
	(transition: PageTransition): Step =>
	(model) =>
		Option.match(
			Option.filter(transition.outMessage, (out) => out._tag === "RequestedNamespacePin"),
			{
				onNone: () => writePage(transition)(model),
				onSome: (out) =>
					Update.combine([
						writePage(transition),
						(next: Model) =>
							foldShell(
								next,
								Shell.Message.ClickedNamespace({
									maybeNamespace:
										out._tag === "RequestedNamespacePin"
											? out.maybeNamespace
											: Option.none(),
								}),
							),
					])(model),
			},
		)

const isPageMessage = Schema.is(PageMessage)

type PageToast = Extract<PageOutMessage, { readonly _tag: "RequestedToast" }>

/** A page's `toastManager.add`; its action's page Message waits under the toast's id. */
const showPageToast = (model: Model, request: PageToast) => {
	const toastId = Toast.nextToastId(model.toasts)
	const added = Toast.add(model.toasts, {
		type: request.type,
		title: request.title,
		description: request.description,
		...(request.timeoutMs === null || request.timeoutMs === undefined ? undefined : { timeoutMs: request.timeoutMs }),
		...(request.action === null || request.action === undefined ? undefined : { actionLabel: request.action.label }),
	})
	const action = request.action ?? null
	return {
		model: modifyFields(model, {
			toasts: () => added.model,
			toastActions: (actions) =>
				action !== null && isPageMessage(action.message)
					? { ...actions, [toastId]: action.message }
					: actions,
		}),
		commands: (added.commands ?? []).map(
			Command.mapMessage((message) => Message.GotToastMessage({ message })),
		),
	}
}

const writePage =
	(transition: PageTransition): Step =>
	(model) => {
		const toasted = Option.match(
			Option.flatMap(transition.outMessage, (out): Option.Option<PageToast> =>
				out._tag === "RequestedToast"
					? Option.some(out)
					: out._tag === "RequestedNavigation" && out.toast !== undefined
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
		return {
			model: modifyFields(toasted.model, { page: () => transition.slot }),
			commands: [
				...transition.commands.map(
					Command.mapMessage((message) => Message.GotPageMessage({ message })),
				),
				...Option.match(transition.outMessage, {
					onNone: () => [],
					onSome: PageOutMessage.match({
						RequestedNavigation: ({ url, isReplace }) => [
							isReplace ? ReplaceUrl({ url }) : NavigateInternal({ url }),
						],
						RequestedNamespacePin: () => [],
						RequestedToast: () => [],
					}),
				}),
				...toasted.commands,
			],
		}
	}

/** Route entry or leave: the route's page is built, kept (same key) or dropped. */
const loadPage: Step = (model) =>
	Option.match(pageContextOf(model), {
		onNone: () => ({ model: model.page === null ? model : modifyFields(model, { page: () => null }) }),
		onSome: (context) => applyPage(enterRoute(model.page, model.route, context))(model),
	})

// ROUTING

/** apps/web's `redirectToDashboard`: same-origin `redirect_url`, else `/`. */
const targetAfterSignIn = (route: AppRoute): string =>
	AppRoute.matchOrElse(
		route,
		{ SignIn: ({ search }) => validateInternalRedirect(search.redirect_url) ?? "/" },
		() => "/",
	)

/** Clerk's reverse redirects (`ClerkReverseRedirects` in `__root.tsx`): signed in, leave the auth pages. */
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
			if (isPublicRoute(model.route)) {
				return isClerkAuthEnabled ? clerkReverseRedirect(model.route, maybeOrgId) : Option.none()
			}
			return Option.isNone(maybeOrgId)
				? Option.some({
						url: hrefOf(AppRoute.OrgRequired({ search: { redirect_url: hrefOf(model.route) } })),
						isReplace: true,
					})
				: Option.none()
		},
	})

const followRedirects: Step = (model) => {
	const maybeRedirect = Session.match(model.session, {
		Resolving: () => Option.none<Redirect>(),
		SignedOut: () => Option.orElse(routeRedirect(model.route), () => sessionRedirect(model)),
		SignedIn: () => Option.orElse(routeRedirect(model.route), () => sessionRedirect(model)),
	})
	return Option.match(maybeRedirect, {
		onNone: () => ({ model }),
		onSome: ({ url, isReplace }) => ({
			model,
			commands: [isReplace ? ReplaceUrl({ url }) : NavigateInternal({ url })],
		}),
	})
}

/** Route-driven loads, shared by the cold load and every navigation: the shell boots on its first route. */
const loadRoute: Step = (model) =>
	Session.match(model.session, {
		Resolving: () => ({ model }),
		SignedOut: () => ({ model }),
		SignedIn: ({ maybeOrgId }) =>
			Option.isSome(maybeOrgId) && rendersShell(model.route)
				? foldShellStep(Shell.enter(maybeOrgId.value))(model)
				: { model },
	})

/** Everything that reads the route or the session. */
export const settle: Step = Update.combine([followRedirects, loadRoute, loadPage])

// SESSION

const signedIn =
	(maybeOrgId: Option.Option<OrgId>): Step =>
	(model) =>
		settle(modifyFields(model, { session: () => Session.SignedIn({ maybeOrgId }) }))

const signedOut: Step = (model) => settle(modifyFields(model, { session: () => Session.SignedOut() }))

/** `useClerkAuthSettled`: a signed-out first answer waits for a refreshing session, except on public pages. */
const appliedClerkSnapshot =
	(snapshot: ClerkSnapshot, isFirstAnswer: boolean): Step =>
	(model) => {
		if (Option.isSome(snapshot.maybeUserId)) {
			return signedIn(snapshot.maybeOrgId)(model)
		}
		if (model.session._tag !== "Resolving") {
			return signedOut(model)
		}
		if (!isFirstAnswer) {
			return { model }
		}
		return isPublicRoute(model.route) ? signedOut(model) : { model, commands: [WaitForAuthSettle()] }
	}

// UPDATE

export const update = (model: Model, message: Message) =>
	Message.match<UpdateReturn>(message, {
		ClickedLink: ({ request }) =>
			UrlRequest.match<UpdateReturn>(request, {
				Internal: ({ url }) => ({ model, commands: [NavigateInternal({ url: urlToString(url) })] }),
				External: ({ href }) => ({ model, commands: [LoadExternal({ href })] }),
			}),
		ChangedUrl: ({ url }) => {
			const nextRoute = urlToAppRoute(url)
			const isEnteringSignIn = Transition.isEntering(Transition.make(model.route, nextRoute), "SignIn")
			const routed = modifyFields(model, {
				route: () => nextRoute,
				signIn: (signIn) => (isEnteringSignIn ? SignIn.init() : signIn),
			})
			return Update.combine([foldShellStep(Shell.routeChanged), settle])(routed)
		},
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
		ChangedClerkSession: ({ snapshot }) => appliedClerkSnapshot(snapshot, false)(model),
		CompletedWaitForAuthSettle: () => (model.session._tag === "Resolving" ? signedOut(model) : { model }),
		CompletedMountClerkSignIn: () => ({ model }),
		FailedMountClerkSignIn: () => ({ model }),
		GotSignInMessage: ({ message }) => foldSignIn(model, message),
		GotShellMessage: ({ message }) => foldShell(model, message),
		GotToastMessage: ({ message }) =>
			message._tag === "ClickedToastAction" && model.toastActions[message.toastId] !== undefined
				? toPage(model, model.toastActions[message.toastId])
				: foldToasts(model, message),
		GotPageMessage: ({ message }) => toPage(model, message),
	})

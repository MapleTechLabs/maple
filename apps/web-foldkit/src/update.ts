import type { OrgId } from "@maple/domain"
import { isClerkAuthEnabled } from "@maple/web/lib/services/common/auth-mode"
import { validateInternalRedirect } from "@maple/ui/lib/sanitizers"
import { Option } from "effect"
import { Update } from "foldkit"
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
	// Pages are placeholders, so nothing rebuilds under a new namespace pin yet.
	foldOutMessage: Shell.OutMessage.match<Step>({ ChangedGlobalNamespace: () => (model) => ({ model }) }),
}

const foldShell = Update.foldChild({ update: Shell.update, ...shellFoldConfig })

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
export const settle: Step = Update.combine([followRedirects, loadRoute])

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
		GotToastMessage: ({ message }) => foldToasts(model, message),
	})

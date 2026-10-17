import { isClerkAuthEnabled } from "@maple/web/lib/services/common/auth-mode"
import { validateInternalRedirect } from "@maple/ui/lib/sanitizers"
import { Option } from "effect"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import { bootSplash } from "./layout/boot-splash"
import { Message } from "./message"
import { type Model, Session } from "./model"
import * as ClerkSignIn from "./page/clerk-sign-in"
import * as Home from "./page/home"
import * as SignIn from "./page/sign-in"
import { AppRoute, isPublicRoute } from "./route"

/** Placeholder for a route that is not ported yet: its tag and the session's org. */
const placeholder = (model: Model, h: HtmlBuilder<Message>, children: ReadonlyArray<Html>): Html =>
	h.main(
		[h.Class("flex min-h-screen flex-col gap-2 bg-background p-8 text-foreground")],
		[
			h.h1([h.Class("font-display text-xl font-semibold")], [model.route._tag]),
			h.p(
				[h.Class("font-mono text-muted-foreground text-xs")],
				[
					Session.match(model.session, {
						Resolving: () => "Session resolving",
						SignedOut: () => "Signed out",
						SignedIn: ({ maybeOrgId }) => `Signed in to ${Option.getOrElse(maybeOrgId, () => "no organization")}`,
					}),
				],
			),
			...children,
		],
	)

const signInView = (model: Model, h: HtmlBuilder<Message>, redirectUrl: string | undefined): Html =>
	isClerkAuthEnabled
		? ClerkSignIn.view(h, Option.fromNullishOr(validateInternalRedirect(redirectUrl)))
		: h.submodel({
				slotId: "sign-in",
				model: model.signIn,
				view: SignIn.view,
				toParentMessage: (message) => Message.GotSignInMessage({ message }),
			})

const routeView = (model: Model, h: HtmlBuilder<Message>): Html =>
	AppRoute.matchOrElse<Html>(
		model.route,
		{
			SignIn: ({ search }) => signInView(model, h, search.redirect_url),
			Home: () =>
				placeholder(model, h, [
					h.submodel({
						slotId: "home",
						model: model.home,
						view: Home.view,
						toParentMessage: (message) => Message.GotHomeMessage({ message }),
					}),
				]),
		},
		() => placeholder(model, h, []),
	)

/** A protected route while signed out renders nothing: the redirect to `/sign-in` is in flight. */
const content = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
	Session.match(model.session, {
		Resolving: () => [bootSplash(h)],
		SignedOut: () => (isPublicRoute(model.route) ? [routeView(model, h)] : []),
		SignedIn: () => [routeView(model, h)],
	})

const body = (model: Model, h: HtmlBuilder<Message>): Html => h.div([h.Id("app")], content(model, h))

// NOTE: Foldkit's first render replaces the container, so the view root is `div#app` itself.
export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
	title: "Maple",
	body: body(model, h),
})

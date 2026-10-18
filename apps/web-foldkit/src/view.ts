import { isClerkAuthEnabled } from "@maple/web/lib/services/common/auth-mode"
import { validateInternalRedirect } from "@maple/ui/lib/sanitizers"
import { Option } from "effect"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import { bootSplash } from "./layout/boot-splash"
import { Message } from "./message"
import { type Model, Session } from "./model"
import { pageContextOf } from "./update"
import * as ClerkSignIn from "./page/clerk-sign-in"
import { breadcrumbsOf, placeholderContent, rendersShell } from "./page/chrome"
import { type PageMessage, pageBreadcrumbs, viewPage, viewPageTopbarActions } from "./page/registry"
import * as SignIn from "./page/sign-in"
import { AppRoute, hrefOf, isPublicRoute } from "./route"
import * as Shell from "./shell"
import * as ChatSheet from "./page/chat/sheet"
import * as ToastView from "./ui/toast-view"

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
						SignedIn: ({ maybeOrgId }) =>
							`Signed in to ${Option.getOrElse(maybeOrgId, () => "no organization")}`,
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

const toShellMessage = (message: Shell.Message) => Message.GotShellMessage({ message })

const toPageMessage = (message: PageMessage) => Message.GotPageMessage({ message })

/** The routed page, or the placeholder while the route has no ported page. */
const pageView = (model: Model, h: HtmlBuilder<Message>): Html => {
	const maybeContext = pageContextOf(model)
	return model.page !== null && Option.isSome(maybeContext)
		? viewPage(h, model.page, { context: maybeContext.value }, toPageMessage)
		: placeholderContent(h, model.route)
}

/** The routed page's own top-bar actions, if it has any. */
const topbarActionsView = (model: Model, h: HtmlBuilder<Message>): Html => {
	const maybeContext = pageContextOf(model)
	return model.page !== null && Option.isSome(maybeContext)
		? viewPageTopbarActions(h, model.page, { context: maybeContext.value }, toPageMessage)
		: h.empty
}

/** A signed-in page inside the shell: the frame around the page, then the shell's overlay layers. */
const shellRoute = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
	const currentPath = hrefOf(model.route).split("?")[0] ?? "/"
	return [
		h.submodel({
			slotId: "shell-frame",
			model: model.shell,
			view: Shell.frameView,
			toParentMessage: toShellMessage,
			viewInputs: {
				currentPath,
				breadcrumbs: model.page === null ? breadcrumbsOf(model.route) : pageBreadcrumbs(model.page),
				page: () => pageView(model, h),
				topbarActions: () => topbarActionsView(model, h),
			},
		}),
		...shellOverlays(model, h, currentPath),
	]
}

/** The shell's overlay layers (mobile nav sheet, open menu), after the frame. */
const shellOverlays = (model: Model, h: HtmlBuilder<Message>, currentPath: string): ReadonlyArray<Html> => [
	h.submodel({
		slotId: "shell-sheet",
		model: model.shell,
		view: Shell.sheetLayerView,
		toParentMessage: toShellMessage,
		viewInputs: { currentPath },
	}),
	h.submodel({
		slotId: "shell-menu",
		model: model.shell,
		view: Shell.menuLayerView,
		toParentMessage: toShellMessage,
		viewInputs: { currentPath },
	}),
	h.submodel({
		slotId: "chat-sheet",
		model: model.chatSheet,
		view: ChatSheet.view,
		toParentMessage: (message: ChatSheet.Message) => Message.GotChatSheetMessage({ message }),
		viewInputs: { timeZone: model.timeZone },
	}),
]

/** `/chat`: the shell's rail held collapsed around the page, no top bar (the page's own layout). */
const bareShellRoute = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
	const currentPath = hrefOf(model.route).split("?")[0] ?? "/"
	const maybeContext = pageContextOf(model)
	return [
		h.submodel({
			slotId: "shell-bare-frame",
			model: model.shell,
			view: Shell.bareFrameView,
			toParentMessage: toShellMessage,
			viewInputs: {
				currentPath,
				page: () =>
					model.page !== null && Option.isSome(maybeContext)
						? viewPage(h, model.page, { context: maybeContext.value }, toPageMessage)
						: h.empty,
			},
		}),
		...shellOverlays(model, h, currentPath),
	]
}

const routeView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
	AppRoute.matchOrElse<ReadonlyArray<Html>>(
		model.route,
		{
			SignIn: ({ search }) => [signInView(model, h, search.redirect_url)],
			Chat: () => bareShellRoute(model, h),
		},
		() => (rendersShell(model.route) ? shellRoute(model, h) : [placeholder(model, h, [])]),
	)

/** A protected route while signed out renders nothing: the redirect to `/sign-in` is in flight. */
const content = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
	Session.match(model.session, {
		Resolving: () => [bootSplash(h)],
		SignedOut: () => (isPublicRoute(model.route) ? routeView(model, h) : []),
		SignedIn: () => routeView(model, h),
	})

const body = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Id("app")],
		// The regions go first: their Mount moves them to <body>, and a later sibling as the
		// insertion point of a page's new nodes would no longer be a child of #app.
		[
			...ToastView.regions(h, model.toasts, (message) => Message.GotToastMessage({ message })),
			...content(model, h),
		],
	)

// NOTE: Foldkit's first render replaces the container, so the view root is `div#app` itself.
export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
	title: "Maple",
	body: body(model, h),
})

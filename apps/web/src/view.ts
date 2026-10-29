import { isClerkAuthEnabled } from "./lib/services/common/auth-mode"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import { createKeyedLazy, type Document, type Html, type HtmlBuilder } from "foldkit/html"
import { bootSplash } from "./layout/boot-splash"
import { Message } from "./message"
import { type Model, Session } from "./model"
import { onboardingInputsOf, pageContextOf, planGateOf, shellClerkOf } from "./update"
import * as OnboardingView from "./page/onboarding/view"
import {
	breadcrumbsOf,
	notFoundContent,
	pageCodeFailedContent,
	placeholderContent,
	rendersShell,
} from "./page/chrome"
import type { PageContext, ShellInfraSurfaces } from "./page/contract"
import {
	isBarePageRoute,
	type PageMessage,
	pageBreadcrumbs,
	pageSource,
	unloadedPageOf,
	viewPage,
	viewPageTopbarActions,
} from "./page/registry"
import * as SignIn from "./page/sign-in"
import { AppRoute, hrefOf, isPublicRoute } from "./route"
import * as Shell from "./shell"
import { resolveSourceLink, type SourceLink } from "./shell/source-link"
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

/** Self-hosted: the root password form. Clerk's sign-in is an onboarding screen. */
const signInView = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.submodel({
		slotId: "sign-in",
		model: model.signIn,
		view: SignIn.view,
		toParentMessage: (message) => Message.GotSignInMessage({ message }),
	})

const toShellMessage = (message: Shell.Message) => Message.GotShellMessage({ message })

const toPageMessage = (message: PageMessage) => Message.GotPageMessage({ message })

// One cache slot per position the page renders at: inside the shell, or alone.
type PagePosition = "shell" | "bare"
const lazyPage = createKeyedLazy()

const renderPage = (
	h: HtmlBuilder<Message>,
	page: NonNullable<Model["page"]>,
	orgId: PageContext["orgId"],
	pinnedNamespace: PageContext["pinnedNamespace"],
	timeZone: PageContext["timeZone"],
	presence: ShellInfraSurfaces["presence"] | undefined,
	isPresenceFailed: boolean | undefined,
	integrations: ShellInfraSurfaces["integrations"] | undefined,
	remembered: ShellInfraSurfaces["remembered"],
	isMobile: boolean,
	isBelowSm: boolean,
	isBelowLg: boolean,
): Html =>
	viewPage(
		h,
		page,
		{
			context: {
				orgId,
				pinnedNamespace,
				timeZone,
				...(presence === undefined || isPresenceFailed === undefined || integrations === undefined
					? undefined
					: { infra: { presence, isPresenceFailed, integrations, remembered } }),
			},
			isMobile,
			isBelowSm,
			isBelowLg,
		},
		toPageMessage,
	)

/**
 * The routed page, rebuilt only when its slot or an input it reads changes: a hovered link, a
 * toast or a shell menu re-renders the root, not the page. The context is rebuilt on every call,
 * so it is passed by field.
 */
const lazyPageView = (model: Model, h: HtmlBuilder<Message>, position: PagePosition): Option.Option<Html> =>
	Option.flatMap(Option.fromNullishOr(model.page), (page) =>
		Option.map(pageContextOf(model), ({ orgId, pinnedNamespace, timeZone, infra }) =>
			lazyPage(position, renderPage, [
				h,
				page,
				orgId,
				pinnedNamespace,
				timeZone,
				infra?.presence,
				infra?.isPresenceFailed,
				infra?.integrations,
				infra?.remembered,
				model.shell.isMobile,
				model.shell.isBelowSm,
				model.shell.isFilterCollapsed,
			]),
		),
	)

/** The route's page whose code failed to load, with why; a stale failure of another page is none. */
const failedPageCodeView = (model: Model, h: HtmlBuilder<Message>): Option.Option<Html> => {
	const { pageCode } = model
	return pageCode._tag === "Failed" && Option.contains(unloadedPageOf(model.route), pageCode.pageId)
		? Option.some(pageCodeFailedContent(h, pageCode.failure, Message.ClickedReloadPage()))
		: Option.none()
}

/** The routed page, the not-found body for an unknown path, or a skeleton while the page loads. */
const pageView = (model: Model, h: HtmlBuilder<Message>, position: PagePosition): Html =>
	Option.getOrElse(lazyPageView(model, h, position), () =>
		model.route._tag === "NotFound"
			? notFoundContent(h)
			: Option.getOrElse(failedPageCodeView(model, h), () => placeholderContent(h)),
	)

/** The routed page's own top-bar actions, if it has any. */
const topbarActionsView = (model: Model, h: HtmlBuilder<Message>): Html => {
	const maybeContext = pageContextOf(model)
	return model.page !== null && Option.isSome(maybeContext)
		? viewPageTopbarActions(
				h,
				model.page,
				{
					context: maybeContext.value,
					isMobile: model.shell.isMobile,
					isBelowSm: model.shell.isBelowSm,
					isBelowLg: model.shell.isFilterCollapsed,
				},
				toPageMessage,
			)
		: h.empty
}

/** The open page's source, once it names one. */
const sourceLinkOf = (model: Model): SourceLink | null => {
	const ref = model.page === null ? null : pageSource(model.page)
	return ref === null
		? null
		: resolveSourceLink(ref, Option.getOrNull(AsyncData.getData(model.shell.sources)))
}

/** A signed-in page inside the shell: the frame around the page, then the shell's overlay layers. */
const shellRoute = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
	const currentPath = hrefOf(model.route).split("?")[0] ?? "/"
	const clerk = shellClerkOf(model)
	return [
		h.submodel({
			slotId: "shell-frame",
			model: model.shell,
			view: Shell.frameView,
			toParentMessage: toShellMessage,
			viewInputs: {
				currentPath,
				clerk,
				breadcrumbs: model.page === null ? breadcrumbsOf(model.route) : pageBreadcrumbs(model.page),
				page: () => pageView(model, h, "shell"),
				topbarActions: () => topbarActionsView(model, h),
				sourceLink: sourceLinkOf(model),
			},
		}),
		...shellOverlays(model, h, currentPath, clerk),
	]
}

/** The shell's overlay layers (mobile nav sheet, open menu, palette, shortcuts), after the frame. */
const shellOverlays = (
	model: Model,
	h: HtmlBuilder<Message>,
	currentPath: string,
	clerk: ReturnType<typeof shellClerkOf>,
): ReadonlyArray<Html> => [
	h.submodel({
		slotId: "shell-sheet",
		model: model.shell,
		view: Shell.sheetLayerView,
		toParentMessage: toShellMessage,
		viewInputs: { currentPath, clerk },
	}),
	h.submodel({
		slotId: "shell-menu",
		model: model.shell,
		view: Shell.menuLayerView,
		toParentMessage: toShellMessage,
		viewInputs: { currentPath, clerk },
	}),
	h.submodel({
		slotId: "shell-palette",
		model: model.shell,
		view: Shell.paletteLayerView,
		toParentMessage: toShellMessage,
		viewInputs: { currentPath, clerk },
	}),
	h.submodel({
		slotId: "shell-shortcuts",
		model: model.shell,
		view: Shell.shortcutsLayerView,
		toParentMessage: toShellMessage,
		viewInputs: { currentPath, clerk },
	}),
]

/** An onboarding screen open for this route, outside the shell. */
const onboardingView = (model: Model, h: HtmlBuilder<Message>): Option.Option<Html> =>
	Option.flatMap(Option.fromNullishOr(model.onboarding), (onboarding) =>
		Option.map(onboardingInputsOf(model), (inputs) =>
			h.submodel({
				slotId: "onboarding",
				model: onboarding,
				view: OnboardingView.view,
				viewInputs: inputs,
				toParentMessage: (message) => Message.GotOnboardingMessage({ message }),
			}),
		),
	)

const routeView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
	AppRoute.matchOrElse<ReadonlyArray<Html>>(
		model.route,
		{
			SignIn: () =>
				isClerkAuthEnabled
					? Option.match(onboardingView(model, h), {
							onNone: () => [],
							onSome: (screen) => [screen],
						})
					: [signInView(model, h)],
		},
		() =>
			Option.match(onboardingView(model, h), {
				onSome: (screen) => [screen],
				onNone: () =>
					rendersShell(model.route)
						? shellRoute(model, h)
						: isBarePageRoute(model.route)
							? [pageView(model, h, "bare")]
							: [placeholder(model, h, [])],
			}),
	)

/** A protected route while signed out renders nothing: the redirect to `/sign-in` is in flight. */
const content = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
	Session.match(model.session, {
		Resolving: () => [bootSplash(h)],
		SignedOut: () => (isPublicRoute(model.route) ? routeView(model, h) : []),
		// `ClerkReverseRedirects` holds the app on the splash until the plan is known.
		// `WrongRegionScreen` (an onboarding screen) replaces every route.
		SignedIn: () =>
			Option.exists(planGateOf(model), (gate) => gate.isSplash)
				? [bootSplash(h)]
				: Option.exists(planGateOf(model), (gate) => gate.wrongRegion !== null)
					? Option.match(onboardingView(model, h), {
							onNone: () => [],
							onSome: (screen) => [screen],
						})
					: routeView(model, h),
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

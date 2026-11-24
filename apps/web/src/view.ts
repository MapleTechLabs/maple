import { isClerkAuthEnabled } from "./platform/auth-mode"
import { Array as Arr, Option, String as Str } from "effect"
import { AsyncData } from "foldkit"
import { createKeyedLazy, createLazy, type Document, type Html, type HtmlBuilder } from "foldkit/html"
import { bootSplash } from "./layout/boot-splash"
import { Message } from "./message"
import { type Model, Session } from "./model"
import { onboardingInputsOf, pageContextOf, planGateOf, shellClerkOf } from "./update"
import * as OnboardingView from "./page/onboarding/view"
import {
	breadcrumbsOf,
	documentTitleOf,
	notFoundContent,
	placeholderContent,
	rendersShell,
} from "./page/chrome"
import type { PageContext, ShellInfraSurfaces } from "./page/contract"
import {
	isBarePageRoute,
	type PageMessage,
	pageBreadcrumbs,
	pageSource,
	viewPage,
	viewPageTopbarActions,
} from "./page/registry"
import * as SignIn from "./page/sign-in"
import { AppRoute, hrefOf, isPublicRoute } from "./route"
import * as Shell from "./shell"
import { resolveSourceLink, type SourceLink } from "./shell/source-link"
import { stableValue } from "./page/kit/stable-slice"
import { heading } from "@maple/views/ui/heading"
import * as ToastView from "@maple/views/ui/toast-view"
import * as TooltipHost from "@maple/views/ui/tooltip-host"
import { typography } from "@maple/views/ui/typography"

/** Placeholder for a route that is not ported yet: its tag and the session's org. */
const placeholder = (model: Model, h: HtmlBuilder<Message>, children: ReadonlyArray<Html>): Html =>
	h.main(
		[h.Class("flex min-h-screen flex-col gap-2 bg-background p-8 text-foreground")],
		[
			heading(h, { level: 1, variant: "title" }, [model.route._tag]),
			typography(h, { size: "xs", tone: "muted", mono: true, as: "p" }, [
				Session.match(model.session, {
					Resolving: () => "Session resolving",
					SignedOut: () => "Signed out",
					SignedIn: ({ maybeOrgId }) =>
						`Signed in to ${Option.getOrElse(maybeOrgId, () => "no organization")}`,
				}),
			]),
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
	audience: PageContext["audience"],
	hasProfiling: PageContext["hasProfiling"],
	hasCloudSecurity: PageContext["hasCloudSecurity"],
	hasLlmEvals: PageContext["hasLlmEvals"],
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
				...(audience === undefined ? undefined : { audience }),
				...(hasProfiling === undefined ? undefined : { hasProfiling }),
				...(hasCloudSecurity === undefined ? undefined : { hasCloudSecurity }),
				...(hasLlmEvals === undefined ? undefined : { hasLlmEvals }),
			},
			isMobile,
			isBelowSm,
			isBelowLg,
		},
		toPageMessage,
	)

/** The open page's own top-bar actions, from the same inputs as `renderPage`. */
const renderTopbar = (
	h: HtmlBuilder<Message>,
	page: NonNullable<Model["page"]>,
	orgId: PageContext["orgId"],
	pinnedNamespace: PageContext["pinnedNamespace"],
	timeZone: PageContext["timeZone"],
	presence: ShellInfraSurfaces["presence"] | undefined,
	isPresenceFailed: boolean | undefined,
	integrations: ShellInfraSurfaces["integrations"] | undefined,
	remembered: ShellInfraSurfaces["remembered"],
	audience: PageContext["audience"],
	hasProfiling: PageContext["hasProfiling"],
	hasCloudSecurity: PageContext["hasCloudSecurity"],
	hasLlmEvals: PageContext["hasLlmEvals"],
	isMobile: boolean,
	isBelowSm: boolean,
	isBelowLg: boolean,
): Html =>
	viewPageTopbarActions(
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
				...(audience === undefined ? undefined : { audience }),
				...(hasProfiling === undefined ? undefined : { hasProfiling }),
				...(hasCloudSecurity === undefined ? undefined : { hasCloudSecurity }),
				...(hasLlmEvals === undefined ? undefined : { hasLlmEvals }),
			},
			isMobile,
			isBelowSm,
			isBelowLg,
		},
		toPageMessage,
	)

/** The page slot and its context by field: the context is rebuilt on every call, its fields are not. */
const pageArgsOf = (model: Model, h: HtmlBuilder<Message>) =>
	Option.flatMap(Option.fromNullishOr(model.page), (page) =>
		Option.map(
			pageContextOf(model),
			({
				orgId,
				pinnedNamespace,
				timeZone,
				infra,
				audience,
				hasProfiling,
				hasCloudSecurity,
				hasLlmEvals,
			}): Parameters<typeof renderPage> => [
				h,
				page,
				orgId,
				pinnedNamespace,
				timeZone,
				infra?.presence,
				infra?.isPresenceFailed,
				infra?.integrations,
				infra?.remembered,
				audience,
				hasProfiling,
				hasCloudSecurity,
				hasLlmEvals,
				model.shell.isMobile,
				model.shell.isBelowSm,
				model.shell.isFilterCollapsed,
			],
		),
	)

/**
 * The routed page, rebuilt only when its slot or an input it reads changes: a hovered link, a
 * toast or a shell menu re-renders the root, not the page.
 */
const lazyPageView = (model: Model, h: HtmlBuilder<Message>, position: PagePosition): Option.Option<Html> =>
	Option.map(pageArgsOf(model, h), (args) => lazyPage(position, renderPage, args))

/** The routed page, the not-found body for an unknown path, or a skeleton while the page loads. */
const pageView = (model: Model, h: HtmlBuilder<Message>, position: PagePosition): Html =>
	Option.getOrElse(lazyPageView(model, h, position), () =>
		model.route._tag === "NotFound" ? notFoundContent(h) : placeholderContent(h),
	)

const topbarSlot = createLazy()

/** The routed page's own top-bar actions, if it has any: the open page's, live even while held. */
const topbarActionsView = (model: Model, h: HtmlBuilder<Message>): Html =>
	Option.match(pageArgsOf(model, h), {
		onNone: () => h.empty,
		onSome: (args) => topbarSlot(renderTopbar, args),
	})

/** The open page's source, once it names one. */
const sourceLinkOf = (model: Model): SourceLink | null => {
	const page = model.page
	const ref = page === null ? null : pageSource(page)
	return ref === null
		? null
		: resolveSourceLink(ref, Option.getOrNull(AsyncData.getData(model.shell.sources)))
}

// Derived shell inputs rebuilt on every call, kept by reference while equal so the slots below hit.
const stableClerk = stableValue(shellClerkOf)
const stableBreadcrumbs = stableValue((model: Model) =>
	model.page === null ? breadcrumbsOf(model.route) : pageBreadcrumbs(model.page),
)
const stableSourceLink = stableValue(sourceLinkOf)

const frame = (
	h: HtmlBuilder<Message>,
	shell: Model["shell"],
	currentPath: string,
	clerk: ReturnType<typeof shellClerkOf>,
	breadcrumbs: ReadonlyArray<Shell.BreadcrumbEntry>,
	page: Html,
	topbarActions: Html,
	sourceLink: SourceLink | null,
): Html =>
	h.submodel({
		slotId: "shell-frame",
		model: shell,
		view: Shell.frameView,
		toParentMessage: toShellMessage,
		viewInputs: {
			currentPath,
			clerk,
			breadcrumbs,
			page: () => page,
			topbarActions: () => topbarActions,
			sourceLink,
		},
	})

// Root-only messages (a hovered link, a preload timer, the session range) leave the shell model and
// these inputs alone, so the frame and its overlays keep their trees.
const frameSlot = createLazy()

/** A signed-in page inside the shell: the frame around the page, then the shell's overlay layers. */
const shellRoute = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
	const currentPath = Str.split("?")(hrefOf(model.route))[0] ?? "/"
	const clerk = stableClerk(model)
	return [
		frameSlot(frame, [
			h,
			model.shell,
			currentPath,
			clerk,
			stableBreadcrumbs(model),
			pageView(model, h, "shell"),
			topbarActionsView(model, h),
			stableSourceLink(model),
		]),
		...shellOverlays(h, model.shell, currentPath, clerk),
	]
}

/** One shell overlay layer (mobile nav sheet, open menu, palette or shortcuts). */
const overlay = (
	h: HtmlBuilder<Message>,
	slotId: string,
	view: typeof Shell.sheetLayerView,
	shell: Model["shell"],
	currentPath: string,
	clerk: ReturnType<typeof shellClerkOf>,
): Html =>
	h.submodel({
		slotId,
		model: shell,
		view,
		toParentMessage: toShellMessage,
		viewInputs: { currentPath, clerk },
	})

const OVERLAYS = [
	{ slotId: "shell-sheet", view: Shell.sheetLayerView, slot: createLazy() },
	{ slotId: "shell-menu", view: Shell.menuLayerView, slot: createLazy() },
	{ slotId: "shell-palette", view: Shell.paletteLayerView, slot: createLazy() },
	{ slotId: "shell-shortcuts", view: Shell.shortcutsLayerView, slot: createLazy() },
] as const

/** The shell's overlay layers, after the frame. */
const shellOverlays = (
	h: HtmlBuilder<Message>,
	shell: Model["shell"],
	currentPath: string,
	clerk: ReturnType<typeof shellClerkOf>,
): ReadonlyArray<Html> =>
	Arr.map(OVERLAYS, ({ slotId, view, slot }) => slot(overlay, [h, slotId, view, shell, currentPath, clerk]))

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
						: isBarePageRoute(model.route) && model.page !== null
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
			TooltipHost.view(h, model.tooltip, (message) => Message.GotTooltipMessage({ message })),
			...content(model, h),
		],
	)

/** The tab names the open page; a route with no page up yet (or none at all) is just "Maple". */
export const titleOf = (model: Model): string =>
	documentTitleOf(
		model.page !== null
			? pageBreadcrumbs(model.page)
			: AppRoute.matchOrElse<ReadonlyArray<Shell.BreadcrumbEntry>>(
					model.route,
					{ NotFound: () => breadcrumbsOf(model.route) },
					() => [],
				),
	)

// NOTE: Foldkit's first render replaces the container, so the view root is `div#app` itself.
export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
	title: titleOf(model),
	body: body(model, h),
})

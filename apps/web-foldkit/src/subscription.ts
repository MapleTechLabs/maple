import { isClerkAuthEnabled } from "@maple/web/lib/services/common/auth-mode"
import { Clock, Duration, Effect, Option, Schedule, Schema, Stream } from "effect"
import { Dom, Subscription } from "foldkit"
import { Message } from "./message"
import type { Resources } from "./platform/resources"
import type { Model } from "./model"
import { SELF_HOSTED_AUTH_EVENT } from "./platform/auth-api"
import { rendersShell } from "./page/chrome"
import * as Preload from "./page/preload"
import { pageSubscriptions } from "./page/registry"
import { pageContextOf } from "./update"
import { clerkSnapshots } from "./platform/clerk"
import * as Shell from "./shell"
import * as ChatSheet from "./page/chat/sheet"

/** Emits nothing: an Alt+click on a tri-state filter label is redirected to that row's Exclude button. */
const altClickExclude: Stream.Stream<Message> = Dom.streamFromEventFilterMap({
	target: () => document,
	type: "click",
	filterMapEvent: (event): Option.Option<Message> => {
		const label = event.target instanceof Element ? event.target.closest("label[data-alt-exclude]") : null
		const exclude = label?.parentElement?.querySelector("button[data-filter-exclude]")
		if (!event.altKey || !(exclude instanceof HTMLButtonElement)) return Option.none()
		event.preventDefault()
		exclude.click()
		return Option.none()
	},
})

const selfHostedAuthTarget: Dom.TypedEventTarget<{ [SELF_HOSTED_AUTH_EVENT]: Event }> = window

/** Every page's Subscriptions, lifted onto the root (`page/registry.ts`). */
const pages = Subscription.lift(pageSubscriptions)<Model, Message>({
	read: (model) => Option.some({ page: model.page, context: Option.getOrNull(pageContextOf(model)) }),
	toParentMessage: (message) => Message.GotPageMessage({ message }),
})

const root = Subscription.make<Model, Message, Resources>()((entry) => ({
	/** `subscribeSelfHostedAuthChanges`: a renewal elsewhere ended or replaced the session. */
	selfHostedSession: entry(
		{ isSelfHosted: Schema.Boolean },
		{
			modelToDependencies: () => ({ isSelfHosted: !isClerkAuthEnabled }),
			dependenciesToStream: ({ isSelfHosted }) =>
				Stream.when(
					Dom.streamFromEvent({
						target: selfHostedAuthTarget,
						type: SELF_HOSTED_AUTH_EVENT,
						mapEvent: () => Message.ChangedSelfHostedSession(),
					}),
					Effect.sync(() => isSelfHosted),
				),
		},
	),
	/** `useLiveClock({ intervalMs: 1000 })`: the reward pill's countdown, while one is shown. */
	checklistClock: entry(
		{ isCounting: Schema.Boolean },
		{
			modelToDependencies: (model) => ({ isCounting: Shell.isChecklistCounting(model.shell) }),
			dependenciesToStream: ({ isCounting }) =>
				Stream.when(
					Stream.fromSchedule(Schedule.spaced(Duration.seconds(1))).pipe(
						Stream.mapEffect(() => Clock.currentTimeMillis),
						Stream.map((nowMs) =>
							Message.GotShellMessage({ message: Shell.checklistTicked(nowMs) }),
						),
					),
					Effect.sync(() => isCounting),
				),
		},
	),
	/** `useIsMobile` for the shell: the sidebar turns into a sheet below `md`. */
	shellViewport: entry(
		{},
		{
			modelToDependencies: () => ({}),
			dependenciesToStream: () =>
				Stream.map(Shell.viewportChanges, (message) => Message.GotShellMessage({ message })),
		},
	),
	/** ⌘B / Ctrl+B toggles the sidebar while a shell page is open (`SidebarProvider`). */
	shellSidebarShortcut: entry(
		{ isShellOpen: Schema.Boolean },
		{
			modelToDependencies: (model) => ({
				isShellOpen: model.session._tag === "SignedIn" && rendersShell(model.route),
			}),
			dependenciesToStream: ({ isShellOpen }) =>
				Stream.when(
					Stream.map(Shell.sidebarShortcut, (message) => Message.GotShellMessage({ message })),
					Effect.sync(() => isShellOpen),
				),
		},
	),
	/** `useDashboardsRead` for the Pinned group: the org's live `dashboards` collection. */
	shellDashboards: entry(
		{ orgId: Schema.NullOr(Schema.String) },
		{
			modelToDependencies: (model) => ({
				orgId:
					model.session._tag === "SignedIn" && rendersShell(model.route)
						? Option.getOrNull(model.shell.maybeOrgId)
						: null,
			}),
			dependenciesToStream: ({ orgId }) =>
				orgId === null
					? Stream.empty
					: Shell.pinnedDashboardRows(orgId, (dashboards) =>
							Message.GotShellMessage({
								message: Shell.Message.SucceededLoadDashboards({ orgId, dashboards }),
							}),
						),
		},
	),
	/** The dashboards list starred or unstarred one (`dashboardFavoritesAtom`). */
	shellDashboardFavorites: entry(
		{},
		{
			modelToDependencies: () => ({}),
			dependenciesToStream: () =>
				Stream.map(Shell.favoritesChanges, (message) => Message.GotShellMessage({ message })),
		},
	),
	/** `useAppVersionChanged`: only for a build that knows its commit, until it is known stale. */
	shellVersionPoll: entry(
		{ isPolling: Schema.Boolean },
		{
			modelToDependencies: (model) => ({
				isPolling:
					Shell.BUILT_COMMIT.length > 0 &&
					!model.shell.isAppOutdated &&
					model.session._tag === "SignedIn",
			}),
			dependenciesToStream: ({ isPolling }) =>
				Stream.when(
					Stream.map(Shell.versionChecks, (message) => Message.GotShellMessage({ message })),
					Effect.sync(() => isPolling),
				),
		},
	),
	/** `defaultPreload: "intent"`: link hover, focus and touch, while a shell page is open. */
	linkIntent: entry(
		{ isShellOpen: Schema.Boolean },
		{
			modelToDependencies: (model) => ({
				isShellOpen: model.session._tag === "SignedIn" && rendersShell(model.route),
			}),
			dependenciesToStream: ({ isShellOpen }) =>
				Stream.when(
					Stream.map(Preload.linkIntents, (intent) =>
						intent._tag === "Intended"
							? Message.IntendedLink({ href: intent.href, isImmediate: intent.isImmediate })
							: Message.EndedLinkIntent({ href: intent.href }),
					),
					Effect.sync(() => isShellOpen),
				),
		},
	),
	/** Alt+click on a filter label excludes the value (`filter-section.ts`): it presses the row's Exclude. */
	altClickExclude: entry(
		{},
		{
			modelToDependencies: () => ({}),
			dependenciesToStream: () => altClickExclude,
		},
	),
	/** Clerk's listener (what `useAuth()` re-renders on), once clerk-js has loaded. */
	clerkSession: entry(
		{ isClerkLoaded: Schema.Boolean },
		{
			modelToDependencies: (model) => ({ isClerkLoaded: model.clerk._tag === "Loaded" }),
			dependenciesToStream: ({ isClerkLoaded }) =>
				Stream.when(
					Stream.map(clerkSnapshots, (snapshot) => Message.ChangedClerkSession({ snapshot })),
					Effect.sync(() => isClerkLoaded),
				),
		},
	),
}))

/** The global chat sheet's open event, `C`, and its conversation's live tail. */
const chatSheet = Subscription.lift(ChatSheet.subscriptions)<Model, Message>({
	read: (model) =>
		Option.some({
			sheet: model.chatSheet,
			isSignedIn: model.session._tag === "SignedIn" && rendersShell(model.route),
			isTypeAnywhere:
				model.route._tag === "Chat" && (model.route.search.shared === undefined || model.route.search.shared === ""),
		}),
	toParentMessage: (message) => Message.GotChatSheetMessage({ message }),
})

export const subscriptions = Subscription.aggregate(root, pages, chatSheet)

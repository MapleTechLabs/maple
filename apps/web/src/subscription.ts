import { isClerkAuthEnabled } from "./lib/services/common/auth-mode"
import { Clock, Duration, Effect, Option, Schedule, Schema, Stream } from "effect"
import { Dom, Subscription } from "foldkit"
import { Message } from "./message"
import type { Resources } from "./platform/resources"
import type { Model } from "./model"
import { SELF_HOSTED_AUTH_EVENT } from "./platform/auth-api"
import { readEffectiveTimeZone, TIME_ZONE_PREFERENCE_EVENT, TIMEZONE_STORAGE_KEY } from "./platform/time-zone"
import { rendersShell } from "./page/chrome"
import * as Preload from "./page/preload"
import { pageSubscriptions } from "./page/registry"
import * as TimeRangePicker from "./page/kit/time-range-picker"
import { onboardingInputsOf, pageContextOf } from "./update"
import * as Onboarding from "./page/onboarding"
import { connectSubscriptions } from "./page/onboarding/quick-start-connect"
import * as SourcesFlow from "./page/sources/new/embed"
import { clerkSnapshots } from "./platform/clerk"
import * as Shell from "./shell"
import * as ChatSheet from "./page/chat/sheet"
import { hrefOf } from "./route"
import { pollTicks } from "./data/poll"
import { collectionLoadFailed } from "./page/alerts/shared/collection-load"

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

const timeZoneTarget: Dom.TypedEventTarget<{ [TIME_ZONE_PREFERENCE_EVENT]: Event; storage: StorageEvent }> = window

/** `useTimezonePreference`: this tab's pick, or another tab's `storage` write of the key. */
export const timeZonePreferenceChanges: Stream.Stream<Message> = Stream.merge(
	Dom.streamFromEvent({ target: timeZoneTarget, type: TIME_ZONE_PREFERENCE_EVENT, mapEvent: () => true }),
	Dom.streamFromEvent({
		target: timeZoneTarget,
		type: "storage",
		mapEvent: (event) => event.key === TIMEZONE_STORAGE_KEY,
	}),
).pipe(
	Stream.filter((isPreference) => isPreference),
	Stream.mapEffect(() => readEffectiveTimeZone),
	Stream.map((timeZone) => Message.ChangedTimeZonePreference({ timeZone })),
)

/** Every page's Subscriptions, lifted onto the root (`page/registry.ts`). */
const pages = Subscription.lift(pageSubscriptions)<Model, Message>({
	read: (model) => Option.some({ page: model.page, context: Option.getOrNull(pageContextOf(model)) }),
	toParentMessage: (message) => Message.GotPageMessage({ message }),
})

/** The org whose `dashboards` the shell reads: once the sidebar or palette wants them. */
const shellDashboardsOrgId = (model: Model): string | null =>
	model.session._tag === "SignedIn" && rendersShell(model.route) && (model.shell.hasRequestedSidebarData || model.shell.palette !== null)
		? Option.getOrNull(model.shell.maybeOrgId)
		: null

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
	/** `useIntervalRefresh(refresh, { intervalMs: 15000 })`: the Connect panel's poll, paused while hidden or offline. */
	connectPoll: entry(
		{ isPolling: Schema.Boolean },
		{
			modelToDependencies: (model) => ({ isPolling: Shell.isConnectPolling(model.shell) }),
			dependenciesToStream: ({ isPolling }) =>
				Stream.when(
					Stream.map(pollTicks(Duration.seconds(15)), () =>
						Message.GotShellMessage({ message: Shell.connectPollTicked() }),
					),
					Effect.sync(() => isPolling),
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
	/** `PageLayout`'s `max-lg` query: the page rails turn into sheets below `lg`. */
	shellFilterViewport: entry(
		{},
		{
			modelToDependencies: () => ({}),
			dependenciesToStream: () =>
				Stream.map(Shell.filterViewportChanges, (message) => Message.GotShellMessage({ message })),
		},
	),
	shellSmallViewport: entry(
		{},
		{
			modelToDependencies: () => ({}),
			dependenciesToStream: () =>
				Stream.map(Shell.smallViewportChanges, (message) => Message.GotShellMessage({ message })),
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
	/** `GlobalShortcuts`: Mod+K, `?`, `T` and `/` while a shell page is open. */
	shellGlobalShortcuts: entry(
		{ isShellOpen: Schema.Boolean },
		{
			modelToDependencies: (model) => ({
				isShellOpen: model.session._tag === "SignedIn" && rendersShell(model.route),
			}),
			dependenciesToStream: ({ isShellOpen }) =>
				Stream.when(
					Stream.map(Shell.globalShortcuts, (message) => Message.GotShellMessage({ message })),
					Effect.sync(() => isShellOpen),
				),
		},
	),
	/** `useDashboardsRead` for the Pinned group: the org's live `dashboards` collection. */
	shellDashboards: entry(
		{ orgId: Schema.NullOr(Schema.String) },
		{
			modelToDependencies: (model) => ({ orgId: shellDashboardsOrgId(model) }),
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
	/** `useCollectionLoadFailed` while the Pinned group waits on its first `dashboards` answer. */
	shellDashboardsLoad: entry(
		{ orgId: Schema.NullOr(Schema.String) },
		{
			modelToDependencies: (model) => ({
				orgId:
					model.shell.dashboards._tag === "Idle" || model.shell.dashboards._tag === "Loading"
						? shellDashboardsOrgId(model)
						: null,
			}),
			dependenciesToStream: ({ orgId }) =>
				orgId === null
					? Stream.empty
					: collectionLoadFailed(`dashboards:${orgId}`, () =>
							Message.GotShellMessage({ message: Shell.Message.FailedLoadDashboards({ orgId }) }),
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
	/** The zone preference changed here or in another tab. */
	timeZonePreference: entry(
		{},
		{
			modelToDependencies: () => ({}),
			dependenciesToStream: () => timeZonePreferenceChanges,
		},
	),
	/** "D" opens the page-level time range picker (`useAppHotkey("time.open")`). */
	timeRangeHotkey: entry(
		{},
		{
			modelToDependencies: () => ({}),
			dependenciesToStream: () => TimeRangePicker.openOnHotkey<Message>(),
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
			pathname: hrefOf(model.route).split("?")[0] ?? "/",
		}),
	toParentMessage: (message) => Message.GotChatSheetMessage({ message }),
})

/** Onboarding's connect drawer: its flow's OAuth popup and polls, only while it is open. */
const onboardingConnectFlow = Subscription.lift(SourcesFlow.subscriptions)<Model, Message>({
	read: (model) =>
		Option.flatMap(Option.fromNullishOr(model.onboarding), (onboarding) =>
			Option.flatMap(onboardingInputsOf(model), (inputs) => Onboarding.connectFlowOf(onboarding, inputs)),
		),
	toParentMessage: (message) => Message.GotOnboardingMessage({ message: Onboarding.fromConnectFlow(message) }),
})

/** Onboarding's connect step: what is arriving, re-read while it shows. */
const onboardingConnectPoll = Subscription.lift(connectSubscriptions)<Model, Message>({
	read: (model) => Option.flatMap(Option.fromNullishOr(model.onboarding), Onboarding.connectPollOf),
	toParentMessage: (message) => Message.GotOnboardingMessage({ message: Onboarding.fromConnectPoll(message) }),
})

export const subscriptions = Subscription.aggregate(
	root,
	pages,
	chatSheet,
	onboardingConnectFlow,
	onboardingConnectPoll,
)

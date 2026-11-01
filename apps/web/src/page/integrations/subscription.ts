import { Duration, Effect, Option, Queue, Schema, Stream } from "effect"
import { AsyncData, Subscription } from "foldkit"
import { gcpConnectionState } from "../../components/integrations/gcp-connector-state"
import { ingestPhaseOf } from "../infra-integrations/cloudflare/ingest"
import type { Resources } from "../../platform/resources"
import type { PageSubscriptionInput } from "../contract"
import { integrationOfSearch } from "./catalog"
import { ConnectAttempt, ConnectProvider, currentReturnPath, PROVIDERS, startConnect } from "./connect"
import { Message } from "./message"
import { openerReturns, relayedReturns } from "./connect-returns"
import type { Model } from "./model"
import { unsyncedEnvironments } from "./railway"
import { githubStatusOf } from "./update-github"
import { isAwaitingFirstMetrics, isWatchExpired } from "./planetscale"
import { planetscaleStatusOf } from "./update-planetscale"
import { CAPABILITIES, CAPABILITY_IDS } from "./gcp-configure-copy"
import { runConfirmed } from "./gcp-configure-derive"
import { configureConnector } from "./update-gcp-configure"
import { backoffPollTicks, pollTicks, whenPresent } from "../../data/poll"

const one = (message: Message): Stream.Stream<Message> => Stream.make(message)

const POPUP_TICK_MS = 500
/** Ticks between polls: 3 s. */
const POLL_EVERY_TICKS = 6

/** The placeholder the popup shows until the authorize URL arrives. */
const interimDocument = (label: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Connecting to ${label}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size:13px;
    background:#fff; color:#3f3f46; }
  @media (prefers-color-scheme: dark) { body { background:#1c1917; color:#d6d3d1; } }
</style></head><body>Connecting to ${label}…</body></html>`

const openPopup = (name: string, features: string, label: string) =>
	Effect.sync(() => {
		const popup = window.open("", name, features)
		if (popup !== null) {
			popup.document.write(interimDocument(label))
			popup.document.close()
		}
		return popup
	})

/** Polls the popup until it closes: `PolledConnect` every 3 s (polling providers), then `Closed`. */

/**
 * The flow's 500 ms interval: every sixth tick polls (polling providers); `isClosed` ends it with
 * `Closed` once the popup is gone.
 */
const ticker = (attempt: number, polls: boolean, isClosed: () => boolean, graceMs: number | null) =>
	Stream.callback<Message>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const state = { ticks: 0 }
				const interval = setInterval(() => {
					state.ticks += 1
					if (polls && state.ticks % POLL_EVERY_TICKS === 0)
						Queue.offerUnsafe(queue, Message.PolledConnect({ attempt }))
					if (graceMs === null && isClosed()) {
						clearInterval(interval)
						Queue.offerUnsafe(queue, Message.ClosedConnectPopup({ attempt }))
					}
				}, POPUP_TICK_MS)
				const timeout =
					graceMs === null
						? undefined
						: setTimeout(
								() => Queue.offerUnsafe(queue, Message.EndedConnectGrace({ attempt })),
								graceMs,
							)
				return { interval, timeout }
			}),
			({ interval, timeout }) =>
				Effect.sync(() => {
					clearInterval(interval)
					if (timeout !== undefined) clearTimeout(timeout)
				}),
		).pipe(Effect.andThen(Effect.never)),
	)

const watchPopup = (popup: Window, attempt: number, polls: boolean) =>
	ticker(attempt, polls, () => popup.closed, null)

/** After the popup closed, a provider with a grace keeps polling until the grace ends. */
const grace = ({ provider, attempt }: ConnectAttempt) => {
	const spec = PROVIDERS[provider]
	return ticker(attempt, spec.polls, () => true, spec.closeGraceMs)
}

/** `useOAuthPopupFlow`'s `connect`: open in the click, start, then send the popup to the provider. */
const popupFlow = ({ provider, attempt }: ConnectAttempt) =>
	Stream.unwrap(
		Effect.gen(function* () {
			const spec = PROVIDERS[provider]
			const popup = yield* openPopup(spec.windowName, spec.windowFeatures, spec.label)
			const returnTo = yield* currentReturnPath
			const started = yield* Effect.result(startConnect(provider, returnTo))
			if (started._tag === "Failure") {
				yield* Effect.sync(() => popup?.close())
				return one(
					Message.FailedStartConnect({
						attempt,
						title: spec.startErrorTitle,
						description: started.failure.message,
					}),
				)
			}
			const url = started.success.redirectUrl
			const target = yield* Effect.sync(() => {
				if (popup !== null && !popup.closed) {
					popup.location.href = url
					return popup
				}
				return window.open(url, spec.windowName, spec.windowFeatures)
			})
			return target === null
				? one(Message.BlockedConnectPopup({ attempt }))
				: Stream.concat(
						one(Message.SucceededStartConnect({ attempt })),
						watchPopup(target, attempt, spec.polls),
					)
		}),
	)

/** After the popup closed, a provider with a grace keeps polling until it ends. */

const GITHUB_POLL_MS = 3_000
const FORCE_POLL_WINDOW_MS = 10_000

/** A status poll: paused while the tab is hidden or offline, one catch-up tick on return. */
const every = (millis: number, message: () => Message) =>
	Stream.map(pollTicks(Duration.millis(millis)), message)

const after = (millis: number, message: () => Message) =>
	Stream.callback<Message>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => setTimeout(() => Queue.offerUnsafe(queue, message()), millis)),
			(timeout) => Effect.sync(() => clearTimeout(timeout)),
		).pipe(Effect.andThen(Effect.never)),
	)

const CLOUDFLARE_INGEST_MS = 30_000

const SUPABASE_CLOCK_MS = 60_000
/** A metric stream delivers about every minute. */
const AWS_WATCH_MS = 60_000

const isSupabaseShown = (model: Model): boolean =>
	integrationOfSearch(model.search.integration) === "supabase" &&
	Option.match(AsyncData.getData(model.statuses.supabase.data), {
		onNone: () => false,
		onSome: (status) => status.connected,
	})

const isRailwaySettling = (model: Model): boolean => {
	if (integrationOfSearch(model.search.integration) !== "railway") return false
	const status = Option.getOrNull(AsyncData.getData(model.statuses.railway.data))
	return status !== null && status.connected && !status.authFailed && unsyncedEnvironments(status) > 0
}

/** A setup is open for a connection whose stack Maple has not assumed yet. */
const isAwsPending = (model: Model): boolean => {
	if (integrationOfSearch(model.search.integration) !== "aws") return false
	const status = Option.getOrNull(AsyncData.getData(model.statuses.aws.data))
	const setupId = model.awsCard.setupId
	return (
		status !== null &&
		setupId !== null &&
		status.connections.some((connection) => connection.id === setupId && connection.verified_at === null)
	)
}

/** A verified connection streams metrics: its deliveries and what they stored keep moving. */
const isAwsStreaming = (model: Model): boolean => {
	if (integrationOfSearch(model.search.integration) !== "aws") return false
	const status = Option.getOrNull(AsyncData.getData(model.statuses.aws.data))
	return (
		status !== null &&
		status.connections.some(
			(connection) => connection.verified_at !== null && connection.metric_stream !== null,
		)
	)
}

/** Polls at 5 s for the first 2 minutes, then every minute, until the watch runs out. */
const PLANETSCALE_FAST_POLLS = 24

const isWatchingPlanetscale = (model: Model): boolean => {
	if (integrationOfSearch(model.search.integration) !== "planetscale") return false
	return (
		isAwaitingFirstMetrics(planetscaleStatusOf(model), model.nowMs) &&
		!isWatchExpired(model.planetscaleCard, model.nowMs)
	)
}

const gcpRefreshInterval = (model: Model): number | null => {
	if (integrationOfSearch(model.search.integration) !== "gcp") return null
	const connectors = Option.match(AsyncData.getData(model.statuses.gcp.data), {
		onNone: () => [],
		onSome: (status) => status.connectors,
	})
	if (connectors.length === 0) return null
	const settling = connectors.some((connector) => gcpConnectionState(connector, model.nowMs) !== "healthy")
	return settling ? 10_000 : 60_000
}

/** The Set up step is open and Maple has not confirmed the run, or the first data. */
const isAwaitingRun = (model: Model): boolean => {
	const configure = model.gcpCard.configure
	if (configure === null || configure.opened === null) return false
	const connector = configureConnector(model, configure)
	if (connector === undefined) return false
	if (configure.method === "script") return !runConfirmed(connector, configure.opened, model.nowMs)
	// `MethodApplyStage`: until each capability's first data, or its removal, is confirmed.
	return CAPABILITY_IDS.some((capability) => {
		const applied =
			capability === "logs" ? connector.applied_logs_enabled : connector.applied_metrics_enabled
		return connector[CAPABILITIES[capability].flag] ? applied !== true : applied === true
	})
}

/** Prometheus and WarpStream share the scrape-target section. */
const isScrapePage = (model: Model): boolean => {
	const integration = integrationOfSearch(model.search.integration)
	return integration === "prometheus" || integration === "warpstream"
}

const isCloudflareSettling = (model: Model): boolean => {
	if (integrationOfSearch(model.search.integration) !== "cloudflare") return false
	const status = Option.getOrNull(AsyncData.getData(model.statuses.cloudflare.data))
	const usageData = model.cloudflareCard.usage.data
	const usage = AsyncData.isSuccess(usageData) || AsyncData.isRefreshing(usageData) ? usageData.data : null
	const phase = ingestPhaseOf(status, usage, model.nowMs)
	return phase !== null && phase.kind !== "live"
}

/** The popup (and its grace) is out, a branch change settles, or a repository is still syncing. */
const isGithubPolling = (model: Model): boolean => {
	if (integrationOfSearch(model.search.integration) !== "github") return false
	const status = githubStatusOf(model)
	const syncing =
		status?.connected === true &&
		status.repositories.some((repo) => repo.syncStatus === "pending" || repo.syncStatus === "backfilling")
	return model.connect.active !== null || model.githubCard.isForcePolling || syncing
}

/** The provider whose callback messages this page listens for (`useIntegrationMessage`). */
const listeningProvider = (model: Model): ConnectProvider | null => {
	const integration = integrationOfSearch(model.search.integration)
	return Schema.is(ConnectProvider)(integration) ? integration : null
}

const callbackMessages = (provider: ConnectProvider) =>
	Stream.map(openerReturns(provider), (callback) => Message.ReceivedConnectMessage(callback))

/** Every provider's status lives on this page, so every relayed return re-reads one. */
const relayMessages = Stream.map(relayedReturns, ({ provider, status, message }) =>
	Message.ReceivedConnectRelay({ provider, status, message: message ?? "" }),
)

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		connectPopup: entry(
			{ attempt: Schema.NullOr(ConnectAttempt), phase: Schema.Literals(["popup", "grace", "idle"]) },
			{
				modelToDependencies: ({ model }) => ({
					attempt: model.connect.active,
					phase:
						model.connect.active === null ? "idle" : model.connect.isClosed ? "grace" : "popup",
				}),
				dependenciesToStream: ({ attempt, phase }) =>
					attempt === null || phase === "idle"
						? Stream.empty
						: phase === "popup"
							? popupFlow(attempt)
							: grace(attempt),
			},
		),
		/** `useIntervalRefresh(refreshStatus, { intervalMs: 3_000, enabled: shouldPoll })` on the GitHub card. */
		githubPoll: entry(
			{ isPolling: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({ isPolling: isGithubPolling(model) }),
				dependenciesToStream: ({ isPolling }) =>
					isPolling ? every(GITHUB_POLL_MS, () => Message.TickedGithubPoll()) : Stream.empty,
			},
		),
		/**
		 * `FORCE_POLL_WINDOW_MS`: the poll after a branch change stops on its own, with one last read
		 * once the tab is back, so a window spent hidden or offline still lands the change.
		 */
		githubForcePoll: entry(
			{ version: Schema.NullOr(Schema.Number) },
			{
				modelToDependencies: ({ model }) => ({
					version: model.githubCard.isForcePolling ? model.githubCard.forcePollVersion : null,
				}),
				dependenciesToStream: ({ version }) =>
					version === null
						? Stream.empty
						: Stream.flatMap(
								after(FORCE_POLL_WINDOW_MS, () => Message.EndedGithubForcePoll({ version })),
								(ended) =>
									Stream.flatMap(whenPresent(), () =>
										Stream.make(Message.TickedGithubPoll(), ended),
									),
							),
			},
		),
		/** `useCloudflareIngestPhase`: status and usage every 30 s while a fresh connection settles. */
		cloudflareIngest: entry(
			{ isSettling: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({ isSettling: isCloudflareSettling(model) }),
				dependenciesToStream: ({ isSettling }) =>
					isSettling
						? every(CLOUDFLARE_INGEST_MS, () => Message.TickedCloudflareIngest())
						: Stream.empty,
			},
		),
		/** `ScrapeTargetsSection`: the list every 30 s; the selected target's checks every 10 s. */
		scrapeTargetsRefresh: entry(
			{ isShown: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({ isShown: isScrapePage(model) }),
				dependenciesToStream: ({ isShown }) =>
					isShown ? every(30_000, () => Message.TickedTargetsRefresh()) : Stream.empty,
			},
		),
		scrapeChecksRefresh: entry(
			{ selectedId: Schema.NullOr(Schema.String) },
			{
				modelToDependencies: ({ model }) => ({
					selectedId: isScrapePage(model) ? model.prometheusCard.selectedId : null,
				}),
				dependenciesToStream: ({ selectedId }) =>
					selectedId === null ? Stream.empty : every(10_000, () => Message.TickedChecksRefresh()),
			},
		),
		/** `useIntervalRefresh(refreshStatus, { intervalMs: 15_000, enabled: queued > 0 })`. */
		railwaySettle: entry(
			{ isSettling: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({ isSettling: isRailwaySettling(model) }),
				dependenciesToStream: ({ isSettling }) =>
					isSettling ? every(15_000, () => Message.TickedRailwaySettle()) : Stream.empty,
			},
		),
		awsPending: entry(
			{ isPending: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({ isPending: isAwsPending(model) }),
				dependenciesToStream: ({ isPending }) =>
					isPending ? every(10_000, () => Message.TickedAwsPending()) : Stream.empty,
			},
		),
		awsWatch: entry(
			{ isStreaming: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({ isStreaming: isAwsStreaming(model) }),
				dependenciesToStream: ({ isStreaming }) =>
					isStreaming ? every(AWS_WATCH_MS, () => Message.TickedAwsWatch()) : Stream.empty,
			},
		),
		/** The connected Supabase card's clock, so its metrics window and "Last data" ages advance. */
		supabaseClock: entry(
			{ isShown: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({ isShown: isSupabaseShown(model) }),
				dependenciesToStream: ({ isShown }) =>
					isShown ? every(SUPABASE_CLOCK_MS, () => Message.TickedSupabaseClock()) : Stream.empty,
			},
		),
		/** Watches for the first metrics; the card offers "Check again" once the watch runs out. */
		planetscaleWatch: entry(
			{ isWatching: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({ isWatching: isWatchingPlanetscale(model) }),
				dependenciesToStream: ({ isWatching }) =>
					isWatching
						? backoffPollTicks("5 seconds", PLANETSCALE_FAST_POLLS, "1 minute").pipe(
								Stream.map(() => Message.TickedPlanetscaleWatch()),
							)
						: Stream.empty,
			},
		),
		/** `useIntervalRefresh(refreshStatus, { intervalMs: settling ? 10_000 : 60_000 })` with the live clock. */
		gcpRefresh: entry(
			{ intervalMs: Schema.NullOr(Schema.Number) },
			{
				modelToDependencies: ({ model }) => ({ intervalMs: gcpRefreshInterval(model) }),
				dependenciesToStream: ({ intervalMs }) =>
					intervalMs === null ? Stream.empty : every(intervalMs, () => Message.TickedGcpRefresh()),
			},
		),
		/** `GcpDisconnectDialog`'s own `useIntervalRefresh(gcpStatus, 10_000)` while it is open. */
		gcpDisconnectRefresh: entry(
			{ isOpen: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({
					isOpen:
						model.gcpCard.disconnectDialog.isOpen &&
						model.gcpCard.disconnectDialog.kind === "dialog",
				}),
				dependenciesToStream: ({ isOpen }) =>
					isOpen ? every(10_000, () => Message.TickedGcpRefresh()) : Stream.empty,
			},
		),
		/** `ApplyStage`'s `useIntervalRefresh(gcpStatus, 10_000)` until the run is confirmed. */
		gcpApplyRefresh: entry(
			{ isWaiting: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({ isWaiting: isAwaitingRun(model) }),
				dependenciesToStream: ({ isWaiting }) =>
					isWaiting ? every(10_000, () => Message.TickedGcpRefresh()) : Stream.empty,
			},
		),
		connectCallback: entry(
			{ provider: Schema.NullOr(ConnectProvider) },
			{
				modelToDependencies: ({ model }) => ({ provider: listeningProvider(model) }),
				dependenciesToStream: ({ provider }) =>
					provider === null ? Stream.empty : callbackMessages(provider),
			},
		),
		connectRelay: entry(
			{},
			{
				modelToDependencies: () => ({}),
				dependenciesToStream: () => relayMessages,
			},
		),
	}),
)

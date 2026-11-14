import { Duration, Effect, Option, Queue, Record as Rec, Schema, Stream, Array as Arr } from "effect"
import { AsyncData, Subscription } from "foldkit"
import { gcpConnectionState } from "../infra-integrations/gcp/connector-state"
import type { Resources } from "../../platform/resources"
import type { PageSubscriptionInput } from "../contract"
import { integrationOfSearch } from "./catalog"
import { ConnectAttempt, ConnectProvider, currentReturnPath, PROVIDERS, startConnect } from "./connect"
import { Message } from "./message"
import { openerReturns, relayedReturns } from "./connect-returns"
import type { Model } from "./model"
import { type MountedProvider, PROVIDER_MODULES } from "./provider-modules"
import { githubStatusOf } from "./update-github"
import { CAPABILITIES, CAPABILITY_IDS } from "../infra-integrations/gcp/integration/gcp-configure-copy"
import { runConfirmed } from "../infra-integrations/gcp/integration/gcp-configure-derive"
import { configureConnector } from "../infra-integrations/gcp/integration/update-gcp-configure"
import { backoffPollTicks, pollTicks, whenPresent } from "../../data/poll"

/** The popup's document could not be written: it is already on the provider's cross-origin page. */
export class PopupDocumentError extends Schema.TaggedError<PopupDocumentError>()(
	"@maple/web/integrations/PopupDocumentError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

/** A Record entry with its key typed as a string. */
const keyed = <A>(key: string, value: A): readonly [string, A] => [key, value]

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

/**
 * A popup still open from an earlier click is reused by name; once it is on the provider's page it
 * is cross-origin and its document throws, so it keeps that page until it is sent to the new URL.
 */
const openPopup = (name: string, features: string, label: string) =>
	Effect.sync(() => window.open("", name, features)).pipe(
		Effect.tap((popup) =>
			popup === null
				? Effect.void
				: Effect.ignore(
						Effect.try({
							try: () => {
								// oxlint-disable-next-line typescript/no-deprecated -- fills a blank popup before it navigates; nothing else writes an about:blank document.
								popup.document.write(interimDocument(label))
								popup.document.close()
							},
							catch: (cause) =>
								new PopupDocumentError({
									message: "could not write the popup's placeholder",
									cause,
								}),
						}),
					),
		),
	)

/**
 * The flow's 500 ms interval: every sixth tick polls (polling providers); `isClosed` ends it with
 * `Closed` once the popup is gone.
 */
const ticker = (attempt: number, polls: boolean, isClosed: () => boolean, graceMs: number | null) =>
	Stream.callback<Message>((queue) =>
		Effect.gen(function* () {
			// One tick; `false` once the popup is gone, which ends the ticking.
			const tick = (ticks: number) =>
				Effect.sync(() => {
					if (polls && ticks % POLL_EVERY_TICKS === 0)
						Queue.offerUnsafe(queue, Message.PolledConnect({ attempt }))
					if (graceMs === null && isClosed()) {
						Queue.offerUnsafe(queue, Message.ClosedConnectPopup({ attempt }))
						return false
					}
					return true
				})
			const ticking = (ticks: number): Effect.Effect<void> =>
				Effect.flatMap(Effect.delay(tick(ticks), POPUP_TICK_MS), (isOpen) =>
					isOpen ? ticking(ticks + 1) : Effect.void,
				)
			yield* Effect.forkScoped(ticking(1))
			if (graceMs !== null)
				yield* Effect.forkScoped(
					Effect.delay(
						Effect.sync(() => Queue.offerUnsafe(queue, Message.EndedConnectGrace({ attempt }))),
						graceMs,
					),
				)
			return yield* Effect.never
		}),
	)

const watchPopup = (popup: Window, attempt: number, polls: boolean) =>
	ticker(attempt, polls, () => popup.closed, null)

/** After the popup closed, a provider with a grace keeps polling until the grace ends. */
const grace = ({ provider, attempt }: ConnectAttempt) => {
	const spec = PROVIDERS[provider]
	return ticker(attempt, spec.polls, () => true, spec.closeGraceMs)
}

/** Opens the popup in the click, starts, then sends the popup to the provider. */
const popupFlow = ({ provider, attempt, githubMode }: ConnectAttempt) =>
	Stream.unwrap(
		Effect.gen(function* () {
			const spec = PROVIDERS[provider]
			const popup = yield* openPopup(spec.windowName, spec.windowFeatures, spec.label)
			const returnTo = yield* currentReturnPath
			const started = yield* Effect.result(startConnect(provider, returnTo, githubMode))
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

const GITHUB_POLL_MS = 3_000
const FORCE_POLL_WINDOW_MS = 10_000

/** A status poll: paused while the tab is hidden or offline, one catch-up tick on return. */
const every = (millis: number, message: () => Message) =>
	Stream.map(pollTicks(Duration.millis(millis)), message)

/** A provider module's ticks while it is active: steady, or fast first then steady. */
export const tickerStream = (ticker: NonNullable<MountedProvider["ticker"]>): Stream.Stream<Message> =>
	ticker.fast === null
		? every(ticker.everyMs, () => ticker.tick)
		: backoffPollTicks(
				Duration.millis(ticker.fast.everyMs),
				ticker.fast.ticks,
				Duration.millis(ticker.everyMs),
			).pipe(Stream.map(() => ticker.tick))

const after = (millis: number, message: () => Message) =>
	Stream.fromEffect(Effect.delay(Effect.sync(message), Duration.millis(millis))).pipe(
		Stream.concat(Stream.never),
	)

/** A metric stream delivers about every minute. */
const AWS_WATCH_MS = 60_000

/** A setup is open for a connection whose stack Maple has not assumed yet. */
const isAwsPending = (model: Model): boolean => {
	if (integrationOfSearch(model.search.integration) !== "aws") return false
	const status = Option.getOrNull(AsyncData.getData(model.statuses.aws.data))
	const setupId = model.awsCard.setupId
	return (
		status !== null &&
		setupId !== null &&
		Arr.some(
			status.connections,
			(connection) => connection.id === setupId && connection.verified_at === null,
		)
	)
}

/** A verified connection streams metrics: its deliveries and what they stored keep moving. */
const isAwsStreaming = (model: Model): boolean => {
	if (integrationOfSearch(model.search.integration) !== "aws") return false
	const status = Option.getOrNull(AsyncData.getData(model.statuses.aws.data))
	return (
		status !== null &&
		Arr.some(
			status.connections,
			(connection) => connection.verified_at !== null && connection.metric_stream !== null,
		)
	)
}

const gcpRefreshInterval = (model: Model): number | null => {
	if (integrationOfSearch(model.search.integration) !== "gcp") return null
	const connectors = Option.match(AsyncData.getData(model.statuses.gcp.data), {
		onNone: () => [],
		onSome: (status) => status.connectors,
	})
	if (connectors.length === 0) return null
	const settling = Arr.some(
		connectors,
		(connector) => gcpConnectionState(connector, model.nowMs) !== "healthy",
	)
	return settling ? 10_000 : 60_000
}

/** The Set up step is open and Maple has not confirmed the run, or the first data. */
const isAwaitingRun = (model: Model): boolean => {
	const configure = model.gcpCard.configure
	if (configure === null || configure.opened === null) return false
	const connector = configureConnector(model, configure)
	if (connector === undefined) return false
	if (configure.method === "script") return !runConfirmed(connector, configure.opened, model.nowMs)
	// Until each capability's first data, or its removal, is confirmed.
	return Arr.some(CAPABILITY_IDS, (capability) => {
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

/** The popup is out, repository discovery is pending, or a repository is still syncing. */
const isGithubPolling = (model: Model): boolean => {
	if (integrationOfSearch(model.search.integration) !== "github") return false
	const status = githubStatusOf(model)
	const syncing =
		status?.connected === true &&
		status.repositoryDiscovery?._tag !== "Failed" &&
		Arr.some(
			status.repositories,
			(repo) => repo.syncStatus === "pending" || repo.syncStatus === "backfilling",
		)
	return (
		model.connect.active !== null ||
		model.githubCard.isForcePolling ||
		status?.repositoryDiscovery?._tag === "Pending" ||
		syncing
	)
}

/** The provider whose callback messages this page listens for. */
const listeningProvider = (model: Model): ConnectProvider | null => {
	const integration = integrationOfSearch(model.search.integration)
	return Schema.is(ConnectProvider)(integration) ? integration : null
}

const callbackMessages = (provider: ConnectProvider) =>
	Stream.map(openerReturns(provider), (callback) => Message.ReceivedConnectMessage(callback))

/** Every provider's status lives on this page, so every relayed return re-reads one. */
const relayMessages = Stream.map(relayedReturns, ({ provider, status, message, github }) => {
	const relay = { provider, status, message: message ?? "" }
	return Message.ReceivedConnectRelay(github === undefined ? relay : { ...relay, github })
})

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
		/** The scrape target list every 30 s; the selected target's checks every 10 s. */
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
		gcpRefresh: entry(
			{ intervalMs: Schema.NullOr(Schema.Number) },
			{
				modelToDependencies: ({ model }) => ({ intervalMs: gcpRefreshInterval(model) }),
				dependenciesToStream: ({ intervalMs }) =>
					intervalMs === null ? Stream.empty : every(intervalMs, () => Message.TickedGcpRefresh()),
			},
		),
		/** The Google Cloud status every 10 s while its disconnect dialog is open. */
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
		/** The Google Cloud status every 10 s until the run is confirmed. */
		gcpApplyRefresh: entry(
			{ isWaiting: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({ isWaiting: isAwaitingRun(model) }),
				dependenciesToStream: ({ isWaiting }) =>
					isWaiting ? every(10_000, () => Message.TickedGcpRefresh()) : Stream.empty,
			},
		),
		/** Each provider module's tick (Railway's first-sync poll, Supabase's card clock). */
		...Rec.fromEntries(
			Arr.flatMap(PROVIDER_MODULES, (provider) => {
				const ticker = provider.ticker
				return ticker === null
					? []
					: [
							keyed(
								`${provider.id}Tick`,
								entry(
									{ isActive: Schema.Boolean },
									{
										modelToDependencies: ({ model }) => ({
											isActive: ticker.isActive(model),
										}),
										dependenciesToStream: ({ isActive }) =>
											isActive ? tickerStream(ticker) : Stream.empty,
									},
								),
							),
						]
			}),
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

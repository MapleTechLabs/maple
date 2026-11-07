import { Clock, Effect, Option, Schema, Stream, Array as Arr, Record as Rec, String as Str } from "effect"
import * as SecureRandom from "effect/crypto/SecureRandom"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { ingestUrl } from "../../lib/services/common/ingest-url"
import { TEST_TRACE_SERVICE } from "../../lib/own-services"
import { AsyncData, Command, Subscription } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { baseKey } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { backoffPollTicks, type Presence } from "../../data/poll"
import { IntegrationStatuses } from "../../data/integration-statuses"
import { retrieveSetupKeys } from "../../data/ingest-keys"
import { STACK_PLATFORM_IDS, type StackPlatform } from "../../lib/onboarding-stack"
import type { Resources } from "../../platform/resources"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Tabs from "@maple/views/ui/tabs"
import { PACKAGE_TAB_VALUES, SETUP_TAB_VALUES } from "../kit/guided-setup"
import { loadSources, sourcesListKey } from "../sources/kit/data"
import { loadSignalPresences } from "../kit/signal-presence"
import { SignalPresenceData, SignalPresences } from "@maple/views/data/signal-presence"

// The connect step's state: the ingest key for the coding-agent prompt and SDK snippets, whether data
// is arriving, and which picked providers are already connected. All of it is re-read while the step shows.

/** Providers with an integration status of their own; every platform also counts its sources. */
const STATUS_PROVIDERS = ["cloudflare", "railway", "supabase", "planetscale"] as const
type StatusProvider = (typeof STATUS_PROVIDERS)[number]

const isStatusProvider = (platform: StackPlatform): platform is StatusProvider =>
	Arr.some(STATUS_PROVIDERS, (provider) => provider === platform)

const Keys = Schema.Union([
	Schema.TaggedStruct("Pending", {}),
	/** `privateKey` is null for a member: they read the public key only, which sends from servers too. */
	Schema.TaggedStruct("Ready", { privateKey: Schema.NullOr(Schema.String), publicKey: Schema.String }),
	/** Neither key could be read (the key store is down): the snippets show a placeholder. */
	Schema.TaggedStruct("Failed", {}),
])

/** The "Send test trace" button: one span posted from this page, before any app is wired up. */
export const TestTrace = Schema.Union([
	Schema.TaggedStruct("Idle", {}),
	Schema.TaggedStruct("Sending", {}),
	Schema.TaggedStruct("Sent", {}),
	/** `message` is what ingest answered, which names the other region for a key from there. */
	Schema.TaggedStruct("Failed", { message: Schema.String }),
])
export type TestTrace = typeof TestTrace.Type

export const Connect = Schema.Struct({
	keys: Keys,
	testTrace: TestTrace,
	presence: SignalPresenceData.schema,
	connected: Schema.Record(Schema.String, Schema.Boolean),
	/** True while the step shows; a poll that lands after it closes is dropped. */
	isActive: Schema.Boolean,
	setupTabs: Tabs.Model,
	packageTabs: Tabs.Model,
	snippetCopies: Schema.Record(Schema.String, CopyButton.Model),
})
export type Connect = typeof Connect.Type

export const ConnectMessage = defineMessageUnion({
	SucceededLoadKeys: { privateKey: Schema.NullOr(Schema.String), publicKey: Schema.String },
	FailedLoadKeys: {},
	LoadedPresence: { result: Schema.Result(SignalPresences, LoadFailure) },
	LoadedConnected: { connected: Schema.Record(Schema.String, Schema.Boolean) },
	ElapsedPoll: {},
	ClickedSendTestTrace: { apiKey: Schema.String },
	SucceededSendTestTrace: {},
	FailedSendTestTrace: { message: Schema.String },
	GotSetupTabsMessage: { message: Tabs.Message },
	GotPackageTabsMessage: { message: Tabs.Message },
	GotSnippetCopyMessage: { snippet: Schema.String, message: CopyButton.Message },
})
export type ConnectMessage = typeof ConnectMessage.Type

/** 5 s polls for ten minutes of setup, then 30 s ones, stopping after an hour of visible time. */
const FAST_POLLS = 120
const SLOW_POLLS = 100

export const initConnect = (): Connect => ({
	keys: { _tag: "Pending" },
	testTrace: { _tag: "Idle" },
	presence: AsyncData.Idle(),
	connected: {},
	isActive: false,
	setupTabs: Tabs.init({ idBase: 60, values: SETUP_TAB_VALUES, selected: "claude-code" }),
	packageTabs: Tabs.init({ idBase: 70, values: PACKAGE_TAB_VALUES, selected: "npm" }),
	snippetCopies: {},
})

const FetchConnectKeys = Command.define("FetchOnboardingConnectKeys", {
	messages: [ConnectMessage.SucceededLoadKeys, ConnectMessage.FailedLoadKeys],
	execute: retrieveSetupKeys.pipe(
		Effect.map((keys) => ConnectMessage.SucceededLoadKeys(keys)),
		Effect.orElseSucceed(() => ConnectMessage.FailedLoadKeys()),
	),
})

const hex = (bytes: Uint8Array): string =>
	Arr.join(
		Arr.map(Array.from(bytes), (byte) => Str.padStart(2, "0")(byte.toString(16))),
		"",
	)

const IngestFailure = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) })

const PartialSuccess = Schema.Struct({
	partialSuccess: Schema.Struct({
		rejectedSpans: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
		errorMessage: Schema.optionalKey(Schema.String),
	}),
})

/** One server span as OTLP/JSON, sent with the org's key the way an SDK would. */
export const SendTestTrace = Command.define("SendOnboardingTestTrace", {
	args: { apiKey: Schema.String },
	messages: [ConnectMessage.SucceededSendTestTrace, ConnectMessage.FailedSendTestTrace],
	execute: ({ apiKey }) =>
		Effect.gen(function* () {
			const random = yield* SecureRandom.SecureRandom
			const traceBytes = yield* random.randomBytes(16)
			const spanBytes = yield* random.randomBytes(8)
			const childBytes = yield* random.randomBytes(8)
			const traceId = hex(traceBytes)
			const spanId = hex(spanBytes)
			const childSpanId = hex(childBytes)
			const nowMs = yield* Clock.currentTimeMillis
			const client = yield* HttpClient.HttpClient
			// No `b3`/`traceparent`: ingest's CORS does not list `b3`, so the preflight would fail, and
			// the user's test trace has nothing to do with this page's own trace.
			const response = yield* Effect.provideService(
				HttpClient.TracerPropagationEnabled,
				false,
			)(
				client.execute(
					HttpClientRequest.post(`${ingestUrl}/v1/traces`).pipe(
						HttpClientRequest.bearerToken(apiKey),
						HttpClientRequest.bodyJsonUnsafe({
							resourceSpans: [
								{
									resource: {
										attributes: [
											{
												key: "service.name",
												value: { stringValue: TEST_TRACE_SERVICE },
											},
										],
									},
									scopeSpans: [
										{
											scope: { name: "maple-onboarding" },
											spans: [
												{
													traceId,
													spanId,
													name: "GET /test",
													kind: 2,
													startTimeUnixNano: `${nowMs - 120}000000`,
													endTimeUnixNano: `${nowMs}000000`,
													attributes: [
														{
															key: "http.request.method",
															value: { stringValue: "GET" },
														},
														{
															key: "http.route",
															value: { stringValue: "/test" },
														},
														{
															key: "http.response.status_code",
															value: { intValue: "200" },
														},
													],
													status: { code: 1 },
												},
												// A child span, so the Traces page's "hide single-span noise" default shows it.
												{
													traceId,
													spanId: childSpanId,
													parentSpanId: spanId,
													name: "SELECT orders",
													kind: 3,
													startTimeUnixNano: `${nowMs - 100}000000`,
													endTimeUnixNano: `${nowMs - 40}000000`,
													attributes: [
														{
															key: "db.system.name",
															value: { stringValue: "postgresql" },
														},
														{
															key: "db.operation.name",
															value: { stringValue: "SELECT" },
														},
														{
															key: "db.collection.name",
															value: { stringValue: "orders" },
														},
													],
													status: { code: 1 },
												},
											],
										},
									],
								},
							],
						}),
					),
				),
			)
			if (response.status >= 200 && response.status < 300) {
				// OTLP answers 200 with `partialSuccess` when it dropped spans.
				const partial = yield* Effect.option(
					HttpClientResponse.schemaBodyJson(PartialSuccess)(response),
				)
				return Option.match(
					Option.filter(partial, (body) => Number(body.partialSuccess.rejectedSpans ?? "0") > 0),
					{
						onNone: () => ConnectMessage.SucceededSendTestTrace(),
						onSome: (body) =>
							ConnectMessage.FailedSendTestTrace({
								message: body.partialSuccess.errorMessage ?? "Ingest dropped the test trace.",
							}),
					},
				)
			}
			const failure = yield* Effect.option(HttpClientResponse.schemaBodyJson(IngestFailure)(response))
			return ConnectMessage.FailedSendTestTrace({
				message: Option.match(failure, {
					onNone: () => `Ingest answered ${response.status}.`,
					onSome: (body) => body.error.message,
				}),
			})
		}).pipe(
			Effect.timeout("10 seconds"),
			Effect.orElseSucceed(() =>
				ConnectMessage.FailedSendTestTrace({ message: `Couldn't reach ${ingestUrl}.` }),
			),
		),
})

export const LoadConnectPresence = Command.define("LoadOnboardingConnectPresence", {
	args: { orgId: Schema.String },
	messages: [ConnectMessage.LoadedPresence],
	execute: ({ orgId }) =>
		Effect.map(loadSignalPresences(orgId), (result) => ConnectMessage.LoadedPresence({ result })),
})

/**
 * Each picked platform's `connected`, read fresh: its integration status where it has one, or any
 * source of its platform (a push source, an AWS account, a scrape target). A read that fails is left out.
 */
const LoadConnected = Command.define("LoadOnboardingConnectedProviders", {
	args: { orgId: Schema.String, platforms: Schema.Array(Schema.Literals(STACK_PLATFORM_IDS)) },
	messages: [ConnectMessage.LoadedConnected],
	execute: ({ orgId, platforms }) =>
		Effect.gen(function* () {
			const statuses = yield* IntegrationStatuses
			const options = { refresh: true, orgId }
			const connectedOf = <E>(status: Effect.Effect<{ readonly connected: boolean }, E>) =>
				Effect.option(Effect.map(status, (read) => read.connected))
			const read = (provider: StatusProvider): Effect.Effect<Option.Option<boolean>> =>
				provider === "cloudflare"
					? connectedOf(statuses.cloudflare(options))
					: provider === "railway"
						? connectedOf(statuses.railway(options))
						: provider === "supabase"
							? connectedOf(statuses.supabase(options))
							: connectedOf(statuses.planetscale(options))
			const [entries, maybeSources] = yield* Effect.all(
				[
					Effect.forEach(
						Arr.filter(platforms, isStatusProvider),
						(provider) =>
							Effect.map(
								read(provider),
								(isConnected): ReadonlyArray<readonly [string, boolean]> =>
									Option.match(isConnected, {
										onNone: () => [],
										onSome: (value) => [[provider, value]],
									}),
							),
						{ concurrency: "unbounded" },
					),
					loadSources(baseKey(sourcesListKey(orgId)), true).pipe(Effect.option),
				],
				{ concurrency: "unbounded" },
			)
			const byStatus: Readonly<Record<string, boolean>> = Rec.fromEntries(entries.flat())
			const connected = Rec.fromEntries(
				Arr.flatMap(platforms, (platform): ReadonlyArray<readonly [string, boolean]> => {
					const hasSource = Option.map(maybeSources, (sources) =>
						Arr.some(sources, (source) => source.platform === platform),
					)
					const status = byStatus[platform]
					return status === undefined && Option.isNone(hasSource)
						? []
						: [[platform, status === true || Option.getOrElse(hasSource, () => false)]]
				}),
			)
			return ConnectMessage.LoadedConnected({ connected })
		}),
})

type Step = Readonly<{
	connect: Connect
	commands: ReadonlyArray<Command.Command<ConnectMessage, never, Resources>>
}>

/** The drawer closed: the picked providers' connections, read once outside the poll. */
export const refreshConnected = (orgId: string, platforms: ReadonlyArray<StackPlatform>): Step["commands"] =>
	platforms.length === 0 ? [] : [LoadConnected({ orgId, platforms })]

const reads = (orgId: string, platforms: ReadonlyArray<StackPlatform>): Step["commands"] => [
	LoadConnectPresence({ orgId }),
	...refreshConnected(orgId, platforms),
]

/** The step opens: the key once, then presence and providers on a poll until it closes. */
export const openConnect = (
	connect: Connect,
	orgId: string,
	platforms: ReadonlyArray<StackPlatform>,
): Step => ({
	connect: { ...connect, isActive: true },
	commands: [...(connect.keys._tag === "Pending" ? [FetchConnectKeys()] : []), ...reads(orgId, platforms)],
})

export const closeConnect = (connect: Connect): Connect => ({ ...connect, isActive: false })

export const updateConnect = (
	connect: Connect,
	message: ConnectMessage,
	orgId: string,
	platforms: ReadonlyArray<StackPlatform>,
): Step =>
	ConnectMessage.match<Step>(message, {
		SucceededLoadKeys: ({ privateKey, publicKey }) => ({
			connect: { ...connect, keys: { _tag: "Ready", privateKey, publicKey } },
			commands: [],
		}),
		FailedLoadKeys: () => ({ connect: { ...connect, keys: { _tag: "Failed" } }, commands: [] }),
		LoadedPresence: ({ result }) => ({
			connect: { ...connect, presence: AsyncData.settle(connect.presence, result) },
			commands: [],
		}),
		// Connected stays connected for the visit: a list read before a fresh create cannot untick it.
		LoadedConnected: ({ connected }) => ({
			connect: {
				...connect,
				connected: Rec.fromEntries(
					Arr.map(
						Rec.toEntries({ ...connect.connected, ...connected }),
						([platform, isConnected]) => [
							platform,
							isConnected || connect.connected[platform] === true,
						],
					),
				),
			},
			commands: [],
		}),
		ElapsedPoll: () => ({ connect, commands: connect.isActive ? reads(orgId, platforms) : [] }),
		ClickedSendTestTrace: ({ apiKey }) =>
			connect.testTrace._tag === "Sending"
				? { connect, commands: [] }
				: {
						connect: { ...connect, testTrace: { _tag: "Sending" } },
						commands: [SendTestTrace({ apiKey })],
					},
		// Read at once rather than on the next tick, so the arrival shows as soon as it lands.
		SucceededSendTestTrace: () => ({
			connect: { ...connect, testTrace: { _tag: "Sent" } },
			commands: [LoadConnectPresence({ orgId })],
		}),
		FailedSendTestTrace: ({ message: failure }) => ({
			connect: { ...connect, testTrace: { _tag: "Failed", message: failure } },
			commands: [],
		}),
		GotSetupTabsMessage: ({ message: inner }) => {
			const next = Tabs.update(connect.setupTabs, inner)
			return {
				connect: { ...connect, setupTabs: next.model },
				commands: Command.mapMessages(next.commands, (child) =>
					ConnectMessage.GotSetupTabsMessage({ message: child }),
				),
			}
		},
		GotPackageTabsMessage: ({ message: inner }) => {
			const next = Tabs.update(connect.packageTabs, inner)
			return {
				connect: { ...connect, packageTabs: next.model },
				commands: Command.mapMessages(next.commands, (child) =>
					ConnectMessage.GotPackageTabsMessage({ message: child }),
				),
			}
		},
		GotSnippetCopyMessage: ({ snippet, message: inner }) => {
			const next = CopyButton.update(connect.snippetCopies[snippet] ?? CopyButton.init(), inner)
			return {
				connect: { ...connect, snippetCopies: { ...connect.snippetCopies, [snippet]: next.model } },
				commands: Command.mapMessages(next.commands ?? [], (child) =>
					ConnectMessage.GotSnippetCopyMessage({ snippet, message: child }),
				),
			}
		},
	})

/**
 * The poll's ticks while the step shows. A hidden or offline tab skips them and reads at once on
 * return; the step reopening (connect to live) keeps this one poll rather than starting another.
 */
export const connectPollTicks = (presence?: Presence): Stream.Stream<void> =>
	Stream.take(backoffPollTicks("5 seconds", FAST_POLLS, "30 seconds", presence), FAST_POLLS + SLOW_POLLS)

export const connectSubscriptions = Subscription.make<Connect, ConnectMessage>()((entry) => ({
	onboardingConnectPoll: entry(
		{ isActive: Schema.Boolean },
		{
			modelToDependencies: (connect) => ({ isActive: connect.isActive }),
			dependenciesToStream: ({ isActive }) =>
				isActive ? Stream.map(connectPollTicks(), () => ConnectMessage.ElapsedPoll()) : Stream.empty,
		},
	),
}))

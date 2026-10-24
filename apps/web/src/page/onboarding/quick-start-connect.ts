import { Duration, Effect, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../data/load-failure"
import { IntegrationStatuses } from "../../data/integration-statuses"
import type { StackPlatform } from "../../lib/onboarding-stack"
import { MapleApiV2Client } from "../../platform/api-clients"
import type { Resources } from "../../platform/resources"
import * as CopyButton from "../../ui/copy-button"
import * as Tabs from "../../ui/tabs"
import { PACKAGE_TAB_VALUES, SETUP_TAB_VALUES } from "../kit/guided-setup"
import { loadSignalPresences, SignalPresenceData, SignalPresences } from "../kit/signal-presence"

// The connect step's state: the ingest key for the coding-agent prompt and SDK snippets, whether data
// is arriving, and which picked providers are already connected. All of it is re-read while the step shows.

/** Providers whose connection Maple can read; the rest of the stack is set up on its own page. */
export const STATUS_PROVIDERS = ["cloudflare", "railway", "supabase", "planetscale"] as const
export type StatusProvider = (typeof STATUS_PROVIDERS)[number]

const isStatusProvider = (platform: StackPlatform): platform is StatusProvider =>
	STATUS_PROVIDERS.some((provider) => provider === platform)

const Keys = Schema.Union([
	Schema.TaggedStruct("Pending", {}),
	Schema.TaggedStruct("Ready", { privateKey: Schema.String }),
	/** The read failed (not an admin, or the key store is down): the prompt shows a placeholder. */
	Schema.TaggedStruct("Failed", {}),
])

export const Connect = Schema.Struct({
	keys: Keys,
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
	SucceededLoadKeys: { privateKey: Schema.String },
	FailedLoadKeys: {},
	LoadedPresence: { result: Schema.Result(SignalPresences, LoadFailure) },
	LoadedConnected: { connected: Schema.Record(Schema.String, Schema.Boolean) },
	ElapsedPoll: {},
	GotSetupTabsMessage: { message: Tabs.Message },
	GotPackageTabsMessage: { message: Tabs.Message },
	GotSnippetCopyMessage: { snippet: Schema.String, message: CopyButton.Message },
})
export type ConnectMessage = typeof ConnectMessage.Type

const POLL = Duration.seconds(5)

export const initConnect = (): Connect => ({
	keys: { _tag: "Pending" },
	presence: AsyncData.Idle(),
	connected: {},
	isActive: false,
	setupTabs: Tabs.init({ idBase: 60, values: SETUP_TAB_VALUES, selected: "claude-code" }),
	packageTabs: Tabs.init({ idBase: 70, values: PACKAGE_TAB_VALUES, selected: "npm" }),
	snippetCopies: {},
})

const FetchConnectKeys = Command.define("FetchOnboardingConnectKeys", {
	messages: [ConnectMessage.SucceededLoadKeys, ConnectMessage.FailedLoadKeys],
	execute: Effect.flatMap(MapleApiV2Client, (client) => client.ingestKeys.retrieve()).pipe(
		Effect.map((keys) => ConnectMessage.SucceededLoadKeys({ privateKey: keys.private_key })),
		Effect.orElseSucceed(() => ConnectMessage.FailedLoadKeys()),
	),
})

const LoadConnectPresence = Command.define("LoadOnboardingConnectPresence", {
	args: { orgId: Schema.String },
	messages: [ConnectMessage.LoadedPresence],
	execute: ({ orgId }) =>
		Effect.map(loadSignalPresences(orgId), (result) => ConnectMessage.LoadedPresence({ result })),
})

/** Each picked provider's `connected`, read fresh; one that fails to answer is left out. */
const LoadConnected = Command.define("LoadOnboardingConnectedProviders", {
	args: { orgId: Schema.String, providers: Schema.Array(Schema.Literals(STATUS_PROVIDERS)) },
	messages: [ConnectMessage.LoadedConnected],
	execute: ({ orgId, providers }) =>
		Effect.gen(function* () {
			const statuses = yield* IntegrationStatuses
			const options = { refresh: true, orgId }
			const read = (provider: StatusProvider): Effect.Effect<boolean, unknown> =>
				provider === "cloudflare"
					? Effect.map(statuses.cloudflare(options), (status) => status.connected)
					: provider === "railway"
						? Effect.map(statuses.railway(options), (status) => status.connected)
						: provider === "supabase"
							? Effect.map(statuses.supabase(options), (status) => status.connected)
							: Effect.map(statuses.planetscale(options), (status) => status.connected)
			const entries = yield* Effect.forEach(
				providers,
				(provider) =>
					read(provider).pipe(
						Effect.map(
							(
								isConnected,
							): ReadonlyArray<
								Readonly<{ provider: StatusProvider; isConnected: boolean }>
							> => [{ provider, isConnected }],
						),
						Effect.orElseSucceed(() => []),
					),
				{ concurrency: "unbounded" },
			)
			const connected = Object.fromEntries(
				entries.flat().map((entry) => [entry.provider, entry.isConnected]),
			)
			return ConnectMessage.LoadedConnected({ connected })
		}),
})

const WaitConnectPoll = Command.define("WaitOnboardingConnectPoll", {
	messages: [ConnectMessage.ElapsedPoll],
	execute: Effect.as(Effect.sleep(POLL), ConnectMessage.ElapsedPoll()),
})

type Step = Readonly<{
	connect: Connect
	commands: ReadonlyArray<Command.Command<ConnectMessage, never, Resources>>
}>

/** The drawer closed: the picked providers' connections, read once outside the poll. */
export const refreshConnected = (
	orgId: string,
	platforms: ReadonlyArray<StackPlatform>,
): Step["commands"] => {
	const providers = platforms.filter(isStatusProvider)
	return providers.length === 0 ? [] : [LoadConnected({ orgId, providers })]
}

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
		SucceededLoadKeys: ({ privateKey }) => ({
			connect: { ...connect, keys: { _tag: "Ready", privateKey } },
			commands: [],
		}),
		FailedLoadKeys: () => ({ connect: { ...connect, keys: { _tag: "Failed" } }, commands: [] }),
		LoadedPresence: ({ result }) => ({
			connect: { ...connect, presence: AsyncData.settle(connect.presence, result) },
			commands: connect.isActive ? [WaitConnectPoll()] : [],
		}),
		LoadedConnected: ({ connected }) => ({
			connect: { ...connect, connected: { ...connect.connected, ...connected } },
			commands: [],
		}),
		ElapsedPoll: () => ({ connect, commands: connect.isActive ? reads(orgId, platforms) : [] }),
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

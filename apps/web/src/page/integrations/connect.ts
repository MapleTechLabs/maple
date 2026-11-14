import {
	CloudflareStartConnectRequest,
	GithubStartConnectRequest,
	IntegrationReturnPath,
	LinearStartConnectRequest,
	SearchConsoleStartConnectRequest,
	SupabaseConnectRequest,
} from "@maple/domain/http"
import { Context, Effect, Result, Schema, Stream } from "effect"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { MapleApiV2Client, MapleInternalApiClient } from "../../platform/api-clients"
import { PROVIDERS as REGISTRY } from "../kit/providers"

export const ConnectProvider = Schema.Literals([
	"cloudflare",
	"linear",
	"github",
	"planetscale",
	"supabase",
	"google-search-console",
])
export type ConnectProvider = typeof ConnectProvider.Type

const browserCallbackEvents = () => ({
	ownOrigin: window.location.origin,
	messages: Stream.fromEventListener<MessageEvent>(window, "message"),
})

/** The browser's callback channel; its event source and origin travel together. */
export const IntegrationCallbackEvents = Context.Reference<ReturnType<typeof browserCallbackEvents>>(
	"@maple/web/IntegrationCallbackEvents",
	{ defaultValue: browserCallbackEvents },
)

/** One attempt: the popup is out while this is set; a new attempt restarts the flow. */
export const ConnectAttempt = Schema.Struct({
	provider: ConnectProvider,
	attempt: Schema.Number,
	/** GitHub only: open the App install page instead of user authorization. */
	githubMode: Schema.optionalKey(Schema.Literal("install")),
})
export type ConnectAttempt = typeof ConnectAttempt.Type

export const ConnectModel = Schema.Struct({
	attempts: Schema.Number,
	active: Schema.NullOr(ConnectAttempt),
	/** The start mutation is in flight (`busy`). */
	isStarting: Schema.Boolean,
	/** The popup closed; the provider's grace runs until `active` clears. */
	isClosed: Schema.Boolean,
})
export type ConnectModel = typeof ConnectModel.Type

export const initConnect = (): ConnectModel => ({
	attempts: 0,
	active: null,
	isStarting: false,
	isClosed: false,
})

interface PopupSpec {
	readonly windowFeatures: string
	/** `closeGraceMs`: polling continues this long after the popup closes. */
	readonly closeGraceMs: number
	/** Whether the status is re-read every 3 s while the popup is out. */
	readonly polls: boolean
}

interface ProviderSpec extends PopupSpec {
	readonly label: string
	readonly windowName: string
	readonly startErrorTitle: string
}

const POPUP = { windowFeatures: "popup,width=520,height=680", closeGraceMs: 0, polls: false } as const

/** The provider's popup, with its label, window name and error title from its registry name. */
const spec = (provider: ConnectProvider, popup: PopupSpec): ProviderSpec => ({
	...popup,
	label: REGISTRY[provider].name,
	windowName: `maple-${provider}-connect`,
	startErrorTitle: `Couldn't start ${REGISTRY[provider].name} connect flow`,
})

export const PROVIDERS = {
	cloudflare: spec("cloudflare", { ...POPUP, closeGraceMs: 15_000, polls: true }),
	linear: spec("linear", POPUP),
	github: spec("github", { ...POPUP, windowFeatures: "popup,width=600,height=720", closeGraceMs: 10_000 }),
	planetscale: spec("planetscale", POPUP),
	supabase: spec("supabase", { ...POPUP, windowFeatures: "popup,width=560,height=720" }),
	"google-search-console": spec("google-search-console", POPUP),
} satisfies { readonly [K in ConnectProvider]: ProviderSpec }

const decodeReturnPath = Schema.decodeUnknownResult(IntegrationReturnPath)
const RETURN_PATH_ROOT = Schema.decodeSync(IntegrationReturnPath)("/")

/** `currentReturnPath()`: the callback only accepts a dashboard-relative path. */
export const currentReturnPath = Effect.sync(() =>
	Result.getOrElse(
		decodeReturnPath(`${window.location.pathname}${window.location.search}`),
		() => RETURN_PATH_ROOT,
	),
)

/** The provider's start mutation, answering the authorize URL. */
export const startConnect = (
	provider: ConnectProvider,
	returnTo: IntegrationReturnPath,
	githubMode?: "install",
) =>
	Effect.gen(function* () {
		const internal = yield* MapleInternalApiClient
		const v2 = yield* MapleApiV2Client
		switch (provider) {
			case "cloudflare":
				return yield* internal.integrations.cloudflareStart({
					payload: new CloudflareStartConnectRequest({ returnTo }),
				})
			case "linear":
				return yield* internal.integrations.linearStart({
					payload: new LinearStartConnectRequest({ returnTo }),
				})
			case "github":
				return yield* internal.integrations.githubStart({
					payload: new GithubStartConnectRequest(
						githubMode === undefined ? { returnTo } : { returnTo, mode: githubMode },
					),
				})
			case "planetscale": {
				const response = yield* v2.planetscaleIntegration.connect({
					payload: { return_to: returnTo },
				})
				return { redirectUrl: response.redirect_url }
			}
			case "google-search-console":
				return yield* internal.integrations.searchConsoleStart({
					payload: new SearchConsoleStartConnectRequest({ returnTo }),
				})
			case "supabase":
				return yield* internal.integrations.supabaseConnect({
					payload: new SupabaseConnectRequest({ returnTo }),
				})
		}
	}).pipe(Effect.mapError(toLoadFailure))

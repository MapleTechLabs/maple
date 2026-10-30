import {
	CloudflareStartConnectRequest,
	GithubStartConnectRequest,
	HazelStartConnectRequest,
	IntegrationReturnPath,
	LinearStartConnectRequest,
	SupabaseConnectRequest,
} from "@maple/domain/http"
import { Effect, Result, Schema } from "effect"
import { toLoadFailure } from "../../data/load-failure"
import { MapleApiV2Client, MapleInternalApiClient } from "../../platform/api-clients"

// `IntegrationConnectProvider` and `useOAuthPopupFlow`.

export const ConnectProvider = Schema.Literals([
	"cloudflare",
	"hazel",
	"linear",
	"github",
	"planetscale",
	"supabase",
])
export type ConnectProvider = typeof ConnectProvider.Type

/** One attempt: the popup is out while this is set; a new attempt restarts the flow. */
export const ConnectAttempt = Schema.Struct({
	provider: ConnectProvider,
	attempt: Schema.Number,
	githubMode: Schema.optionalKey(Schema.Literals(["install", "existing"])),
})
export type ConnectAttempt = typeof ConnectAttempt.Type

export const ConnectModel = Schema.Struct({
	attempts: Schema.Number,
	active: Schema.NullOr(ConnectAttempt),
	/** The start mutation is in flight (`busy`). */
	isStarting: Schema.Boolean,
	/** The popup closed; the provider's grace runs until `active` clears (`popupActive` = `active !== null`). */
	isClosed: Schema.Boolean,
})
export type ConnectModel = typeof ConnectModel.Type

export const initConnect = (): ConnectModel => ({
	attempts: 0,
	active: null,
	isStarting: false,
	isClosed: false,
})

interface ProviderSpec {
	readonly label: string
	readonly windowName: string
	readonly windowFeatures: string
	readonly startErrorTitle: string
	/** `closeGraceMs`: polling continues this long after the popup closes. */
	readonly closeGraceMs: number
	/** Whether the status is re-read every 3 s while the popup is out (`onPoll`). */
	readonly polls: boolean
}

export const PROVIDERS = {
	cloudflare: {
		label: "Cloudflare",
		windowName: "maple-cloudflare-connect",
		windowFeatures: "popup,width=520,height=680",
		startErrorTitle: "Failed to start Cloudflare connect flow",
		closeGraceMs: 15_000,
		polls: true,
	},
	hazel: {
		label: "Hazel",
		windowName: "maple-hazel-connect",
		windowFeatures: "popup,width=520,height=640",
		startErrorTitle: "Failed to start Hazel connect flow",
		closeGraceMs: 0,
		polls: false,
	},
	linear: {
		label: "Linear",
		windowName: "maple-linear-connect",
		windowFeatures: "popup,width=520,height=680",
		startErrorTitle: "Failed to start Linear connect flow",
		closeGraceMs: 0,
		polls: false,
	},
	github: {
		label: "GitHub",
		windowName: "maple-github-connect",
		windowFeatures: "popup,width=600,height=720",
		startErrorTitle: "Failed to start GitHub connect flow",
		closeGraceMs: 10_000,
		polls: false,
	},
	planetscale: {
		label: "PlanetScale",
		windowName: "maple-planetscale-connect",
		windowFeatures: "popup,width=520,height=680",
		startErrorTitle: "Failed to start PlanetScale connect flow",
		closeGraceMs: 0,
		polls: false,
	},
	supabase: {
		label: "Supabase",
		windowName: "maple-supabase-connect",
		windowFeatures: "popup,width=560,height=720",
		startErrorTitle: "Failed to start Supabase connect flow",
		closeGraceMs: 0,
		polls: false,
	},
} satisfies { readonly [K in ConnectProvider]: ProviderSpec }

const decodeReturnPath = Schema.decodeUnknownResult(IntegrationReturnPath)
const RETURN_PATH_ROOT = Schema.decodeUnknownSync(IntegrationReturnPath)("/")

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
	githubMode?: "install" | "existing",
) =>
	Effect.gen(function* () {
		const internal = yield* MapleInternalApiClient
		const v2 = yield* MapleApiV2Client
		switch (provider) {
			case "cloudflare":
				return yield* internal.integrations.cloudflareStart({
					payload: new CloudflareStartConnectRequest({ returnTo }),
				})
			case "hazel":
				return yield* internal.integrations.hazelStart({
					payload: new HazelStartConnectRequest({ returnTo }),
				})
			case "linear":
				return yield* internal.integrations.linearStart({
					payload: new LinearStartConnectRequest({ returnTo }),
				})
			case "github":
				return yield* internal.integrations.githubStart({
					payload: new GithubStartConnectRequest({ returnTo, mode: githubMode }),
				})
			case "planetscale": {
				const response = yield* v2.planetscaleIntegration.connect({
					payload: { return_to: returnTo },
				})
				return { redirectUrl: response.redirect_url }
			}
			case "supabase":
				return yield* internal.integrations.supabaseConnect({
					payload: new SupabaseConnectRequest({ returnTo }),
				})
		}
	}).pipe(Effect.mapError(toLoadFailure))

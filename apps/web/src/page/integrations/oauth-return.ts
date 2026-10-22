import {
	decodeOAuthReturnHash,
	OAuthChatOutcome,
	OAuthCompleteStatus,
	type OAuthCompleteRequest,
	type OAuthReturnFlow,
	type OAuthCompleteResponse,
} from "@maple/domain/http"
import { Effect, Option, Schema } from "effect"
import { MapleInternalApiClient } from "../../platform/api-clients"
import { ConnectProvider } from "./connect"

// A provider return the API handed over in the URL fragment (`#maple_oauth=…`). The API callback
// holds no Maple session, so this signed-in page finishes it: only the user who started it can.

/** The provider a popup reports to (`ReceivedConnectMessage`); the chat flows report via search. */
const PROVIDER_OF = {
	cloudflare: "cloudflare",
	hazel: "hazel",
	github: "github",
	planetscale: "planetscale",
	supabase: "supabase",
	chat_install: null,
	chat_identity: null,
} satisfies { readonly [K in OAuthReturnFlow]: ConnectProvider | null }

export const OAuthReturnOutcome = Schema.Struct({
	provider: Schema.NullOr(ConnectProvider),
	connector: Schema.NullOr(Schema.String),
	status: OAuthCompleteStatus,
	message: Schema.String,
	chat: Schema.NullOr(OAuthChatOutcome),
	/** The tab that opened this popup got the outcome and reacts to it; this window closes on success. */
	isHandedOff: Schema.Boolean,
})
export type OAuthReturnOutcome = typeof OAuthReturnOutcome.Type

/** Read the fragment and drop it, so a reload or a shared URL never redeems the return twice. */
const takeReturn = Effect.sync(() => {
	const request = decodeOAuthReturnHash(window.location.hash)
	if (Option.isSome(request)) {
		window.history.replaceState(
			window.history.state,
			"",
			`${window.location.pathname}${window.location.search}`,
		)
	}
	return request
})

/** What the callback page used to post: the integrations page listens for exactly this. */
interface CallbackMessage {
	readonly type: string
	readonly status: string
	readonly message: string
}

interface Opener {
	readonly closed: boolean
	readonly postMessage: (message: CallbackMessage, targetOrigin: string) => void
}

const isOpener = (value: unknown): value is Opener =>
	typeof value === "object" && value !== null && "postMessage" in value && "closed" in value

/** Post the outcome to the opening tab, on this origin only. False when there is none to tell. */
const handOff = (provider: ConnectProvider, status: string, message: string) =>
	Effect.sync(() => {
		const opener: unknown = window.opener
		if (!isOpener(opener) || opener.closed) return false
		opener.postMessage({ type: `maple:integration:${provider}`, status, message }, window.location.origin)
		if (status === "success") setTimeout(() => window.close(), 600)
		return true
	})

const UNREACHABLE: Pick<OAuthCompleteResponse, "status" | "message" | "chat"> = {
	status: "error",
	message: "Maple could not finish the connection. Try connecting again.",
	chat: null,
}

const finish = (request: OAuthCompleteRequest) =>
	Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		const response = yield* client.integrations
			.oauthComplete({ payload: request })
			.pipe(Effect.catch(() => Effect.succeed(UNREACHABLE)))
		const provider = PROVIDER_OF[request.flow]
		const isHandedOff =
			provider === null ? false : yield* handOff(provider, response.status, response.message)
		return {
			provider,
			connector: request.connector ?? null,
			status: response.status,
			message: response.message,
			chat: response.chat,
			isHandedOff,
		} satisfies OAuthReturnOutcome
	})

/** The return this page was opened with, finished; `null` when the URL carried none. */
export const completeOAuthReturn: Effect.Effect<OAuthReturnOutcome | null, never, MapleInternalApiClient> =
	Effect.gen(function* () {
		const request = yield* takeReturn
		return Option.isNone(request) ? null : yield* finish(request.value)
	})

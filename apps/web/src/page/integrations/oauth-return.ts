import {
	GithubInstallationSelection,
	OAuthChatOutcome,
	OAuthCompleteStatus,
	type OAuthCompleteRequest,
	type OAuthReturnFlow,
	type OAuthCompleteResponse,
} from "@maple/domain/http"
import { Clock, Effect, Option, Schema } from "effect"
import { MapleInternalApiClient } from "../../platform/api-clients"
import { browserStorage, type ReturnStorage, takeOAuthReturn } from "../../platform/oauth-return-stash"
import { ConnectProvider } from "./connect"

// A provider return the API handed over in the URL fragment (`#maple_oauth=…`), stashed at boot.
// The API callback holds no Maple session, so this signed-in page finishes it: only the user who
// started it can. Integrations and the Sources steps both run it, wherever the redirects land.

/** The provider a popup reports to (`ReceivedConnectMessage`); the chat flows report via search. */
const PROVIDER_OF = {
	cloudflare: "cloudflare",
	hazel: "hazel",
	linear: "linear",
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
	github: Schema.optionalKey(GithubInstallationSelection),
	/** The tab that opened this popup got the outcome and reacts to it; this window closes on success. */
	isHandedOff: Schema.Boolean,
})
export type OAuthReturnOutcome = typeof OAuthReturnOutcome.Type

/** What the callback page used to post: the integrations page listens for exactly this. */
interface CallbackMessage {
	readonly type: string
	readonly status: string
	readonly message: string
	github?: GithubInstallationSelection
}

interface Opener {
	readonly closed: boolean
	readonly postMessage: (message: CallbackMessage, targetOrigin: string) => void
}

const isOpener = (value: unknown): value is Opener =>
	typeof value === "object" && value !== null && "postMessage" in value && "closed" in value

/** Post the outcome to the opening tab, on this origin only. False when there is none to tell. */
const handOff = (
	provider: ConnectProvider,
	status: string,
	message: string,
	github?: GithubInstallationSelection,
) =>
	Effect.sync(() => {
		const opener: unknown = window.opener
		if (!isOpener(opener) || opener.closed) return false
		const payload: CallbackMessage = { type: `maple:integration:${provider}`, status, message }
		if (github !== undefined) payload.github = github
		opener.postMessage(payload, window.location.origin)
		if (status === "success") setTimeout(() => window.close(), 600)
		return true
	})

type CompletionResult = Pick<OAuthCompleteResponse, "status" | "message" | "chat" | "github">

const UNREACHABLE: CompletionResult = {
	status: "error",
	message: "Maple could not finish the connection. Try connecting again.",
	chat: null,
}

/** What finishing a return touches: the tab's stash, the API, and the opening tab. */
export interface OAuthReturnDeps<R> {
	readonly storage: ReturnStorage
	readonly now: number
	readonly complete: (request: OAuthCompleteRequest) => Effect.Effect<CompletionResult, never, R>
	readonly handOff: (
		provider: ConnectProvider,
		status: string,
		message: string,
		github?: GithubInstallationSelection,
	) => Effect.Effect<boolean>
	/** Sends this window on to another page (the GitHub App install). */
	readonly redirect: (url: string) => Effect.Effect<void>
}

/** GitHub authorization found nothing to connect or explain: go straight on to install. */
const isNothingToChoose = (
	github: GithubInstallationSelection | undefined,
): github is GithubInstallationSelection =>
	github !== undefined && github.installations.length === 0 && github.needsApproval.length === 0

/** The return stashed at boot (`oauth-return-boot.ts`), finished once; `null` when there is none. */
export const completeOAuthReturnWith = <R>(deps: OAuthReturnDeps<R>) =>
	Effect.gen(function* () {
		const stashed = yield* takeOAuthReturn(deps.storage, deps.now)
		if (Option.isNone(stashed)) return null
		const request = stashed.value
		const response = yield* deps.complete(request)
		const provider = PROVIDER_OF[request.flow]
		if (response.status === "success" && isNothingToChoose(response.github)) {
			yield* deps.redirect(response.github.installUrl)
			// The install return finishes the connect; nothing for this page or its opener yet.
			return OAuthReturnOutcome.make({
				provider,
				connector: request.connector ?? null,
				status: response.status,
				message: "Opening GitHub to install the Maple app.",
				chat: response.chat,
				isHandedOff: true,
			})
		}
		const isHandedOff =
			provider === null
				? false
				: yield* deps.handOff(provider, response.status, response.message, response.github)
		const outcome = {
			provider,
			connector: request.connector ?? null,
			status: response.status,
			message: response.message,
			chat: response.chat,
			isHandedOff,
		}
		return OAuthReturnOutcome.make(
			response.github === undefined ? outcome : { ...outcome, github: response.github },
		)
	})

export const completeOAuthReturn: Effect.Effect<OAuthReturnOutcome | null, never, MapleInternalApiClient> =
	Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		const now = yield* Clock.currentTimeMillis
		return yield* completeOAuthReturnWith({
			storage: browserStorage,
			now,
			handOff,
			redirect: (url) => Effect.sync(() => window.location.assign(url)),
			complete: (request) =>
				client.integrations
					.oauthComplete({ payload: request })
					.pipe(Effect.orElseSucceed(() => UNREACHABLE)),
		})
	})

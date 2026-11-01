import { Option, Schema } from "effect"
import { ChatConnectorId } from "../primitives"
import { VcsAccountType, VcsRepoSelection } from "./vcs"

/**
 * An OAuth / app-install return, finished by the signed-in dashboard rather than the callback.
 *
 * The provider redirects to the API's public callback, which carries no Maple session. It hands
 * the query to the dashboard in a URL fragment, and the dashboard posts it back with its session,
 * so the connection lands only for the Maple user and org that started the flow.
 */
export const OAuthReturnFlow = Schema.Literals([
	"cloudflare",
	"linear",
	"github",
	"planetscale",
	"supabase",
	"chat_install",
	"chat_identity",
])
export type OAuthReturnFlow = typeof OAuthReturnFlow.Type

/** The provider callback's query string is short; this bounds what the endpoint will parse. */
const QUERY_MAX_LENGTH = 8192

export class OAuthCompleteRequest extends Schema.Class<OAuthCompleteRequest>("OAuthCompleteRequest")({
	flow: OAuthReturnFlow,
	/** Set for the chat flows: the connector the callback path named. */
	connector: Schema.optionalKey(ChatConnectorId),
	/** The provider callback's query string, as the API callback received it. */
	query: Schema.String.check(Schema.isMaxLength(QUERY_MAX_LENGTH)),
}) {}

export const OAuthCompleteStatus = Schema.Literals(["success", "error"])

/** What the chat flows report back, mirrored into the integrations page's `chat*` search params. */
export const OAuthChatOutcome = Schema.Struct({
	kind: Schema.Literals(["workspace", "identity"]),
	/** Platform-authored, untrusted: the page clamps it. */
	name: Schema.NullOr(Schema.String),
	/** A closed code on failure (`state`, `conflict`, `unconfigured`, `unknown`, `failed`). */
	reason: Schema.NullOr(Schema.String),
})

export class GithubInstallationChoice extends Schema.Class<GithubInstallationChoice>(
	"GithubInstallationChoice",
)({
	id: Schema.String,
	accountLogin: Schema.String,
	accountType: VcsAccountType,
	repositorySelection: VcsRepoSelection,
}) {}

/**
 * What GitHub user authorization found. `state` is a short-lived, single-use selection over
 * the verified `installations`; `needsApproval` lists accounts whose org withheld the user's
 * role; `unavailable` counts ones this user cannot connect here; `installUrl` installs the app
 * on another account.
 */
export class GithubInstallationSelection extends Schema.Class<GithubInstallationSelection>(
	"GithubInstallationSelection",
)({
	state: Schema.String,
	installations: Schema.Array(GithubInstallationChoice),
	needsApproval: Schema.Array(Schema.String),
	unavailable: Schema.Number,
	installUrl: Schema.String,
}) {}

export class OAuthCompleteResponse extends Schema.Class<OAuthCompleteResponse>("OAuthCompleteResponse")({
	status: OAuthCompleteStatus,
	message: Schema.String,
	chat: Schema.NullOr(OAuthChatOutcome),
	github: Schema.optionalKey(GithubInstallationSelection),
}) {}

/** The fragment key the API callback writes and the dashboard reads. */
const HASH_KEY = "maple_oauth"

/** `#maple_oauth=<flow>&connector=<id>&q=<query>`: a fragment never reaches a server or a Referer. */
export const encodeOAuthReturnHash = (request: {
	readonly flow: OAuthReturnFlow
	readonly connector?: string
	readonly query: string
}): string =>
	`#${new URLSearchParams({
		[HASH_KEY]: request.flow,
		...(request.connector === undefined ? undefined : { connector: request.connector }),
		q: request.query,
	}).toString()}`

const decodeRequest = Schema.decodeUnknownOption(OAuthCompleteRequest)

/** The return a dashboard URL fragment carries, if it carries one. */
export const decodeOAuthReturnHash = (hash: string): Option.Option<OAuthCompleteRequest> => {
	const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash)
	const flow = params.get(HASH_KEY)
	const connector = params.get("connector")
	return flow === null
		? Option.none()
		: decodeRequest({
				flow,
				...(connector === null ? undefined : { connector }),
				query: params.get("q") ?? "",
			})
}

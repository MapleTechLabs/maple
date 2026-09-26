import { SupportChannelUnavailableError } from "@maple/domain/support-channel"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Env } from "@maple/backend/platform/Env"

/**
 * The handful of Slack Web API calls a shared support channel needs, made with the bot token of
 * Maple's own workspace. Not the chat connector: that one speaks to customer workspaces with
 * per-install tokens; this one only ever acts inside Maple's.
 */

const SLACK_API_BASE = "https://slack.com/api"

const SlackResponse = Schema.Struct({
	ok: Schema.Boolean,
	error: Schema.optionalKey(Schema.String),
	channel: Schema.optionalKey(Schema.Struct({ id: Schema.String, name: Schema.String })),
})
type SlackResponse = Schema.Schema.Type<typeof SlackResponse>
const decodeSlackResponse = Schema.decodeUnknownEffect(SlackResponse)

/** Slack refused the call; `error` is its machine-readable reason (`name_taken`, …). */
export class SupportSlackRefusedError extends Schema.TaggedError<SupportSlackRefusedError>()(
	"@maple/backend/support/SupportSlackRefusedError",
	{ message: Schema.String, method: Schema.String, error: Schema.String },
) {}

export type SupportSlackMethod =
	| "conversations.create"
	| "conversations.invite"
	| "conversations.inviteShared"
	| "chat.postMessage"

export interface SupportSlackClientApi {
	/** False when this deployment has no bot token; every call then fails as unavailable. */
	readonly configured: boolean
	/** Maple team members added to each new channel. */
	readonly teamUserIds: ReadonlyArray<string>
	readonly call: (
		method: SupportSlackMethod,
		body: Record<string, unknown>,
	) => Effect.Effect<SlackResponse, SupportSlackRefusedError | SupportChannelUnavailableError>
}

export class SupportSlackClient extends Context.Service<SupportSlackClient, SupportSlackClientApi>()(
	"@maple/backend/services/support/SupportSlackClient",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const httpClient = yield* HttpClient.HttpClient
			const token = Option.map(env.MAPLE_SUPPORT_SLACK_BOT_TOKEN, Redacted.value)
			const teamUserIds = Option.match(env.MAPLE_SUPPORT_SLACK_TEAM_USER_IDS, {
				onNone: () => [],
				onSome: (raw) =>
					raw
						.split(",")
						.map((id) => id.trim())
						.filter((id) => id.length > 0),
			})

			const unavailable = (method: string) => (cause: unknown) =>
				new SupportChannelUnavailableError({
					message: `Slack ${method} failed`,
					operation: method,
					cause,
				})

			const call = Effect.fn("SupportSlackClient.call", { kind: "client" })(function* (
				method: SupportSlackMethod,
				body: Record<string, unknown>,
			) {
				yield* Effect.annotateCurrentSpan({ "peer.service": "slack", "slack.method": method })
				if (Option.isNone(token)) {
					return yield* new SupportChannelUnavailableError({
						message: "Support Slack bot token is not configured",
						operation: method,
					})
				}
				const response = yield* httpClient
					.execute(
						HttpClientRequest.post(`${SLACK_API_BASE}/${method}`).pipe(
							HttpClientRequest.bearerToken(token.value),
							HttpClientRequest.bodyJsonUnsafe(body),
						),
					)
					.pipe(Effect.mapError(unavailable(method)))
				yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
				const json = yield* response.json.pipe(Effect.mapError(unavailable(method)))
				const decoded = yield* decodeSlackResponse(json).pipe(Effect.mapError(unavailable(method)))
				if (!decoded.ok) {
					const error = decoded.error ?? "unknown_error"
					yield* Effect.annotateCurrentSpan({ "slack.error": error })
					return yield* new SupportSlackRefusedError({
						message: `Slack ${method} refused: ${error}`,
						method,
						error,
					})
				}
				return decoded
			})

			return { configured: Option.isSome(token), teamUserIds, call } satisfies SupportSlackClientApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}

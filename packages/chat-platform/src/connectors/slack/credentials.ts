/**
 * What this connector keeps per installed workspace, and how it is written down.
 *
 * Slack mints one bot token per workspace, so there is no deployment-wide secret the outbound half
 * could use — the install returns the token and the host stores it sealed beside the row
 * (`ChatInstallResult.credentials`). What crosses that boundary is this JSON, and nothing between
 * the two halves reads it: to the host it is an opaque string.
 *
 * It is JSON rather than the bare token so that the day a second value is needed it is one more key
 * here — read by the same connector that wrote it — rather than a migration of a shared table and
 * a re-install of every workspace. One key is in it today.
 */
import { Option, Schema } from "effect"

/**
 * The token's FORMAT is deliberately not checked.
 *
 * It arrives from Slack's own token response, and the shapes it can take are Slack's to change:
 * an app with token rotation enabled answers `xoxe.xoxb-…` rather than `xoxb-…`. A pattern here
 * would turn a setting on Slack's side into a rejected install — and worse, into a THROWN one,
 * since this is the encode side and the value would already have passed the install's own checks.
 * The token is opaque to everything but the `Authorization` header; a wrong one fails the first
 * post with Slack's own error, which is a better report than a regex could write.
 */
export const SlackCredentials = Schema.Struct({
	bot_token: Schema.String,
})
export type SlackCredentials = Schema.Schema.Type<typeof SlackCredentials>

const encode = Schema.encodeSync(Schema.fromJsonString(SlackCredentials))
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(SlackCredentials))

/** Write the pair down for the host to seal. Values come from Slack's own token response. */
export const encodeSlackCredentials = (credentials: SlackCredentials): string => encode(credentials)

/**
 * Read the pair back out of `ConnectorCredentials`, or `None`.
 *
 * `None` covers every way this can be absent — a workspace nobody linked, a deployment whose key
 * cannot open the envelope, a row written by an older encoding — and they all mean the same thing
 * to the transport: there is no token, so there is nothing to post with.
 */
export const decodeSlackCredentials = (raw: string | undefined): Option.Option<SlackCredentials> =>
	raw === undefined ? Option.none() : decode(raw)

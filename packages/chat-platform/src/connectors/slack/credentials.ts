/**
 * What this connector keeps per installed workspace, and how it is written down.
 *
 * Slack mints one bot token per workspace, so there is no deployment-wide secret the outbound half
 * could use — the install returns the token and the host stores it sealed beside the row
 * (`ChatInstallResult.credentials`). What crosses that boundary is this JSON, and nothing between
 * the two halves reads it: to the host it is an opaque string.
 *
 * It is JSON rather than the bare token because a token is not the whole credential. `bot_user_id`
 * is what the outbound half would need to address the bot, and keeping the pair together means the
 * day a second value is needed it is one more key here rather than one more column in a shared
 * table.
 */
import { Option, Schema } from "effect"

/**
 * Bot tokens are `xoxb-…`; an enterprise-wide install would be `xoxe-…`, which this connector
 * refuses at install time (see `install.ts`). The prefix is checked so a value that is not a bot
 * token cannot be stored and then fail every post with an unhelpful Slack error.
 */
const BotToken = Schema.String.check(Schema.isPattern(/^xoxb-/))

/** `U…` for a person, `B…` for the app's own bot record; the app's bot USER id is a `U`. */
const SlackUserId = Schema.String.check(Schema.isPattern(/^[UW][A-Z0-9]+$/))

export const SlackCredentials = Schema.Struct({
	bot_token: BotToken,
	bot_user_id: SlackUserId,
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

/**
 * What all three halves of this connector agree on: where Discord is, and what its secrets are
 * called.
 *
 * Its own module for the same reason `./id.ts` is: the install flow, the outbound transport and
 * the gateway state machine all need these, and none of them should have to import another to get
 * them. A base URL or a config name written twice is one that gets changed once.
 */

/**
 * REST v10. Every half talks to this base — install to exchange the authorization code, outbound
 * to post, ingress to acknowledge a click.
 */
export const API_BASE = "https://discord.com/api/v10"

export const API_HOST = "discord.com"

/** The OAuth2 authorization page a member is sent to, which is not under `/api`. */
export const AUTHORIZE_URL = "https://discord.com/oauth2/authorize"

export const TOKEN_URL = `${API_BASE}/oauth2/token`

/**
 * The one name for this connector's bot token, declared once.
 *
 * The gateway half names it in `requiredConfig`, so the host resolves it generically from its env
 * and hands the value to the pure state machine. The outbound half receives the same secret as the
 * `DiscordBotToken` service, because an Effect transport can take a service where a pure function
 * cannot — two mechanisms, deliberately, but one secret under one name.
 */
export const BOT_TOKEN_CONFIG = "MAPLE_DISCORD_BOT_TOKEN"

/**
 * The application's OAuth2 credentials, named in the install half's `requiredConfig`.
 *
 * A different worker resolves these than resolves the bot token: installing is the API's job and
 * carrying a turn is the bot's, so the two never need each other's secrets. They are declared here
 * anyway, beside the token, because this file is the answer to "what is this connector called in
 * an environment" — and the client id is not a secret, which is why `ConnectorConfigKey` carries
 * that as a flag rather than assuming it.
 */
export const CLIENT_ID_CONFIG = "MAPLE_DISCORD_CLIENT_ID"

export const CLIENT_SECRET_CONFIG = "MAPLE_DISCORD_CLIENT_SECRET"

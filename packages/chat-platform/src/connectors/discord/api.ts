/**
 * What both halves of this connector agree on.
 *
 * Its own module for the same reason `./id.ts` is: the outbound transport and the gateway state
 * machine both need these, and neither should have to import the other to get them.
 */

/** REST v10. Both halves talk to this base — outbound to post, ingress to acknowledge a click. */
export const API_BASE = "https://discord.com/api/v10"

export const API_HOST = "discord.com"

/**
 * The one name for this connector's bot token, declared once.
 *
 * The gateway half names it in `requiredConfig`, so the host resolves it generically from its env
 * and hands the value to the pure state machine. The outbound half receives the same secret as the
 * `DiscordBotToken` service, because an Effect transport can take a service where a pure function
 * cannot — two mechanisms, deliberately, but one secret under one name.
 */
export const BOT_TOKEN_CONFIG = "MAPLE_DISCORD_BOT_TOKEN"

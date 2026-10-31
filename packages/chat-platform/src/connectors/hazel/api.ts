/**
 * What all three halves of this connector agree on: where Hazel is, and what its secrets are
 * called.
 *
 * Its own module for the same reason `./id.ts` is: the install flow, the outbound transport and
 * the gateway state machine all need these, and none of them should have to import another to get
 * them.
 */

/** The public bot API (`/api/v1`): messages, threads, people, install grants. */
export const API_BASE = "https://api.hazel.sh/api/v1"

export const API_HOST = "api.hazel.sh"

/** The bot gateway: a resumable WebSocket that delivers the bot's events in acknowledged batches. */
export const GATEWAY_URL = "wss://bot-gateway.hazel.sh/bot-gateway/ws"

/** The consent page an org admin is sent to: they pick a Hazel workspace and approve the install. */
export const INSTALL_URL = "https://app.hazel.sh/oauth/bot-install"

/**
 * The bot's token (`hzl_bot_…`), shown once when the bot is created in Hazel. Declared once: the
 * gateway identifies with it, the outbound half posts with it, and the install half redeems a
 * grant with it — a Hazel install code is only redeemable by the bot it was issued to.
 */
export const BOT_TOKEN_CONFIG = "MAPLE_HAZEL_BOT_TOKEN"

/** The bot's id, the `bot_id` of its install link. Not a secret: it rides the URL the browser opens. */
export const BOT_ID_CONFIG = "MAPLE_HAZEL_BOT_ID"

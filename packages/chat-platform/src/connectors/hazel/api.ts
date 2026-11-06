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

/**
 * The bot's own settings (`PATCH`, bot token). Outside `/api/v1`: Hazel serves its bot-token
 * endpoints under `/bot-commands`.
 */
export const BOT_SETTINGS_URL = `https://${API_HOST}/bot-commands/settings`

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

/**
 * The Hazel gateway region this deployment serves (`eu` on Maple's EU instance), optional. Every
 * Maple instance runs the same bot: the gateway holds one session per region, and each install's
 * events go to the region that redeemed it. Unset is the default region.
 */
export const REGION_CONFIG = "MAPLE_HAZEL_REGION"

/** The declaration every half that reads {@link REGION_CONFIG} lists. */
export const REGION_CONFIG_KEY = { name: REGION_CONFIG, secret: false, optional: true } as const

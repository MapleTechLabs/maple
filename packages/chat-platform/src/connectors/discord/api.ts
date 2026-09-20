/**
 * Every Discord address this connector talks to, in one module.
 *
 * The install half and the outbound half both reach discord.com, and a base URL written twice is a
 * base URL that gets bumped once. `API_HOST` is the span attribute, so it stays beside the base it
 * is the host of rather than being re-derived from it.
 */

/** REST v10 — the version every route in `outbound.ts` is documented against. */
export const API_BASE = "https://discord.com/api/v10"

export const API_HOST = "discord.com"

/** The OAuth2 authorization page a member is sent to, which is not under `/api`. */
export const AUTHORIZE_URL = "https://discord.com/oauth2/authorize"

export const TOKEN_URL = `${API_BASE}/oauth2/token`

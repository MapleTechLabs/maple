import { createHmac, timingSafeEqual } from "node:crypto"

/** Which of a subscriber row's two emails a link turns off. */
export type UnsubscribeKind = "digest" | "web-analytics"

const KINDS: ReadonlyArray<UnsubscribeKind> = ["digest", "web-analytics"]

/**
 * Subkey for unsubscribe links, derived from an existing deployment secret so the
 * links need no new secret. The label keeps these signatures from ever colliding
 * with the parent key's own HMACs.
 */
const deriveKey = (secret: string) =>
	createHmac("sha256", secret).update("maple/email-unsubscribe/v1").digest()

const sign = (secret: string, kind: UnsubscribeKind, subscriptionId: string) =>
	createHmac("sha256", deriveKey(secret)).update(`${kind}:${subscriptionId}`).digest()

/** `<kind>.<subscriptionId>.<sig>`: no expiry, a link in an old email must keep working. */
export const mintUnsubscribeToken = (secret: string, kind: UnsubscribeKind, subscriptionId: string) =>
	`${kind}.${subscriptionId}.${sign(secret, kind, subscriptionId).toString("base64url")}`

export const verifyUnsubscribeToken = (
	secret: string,
	token: string,
): { readonly kind: UnsubscribeKind; readonly subscriptionId: string } | undefined => {
	const [rawKind, subscriptionId, rawSig, ...rest] = token.split(".")
	const kind = KINDS.find((k) => k === rawKind)
	if (kind === undefined || !subscriptionId || !rawSig || rest.length > 0) return undefined
	const expected = sign(secret, kind, subscriptionId)
	const actual = Buffer.from(rawSig, "base64url")
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
	return { kind, subscriptionId }
}

/**
 * The footer link (a confirm page, since link scanners prefetch GETs) and the RFC 8058
 * one-click headers mail clients POST to directly. Both work without a session.
 */
export const unsubscribeLinks = (
	config: { readonly secret: string; readonly appBaseUrl: string; readonly apiBaseUrl: string },
	kind: UnsubscribeKind,
	subscriptionId: string,
) => {
	const token = encodeURIComponent(mintUnsubscribeToken(config.secret, kind, subscriptionId))
	return {
		pageUrl: `${config.appBaseUrl}/unsubscribe?token=${token}`,
		headers: {
			"List-Unsubscribe": `<${config.apiBaseUrl}/api/email/unsubscribe?token=${token}>`,
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		},
	}
}

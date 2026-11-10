import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { StatusPageSubscriberId } from "@maple/primitives"
import { Option, Schema, String as Str } from "effect"

/** A confirmation token: emailed once, only its SHA-256 is stored. */
export const newConfirmToken = (): string => randomBytes(32).toString("base64url")

/**
 * Subkey for unsubscribe links, derived from an existing deployment secret so the links need no
 * new secret. The label keeps these signatures apart from the parent key's own HMACs and from the
 * digest's unsubscribe links.
 */
const deriveKey = (secret: string) =>
	createHmac("sha256", secret).update("maple/status-page-unsubscribe/v1").digest()

const sign = (secret: string, subscriberId: StatusPageSubscriberId) =>
	createHmac("sha256", deriveKey(secret)).update(subscriberId).digest()

/**
 * `<subscriberId>.<sig>`, never expiring: a link in an old email must keep working. Unsubscribing
 * deletes the row, so the token dies with it and a later subscription gets a new id.
 */
export const mintUnsubscribeToken = (secret: string, subscriberId: StatusPageSubscriberId): string =>
	`${subscriberId}.${sign(secret, subscriberId).toString("base64url")}`

const decodeSubscriberId = Schema.decodeUnknownOption(StatusPageSubscriberId)

export const verifyUnsubscribeToken = (
	secret: string,
	token: string,
): Option.Option<StatusPageSubscriberId> => {
	const [rawId, rawSig, ...rest] = Str.split(".")(token)
	if (rawId === undefined || rawSig === undefined || rest.length > 0) return Option.none()
	return Option.filter(decodeSubscriberId(rawId), (subscriberId) => {
		const expected = sign(secret, subscriberId)
		const actual = Buffer.from(rawSig, "base64url")
		return actual.length === expected.length && timingSafeEqual(actual, expected)
	})
}

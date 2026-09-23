/**
 * Proving a request came from Slack, before anything reads what it says.
 *
 * Pure and body-first: the caller hands over the RAW body text and this answers yes or no. Nothing
 * here parses JSON, and nothing downstream runs until it has answered yes — a signature checked
 * after the payload has been decoded and acted on is not a signature check.
 *
 * Slack's scheme, verified against its "Verifying requests from Slack" documentation: the base
 * string is `v0:{X-Slack-Request-Timestamp}:{raw body}`, the digest is HMAC-SHA256 keyed with the
 * app's Signing Secret, and `X-Slack-Signature` carries it as `v0=` plus lowercase hex.
 */
import { createHmac, timingSafeEqual } from "node:crypto"
import { MAX_TIMESTAMP_SKEW_SECONDS, SIGNATURE_VERSION } from "./api"

export type SignatureVerdict =
	| { readonly _tag: "ok" }
	/** Why it was refused, in words safe to put in a 401 body and on a span. Never the digest. */
	| { readonly _tag: "rejected"; readonly reason: string }

const OK: SignatureVerdict = { _tag: "ok" }

const rejected = (reason: string): SignatureVerdict => ({ _tag: "rejected", reason })

/** `v0=` followed by 64 lowercase hex characters, and nothing else. */
const SIGNATURE_PATTERN = new RegExp(`^${SIGNATURE_VERSION}=[0-9a-f]{64}$`)

export interface SignatureInput {
	readonly signature: string | undefined
	readonly timestamp: string | undefined
	readonly body: string
	readonly signingSecret: string
	/** Epoch MILLISECONDS, where Slack's header is seconds. The caller owns the clock. */
	readonly now: number
}

/**
 * Whether this request was signed by the app that holds this signing secret, recently.
 *
 * The two checks are deliberately in this order. The timestamp is rejected first because it costs
 * nothing and closes the replay: a body captured off the wire stays correctly signed forever, and
 * only its age says otherwise.
 */
export const verifySlackSignature = (input: SignatureInput): SignatureVerdict => {
	if (input.signature === undefined) return rejected("missing signature")
	if (input.timestamp === undefined) return rejected("missing timestamp")
	// Digits only: `Number` would accept `1e9`, ` 12`, `0x…` and `Infinity`, and a timestamp that
	// parses to something Slack would never send is a request to refuse, not one to interpret.
	if (!/^\d+$/.test(input.timestamp)) return rejected("malformed timestamp")
	const skew = Math.abs(input.now / 1000 - Number(input.timestamp))
	if (skew > MAX_TIMESTAMP_SKEW_SECONDS) return rejected("stale timestamp")
	// Checked before the compare so the constant-time compare gets two buffers of equal length; an
	// unequal-length `timingSafeEqual` throws, and catching that would leak the length through the
	// branch it takes.
	if (!SIGNATURE_PATTERN.test(input.signature)) return rejected("malformed signature")

	const expected = createHmac("sha256", input.signingSecret)
		.update(`${SIGNATURE_VERSION}:${input.timestamp}:${input.body}`, "utf8")
		.digest("hex")
	const matches = timingSafeEqual(
		Buffer.from(`${SIGNATURE_VERSION}=${expected}`, "utf8"),
		Buffer.from(input.signature, "utf8"),
	)
	return matches ? OK : rejected("signature mismatch")
}

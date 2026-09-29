// End-user feedback ("this page is broken"), as an OTel log event linked to
// the session and to the last error the user hit. Headless: bring your own UI.
import { getSession, hasConsent } from "@maple/browser-session"
import type { SpanContext } from "@opentelemetry/api"
import { onErrorRecorded } from "./errors"
import { emitLog, type LogAttributeValue, Severity } from "./logs"

export interface FeedbackInput {
	/** What the user wrote. Required; trimmed and capped at 5,000 characters. */
	readonly message: string
	/** Sent as `user.email` unless `privacy.captureUserEmail` is false. */
	readonly email?: string | undefined
	/** Sent as `user.name`. */
	readonly name?: string | undefined
	/** Extra attributes, e.g. `{ "feedback.category": "bug" }`. */
	readonly attributes?: Readonly<Record<string, LogAttributeValue>> | undefined
}

const MAX_MESSAGE = 5_000

let lastError: SpanContext | undefined
let captureEmail = true
/** Keeps a buffered replay; set by `init()`. */
let keepReplay: () => void = () => {}

// Module-level: the last error is whatever the user saw most recently, whichever `init()` recorded it.
onErrorRecorded((spanContext) => {
	lastError = spanContext
})

export function configureFeedback(options: {
	readonly captureUserEmail: boolean
	readonly keepReplay: () => void
}): void {
	captureEmail = options.captureUserEmail
	keepReplay = options.keepReplay
	// init() and shutdown() both start a new lifecycle: an earlier error's trace is not this one's.
	lastError = undefined
}

export function resetFeedbackForTests(): void {
	lastError = undefined
	captureEmail = true
	keepReplay = () => {}
}

/** Send feedback. Returns false when there was nothing to send (empty message, no consent). */
export function sendFeedback(input: FeedbackInput): boolean {
	const message = String(input.message ?? "")
		.trim()
		.slice(0, MAX_MESSAGE)
	if (!message || !hasConsent()) return false
	const email = captureEmail ? input.email?.trim() : undefined
	const name = input.name?.trim()
	// Keep a buffered replay first: the trigger marks the session recorded synchronously, so
	// `has_replay` then reflects the minute this feedback just kept.
	keepReplay()
	const recorded = typeof window === "undefined" ? false : getSession().replaySampled === true
	emitLog({
		eventName: "maple.user_feedback",
		severityNumber: Severity.INFO,
		severityText: "INFO",
		body: message,
		spanContext: lastError,
		attributes: {
			...input.attributes,
			...(email ? { "user.email": email } : undefined),
			...(name ? { "user.name": name } : undefined),
			...(lastError ? { "maple.feedback.error_trace_id": lastError.traceId } : undefined),
			"maple.feedback.has_replay": recorded,
		},
	})
	return true
}

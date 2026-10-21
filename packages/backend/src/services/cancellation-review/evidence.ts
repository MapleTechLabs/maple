/**
 * What the model reads besides the snapshot, cut down from its sources: the
 * Stripe cancellation survey, the org's browser sessions in Maple's own app,
 * and its audit log. Pure, so what the model is shown is asserted in a test.
 */
import type {
	CancellationAuditEntry,
	CancellationSessionDigest,
	CancellationStripeFeedback,
} from "@maple/domain/http"
import { DateTime, Option, Schema } from "effect"

/** Sessions the model sees, newest first. */
export const SESSIONS_SHOWN = 20
/** Sessions whose pages and errors are read: one transcript query each. */
export const SESSIONS_READ = 5
/** Events per session transcript. */
export const TRANSCRIPT_EVENTS = 60
/** Audit entries the model sees, newest first. */
export const AUDIT_ENTRIES_SHOWN = 40

const OptionalText = Schema.optionalKey(Schema.NullOr(Schema.String))

/** Only what is read off Stripe's subscription list, camelised by the client. */
const StripeSubscriptions = Schema.Struct({
	data: Schema.Array(
		Schema.Struct({
			created: Schema.Number,
			canceledAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
			cancellationDetails: Schema.optionalKey(
				Schema.NullOr(Schema.Struct({ feedback: OptionalText, comment: OptionalText })),
			),
		}),
	),
})

const decodeSubscriptions = Schema.decodeUnknownOption(StripeSubscriptions)

const text = (value: string | null | undefined): string | null => value?.trim() || null

/**
 * The survey answer and comment of the newest cancelled subscription, the one
 * being reviewed. Both null when the customer skipped it there or did not
 * cancel through Stripe's portal; an older subscription's answer is never used.
 */
export const stripeFeedbackOf = (response: unknown): CancellationStripeFeedback => {
	const newest = Option.getOrUndefined(decodeSubscriptions(response))
		?.data.filter((sub) => sub.canceledAt != null)
		.sort((a, b) => (b.canceledAt ?? 0) - (a.canceledAt ?? 0))[0]
	return {
		feedback: text(newest?.cancellationDetails?.feedback),
		comment: text(newest?.cancellationDetails?.comment),
	}
}

export interface SessionRow {
	readonly sessionId: string
	readonly startTime: DateTime.Utc
	readonly durationMs: number | null
	readonly quality: string
	readonly pageViews: number
	readonly clickCount: number
	readonly errorCount: number
}

/** Navigation and error events only; the rest would crowd the pages out of the cap. */
export interface TranscriptEvent {
	readonly type: string
	readonly url: string
	readonly message: string
}

const pathOf = (url: string): string => (URL.canParse(url) ? new URL(url).pathname : url)

/** Page paths in order, a reload or in-page navigation to the same path counted once. */
const pagesOf = (events: ReadonlyArray<TranscriptEvent>): ReadonlyArray<string> =>
	events
		.filter((event) => event.type === "navigation" && event.url !== "")
		.map((event) => pathOf(event.url))
		.filter((path, index, paths) => index === 0 || paths[index - 1] !== path)

export const digestSession = (
	row: SessionRow,
	events: ReadonlyArray<TranscriptEvent>,
): CancellationSessionDigest => ({
	startedAt: DateTime.formatIso(row.startTime),
	durationMs: row.durationMs,
	quality: row.quality,
	pageViews: row.pageViews,
	clicks: row.clickCount,
	errors: row.errorCount,
	pages: pagesOf(events),
	problems: [
		...new Set(
			events.filter((event) => event.type === "error").map((event) => event.message.slice(0, 200)),
		),
	].slice(0, 10),
})

export interface AuditRow {
	readonly action: string
	readonly actorType: string
	readonly outcome: string
	readonly occurredAt: Date
}

export const auditEntryOf = (row: AuditRow): CancellationAuditEntry => ({
	at: row.occurredAt.toISOString(),
	action: row.action,
	actor: row.actorType,
	outcome: row.outcome,
})

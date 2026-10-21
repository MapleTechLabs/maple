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
import { DateTime, Effect, Schema } from "effect"

/** Sessions the model sees, newest first. */
export const SESSIONS_SHOWN = 20
/** Sessions whose pages and errors are read: two transcript queries each. */
export const SESSIONS_READ = 5
/** The last page visits and problems of a session: its end is where a user gives up. */
export const TRANSCRIPT_PAGES = 40
export const TRANSCRIPT_PROBLEMS = 30
/** Audit entries the model sees, newest first, and how many are read to find them among reads. */
export const AUDIT_ENTRIES_SHOWN = 40
export const AUDIT_ENTRIES_READ = 200
/** A Stripe cancellation this far from the reviewed one is another cancellation. */
const SAME_CANCELLATION_MS = 2 * 86_400_000

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

const decodeSubscriptions = Schema.decodeUnknownEffect(StripeSubscriptions)

/** Free text goes to a third-party model: no addresses in it. */
const redact = (value: string): string => value.replaceAll(/[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}/gi, "[email]")

const text = (value: string | null | undefined): string | null => {
	const trimmed = value?.trim()
	return trimmed ? redact(trimmed) : null
}

/**
 * The survey answer and comment of the Stripe cancellation being reviewed: the
 * subscription cancelled within two days of it. Both null when the customer
 * skipped the survey or cancelled outside Stripe's portal; an earlier
 * cancellation's answer is never used. Fails on a body it cannot read.
 */
export const stripeFeedbackOf = (response: unknown, canceledAtMs: number) =>
	decodeSubscriptions(response).pipe(
		Effect.map(({ data }): CancellationStripeFeedback => {
			const match = data
				.filter(
					(sub) =>
						sub.canceledAt != null &&
						Math.abs(sub.canceledAt * 1000 - canceledAtMs) <= SAME_CANCELLATION_MS,
				)
				// A plan and an add-on cancelled together: the one closest to the reviewed time.
				.sort(
					(a, b) =>
						Math.abs((a.canceledAt ?? 0) * 1000 - canceledAtMs) -
						Math.abs((b.canceledAt ?? 0) * 1000 - canceledAtMs),
				)[0]
			return {
				feedback: text(match?.cancellationDetails?.feedback),
				comment: text(match?.cancellationDetails?.comment),
			}
		}),
	)

export interface SessionRow {
	readonly sessionId: string
	readonly startTime: DateTime.Utc
	readonly durationMs: number | null
	readonly quality: string
	readonly pageViews: number
	readonly clickCount: number
}

export interface TranscriptEvent {
	readonly type: string
	readonly url: string
	readonly message: string
	readonly netMethod: string
	readonly netUrl: string
	readonly netStatus: number
}

const pathOf = (url: string): string => (URL.canParse(url) ? new URL(url).pathname : url)

/** Page paths in order, a reload or in-page navigation to the same path counted once. */
const pagesOf = (events: ReadonlyArray<TranscriptEvent>): ReadonlyArray<string> =>
	events
		.filter((event) => event.type === "navigation" && event.url !== "")
		.map((event) => pathOf(event.url))
		.filter((path, index, paths) => index === 0 || paths[index - 1] !== path)

/** An error event, a console error or a failed request, in a line. */
const problemOf = (event: TranscriptEvent): string =>
	event.type === "network"
		? redact(`${event.netMethod} ${pathOf(event.netUrl)} failed with ${event.netStatus}`)
		: redact(event.message).slice(0, 200)

/**
 * Problems of Maple's own app rather than the customer's: its telemetry SDK
 * failing to ship (an ad blocker, a dropped connection) and the live-sync
 * stream's routine 409 when a shape must be refetched.
 */
const isOwnNoise = (event: TranscriptEvent): boolean =>
	event.message.startsWith("[MapleClientSDK]") ||
	(event.type === "network" && event.netStatus === 409 && pathOf(event.netUrl).endsWith("/sync/shape"))

/** `pages` and `problems` are the session's last events of each kind, oldest first. */
export const digestSession = (
	row: SessionRow,
	pages: ReadonlyArray<TranscriptEvent>,
	problems: ReadonlyArray<TranscriptEvent>,
): CancellationSessionDigest => ({
	startedAt: DateTime.formatIso(row.startTime),
	durationMs: row.durationMs,
	quality: row.quality,
	pageViews: row.pageViews,
	clicks: row.clickCount,
	pages: pagesOf(pages),
	problems: [...new Set(problems.filter((event) => !isOwnNoise(event)).map(problemOf))].slice(-10),
})

export interface AuditRow {
	readonly action: string
	readonly actorType: string
	readonly outcome: string
	readonly occurredAt: Date
}

/**
 * Reads, tool calls, SQL runs and refused requests record access, not a
 * change; a dashboard's SQL widgets alone would crowd every change out.
 */
export const isAuditedChange = (row: AuditRow): boolean =>
	!/\.(read|called|sql_executed|request)$/.test(row.action)

export const auditEntryOf = (row: AuditRow): CancellationAuditEntry => ({
	at: row.occurredAt.toISOString(),
	action: row.action,
	actor: row.actorType,
	outcome: row.outcome,
})

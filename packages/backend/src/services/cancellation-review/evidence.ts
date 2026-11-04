/**
 * What the model reads besides the snapshot, cut down from its sources: the
 * Stripe cancellation survey, the org's browser sessions in Maple's own app,
 * its audit log and the members' other orgs. Pure, so what the model is shown is asserted in a test.
 */
import type {
	CancellationAuditEntry,
	CancellationOtherOrgs,
	CancellationSessionDigest,
	CancellationStripeFeedback,
} from "@maple/domain/http"
import { DateTime, Effect, Schema, Array as Arr, String as Str } from "effect"
import { reviewedSubscriptionOf } from "./evidence-billing"
import { holdsName, memberNameWords } from "./evidence-company"
import { OTHER_ORGS_SHOWN } from "./slack-message"
import { daysBeforeCancel, redactText } from "./evidence-input"

const PROBLEM_CHARS = 200

/** Sessions the model sees, newest first. */
export const SESSIONS_SHOWN = 20
/** Sessions whose pages and errors are read: two transcript queries each. */
export const SESSIONS_READ = 5
/** The last page visits and problems of a session: its end is where a user gives up. */
export const TRANSCRIPT_PAGES = 40
export const TRANSCRIPT_PROBLEMS = 30
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

const decodeSubscriptions = Schema.decodeUnknownEffect(StripeSubscriptions)

/** Stripe caps a comment at 5,000 characters; the report quotes far less. */
const COMMENT_CHARS = 1_000

/**
 * The customer's own words to Stripe: addresses out, a link kept, since it
 * may name where they went.
 */
const text = (value: string | null | undefined): string | null => {
	const full = value === null || value === undefined ? undefined : Str.trim(value)
	// The cut can split an address: the word it cut into is dropped, never half-scrubbed.
	const cut =
		full === undefined || full.length <= COMMENT_CHARS
			? full
			: Str.replace(/\S*$/, "")(Str.slice(0, COMMENT_CHARS)(full))
	return cut ? Str.replaceAll(/[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}/gi, "[email]")(cut) : null
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
			const match = reviewedSubscriptionOf(data, canceledAtMs)
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
const pagesOf = (events: ReadonlyArray<TranscriptEvent>): ReadonlyArray<string> => {
	const paths = Arr.map(
		Arr.filter(events, (event) => event.type === "navigation" && event.url !== ""),
		(event) => pathOf(event.url),
	)
	return Arr.filter(paths, (path, index) => index === 0 || paths[index - 1] !== path)
}

/** An error event, a console error or a failed request, in a line. */
const problemOf = (event: TranscriptEvent): string =>
	event.type === "network"
		? redactText(
				`${event.netMethod} ${pathOf(event.netUrl)} failed with ${event.netStatus}`,
				PROBLEM_CHARS,
			)
		: redactText(event.message, PROBLEM_CHARS)

/**
 * Problems of Maple's own app rather than the customer's: its telemetry SDK
 * failing to ship (an ad blocker, a dropped connection) and the live-sync
 * stream's routine 409 when a shape must be refetched.
 */
const isOwnNoise = (event: TranscriptEvent): boolean =>
	Str.startsWith("[MapleClientSDK]")(event.message) ||
	(event.type === "network" && event.netStatus === 409 && Str.endsWith("/sync/shape")(pathOf(event.netUrl)))

/** `pages` and `problems` are the session's last events of each kind, oldest first. */
export const digestSession = (
	atMs: number,
	row: SessionRow,
	pages: ReadonlyArray<TranscriptEvent>,
	problems: ReadonlyArray<TranscriptEvent>,
): CancellationSessionDigest => ({
	startedAt: DateTime.formatIso(row.startTime),
	daysBeforeCancel: daysBeforeCancel(atMs, DateTime.toEpochMillis(row.startTime)),
	durationMs: row.durationMs,
	quality: row.quality,
	pageViews: row.pageViews,
	clicks: row.clickCount,
	pages: pagesOf(pages),
	problems: [
		...new Set(
			Arr.map(
				Arr.filter(problems, (event) => !isOwnNoise(event)),
				problemOf,
			),
		),
	].slice(-10),
})

export interface AuditRow {
	readonly action: string
	readonly actorType: string
	readonly outcome: string
	readonly occurredAt: Date
}

export const auditEntryOf = (atMs: number, row: AuditRow): CancellationAuditEntry => ({
	at: row.occurredAt.toISOString(),
	daysBeforeCancel: daysBeforeCancel(atMs, row.occurredAt.getTime()),
	action: row.action,
	actor: row.actorType,
	outcome: row.outcome,
})

export interface OtherOrgRow {
	readonly name: string
	readonly createdAtMs: number
	readonly membersCount: number | null
	readonly sharedMembers: ReadonlyArray<string>
	readonly billing: { readonly plan: string | null } | null
}

/**
 * The members' other orgs without the people: shared members as a count, and
 * a name holding a member's name left out. `orgs` is newest first; the model
 * sees the same few the report lists.
 */
export const otherOrgsOf = (
	atMs: number,
	orgs: ReadonlyArray<OtherOrgRow>,
	members: ReadonlyArray<{ readonly email: string; readonly name?: string | null }>,
): CancellationOtherOrgs => {
	const nameWords = memberNameWords(
		Arr.map(members, (member) => member.email),
		Arr.map(members, (member) => member.name ?? null),
	)
	return {
		total: orgs.length,
		orgs: Arr.map(orgs.slice(0, OTHER_ORGS_SHOWN), (org) => {
			const nameIsPersonal = holdsName(org.name, nameWords)
			return {
				name: nameIsPersonal ? null : org.name,
				nameIsPersonal,
				createdDaysBeforeCancel: daysBeforeCancel(atMs, org.createdAtMs),
				members: org.membersCount,
				sharedMembers: org.sharedMembers.length,
				billing: org.billing,
			}
		}),
	}
}

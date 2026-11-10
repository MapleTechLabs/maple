/**
 * The cancellation review: what an org's own usage says about why it is leaving
 * a plan, gathered once when Autumn reports the cancellation.
 *
 * The snapshot is numbers and flags only. Names and addresses stay on the side
 * that posts the report; nothing here identifies a person, so the snapshot is
 * stored as it is. The evidence sections the model reads besides it are in
 * `./cancellation-evidence/`.
 */
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { CancellationAppEvidence } from "./cancellation-evidence/app"
import { CancellationBillingEvidence } from "./cancellation-evidence/billing"
import { CancellationCompanyEvidence } from "./cancellation-evidence/company"
import { CancellationTelemetryEvidence } from "./cancellation-evidence/telemetry"
import {
	CancellationModelRead,
	CancellationReason,
	CancellationSnapshot,
	Count,
} from "../cancellation-review"
export {
	CancellationCompanyConfidence,
	CancellationCompanyGuess,
	CancellationModelCategory,
	CancellationModelRead,
	CancellationModelVerdict,
	CancellationPhase,
	CancellationReason,
	CancellationSnapshot,
	CancellationVisits,
	CancellationVolume,
} from "../cancellation-review"

/**
 * What Stripe recorded when the customer cancelled through its portal: the
 * survey answer (`too_expensive`, `missing_features`, ...) and the free-text
 * comment. Both null when the customer skipped them or cancelled elsewhere.
 */
export const CancellationStripeFeedback = Schema.Struct({
	feedback: Schema.NullOr(Schema.String),
	comment: Schema.NullOr(Schema.String),
})
export type CancellationStripeFeedback = Schema.Schema.Type<typeof CancellationStripeFeedback>

/** One of the org's browser sessions in Maple's own app, reduced to what a reader skims. */
export const CancellationSessionDigest = Schema.Struct({
	startedAt: Schema.String,
	/** Whole days before the cancellation the session started; 0 the same day, negative after. */
	daysBeforeCancel: Schema.Int,
	durationMs: Schema.NullOr(Count),
	/** `engaged`, `glance`, `idle` or `bounce`. */
	quality: Schema.String,
	pageViews: Count,
	clicks: Count,
	/** The session's last page paths in visit order, consecutive repeats collapsed. Empty when not read. */
	pages: Schema.Array(Schema.String),
	/** The session's last errors and failed requests, deduplicated. */
	problems: Schema.Array(Schema.String),
})
export type CancellationSessionDigest = Schema.Schema.Type<typeof CancellationSessionDigest>

/** One audit-log entry of the org, as the reader sees it. */
export const CancellationAuditEntry = Schema.Struct({
	at: Schema.String,
	/** Whole days before the cancellation; 0 the same day. */
	daysBeforeCancel: Schema.Int,
	action: Schema.String,
	/** `user`, `api_key`, ...: the kind, never a name or email, which the model has no use for. */
	actor: Schema.String,
	outcome: Schema.String,
})
export type CancellationAuditEntry = Schema.Schema.Type<typeof CancellationAuditEntry>

/** Another Maple org some of this org's members also belong to. */
export const CancellationOtherOrg = Schema.Struct({
	/** The org's name; null when it holds a member's name. */
	name: Schema.NullOr(Schema.String),
	/** The name was left out because it holds a member's name ("Jane's Org"). */
	nameIsPersonal: Schema.Boolean,
	/** Whole days from the org's creation to the cancellation; negative when created after it. */
	createdDaysBeforeCancel: Schema.Int,
	/** Its members now; null when Clerk did not say. */
	members: Schema.NullOr(Count),
	/** Of this org's members, how many are also in that one. */
	sharedMembers: Count,
	/** Its active plan now (`plan: null` for none); null when Autumn was not read for it. */
	billing: Schema.NullOr(Schema.Struct({ plan: Schema.NullOr(Schema.String) })),
})
export type CancellationOtherOrg = Schema.Schema.Type<typeof CancellationOtherOrg>

/** The orgs this org's members also belong to, newest first. */
export const CancellationOtherOrgs = Schema.Struct({
	/** Every such org found, including ones not listed. */
	total: Count,
	/** The newest few. */
	orgs: Schema.Array(CancellationOtherOrg),
})
export type CancellationOtherOrgs = Schema.Schema.Type<typeof CancellationOtherOrgs>

/**
 * Everything the model reads next to the rules' conclusion. Nothing in it names
 * a person; `company` names the business, so the model can say who it is.
 * Every evidence section is null when it could not be read.
 */
export class CancellationModelRequest extends Schema.Class<CancellationModelRequest>(
	"CancellationModelRequest",
)({
	snapshot: CancellationSnapshot,
	ruleReason: CancellationReason,
	/** The rules' own sentences about the snapshot. */
	signals: Schema.Array(Schema.String),
	/** Null when Stripe could not be read; both fields null when the customer gave nothing. */
	stripeFeedback: Schema.NullOr(CancellationStripeFeedback),
	/** Newest first. */
	sessions: Schema.NullOr(Schema.Array(CancellationSessionDigest)),
	/** Changes only, newest first. */
	auditLog: Schema.NullOr(Schema.Array(CancellationAuditEntry)),
	company: Schema.NullOr(CancellationCompanyEvidence),
	billing: Schema.NullOr(CancellationBillingEvidence),
	app: Schema.NullOr(CancellationAppEvidence),
	telemetry: Schema.NullOr(CancellationTelemetryEvidence),
	/** Null when the members' orgs could not be read; `total: 0` when every member is only in this one. */
	otherOrgs: Schema.NullOr(CancellationOtherOrgs),
}) {}

export class CancellationReadUnauthorizedError extends Schema.TaggedError<CancellationReadUnauthorizedError>()(
	"@maple/http/errors/CancellationReadUnauthorizedError",
	{ message: Schema.String },
	{ httpApiStatus: 401 },
) {}

/** The model did not answer, or answered something unusable. The report goes out without it. */
export class CancellationReadModelError extends Schema.TaggedError<CancellationReadModelError>()(
	"@maple/http/errors/CancellationReadModelError",
	{ message: Schema.String },
	{ httpApiStatus: 502 },
) {}

/** Worker-to-Worker only: api asks maple-ai for a second read of a cancellation. */
export class CancellationReadApiGroup extends HttpApiGroup.make("cancellationReview")
	.add(
		HttpApiEndpoint.post("read", "/read", {
			headers: Schema.Struct({ authorization: Schema.String }),
			payload: CancellationModelRequest,
			success: CancellationModelRead,
			error: [CancellationReadUnauthorizedError, CancellationReadModelError],
		}),
	)
	.prefix("/internal/cancellation-review") {}

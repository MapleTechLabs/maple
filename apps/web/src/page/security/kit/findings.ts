import type { SecurityAuditFinding, SecurityAuditRunFindingCounts } from "@maple/domain/http"
import { Schema } from "effect"

// Findings by what to fix first: a confirmed finding under its severity, a lead under its estimated
// one, and an unscored lead or a disproved claim under its verdict.

export const SeverityBucket = Schema.Literals([
	"critical",
	"high",
	"medium",
	"low",
	"informational",
	"needs_validation",
	"rejected",
])
export type SeverityBucket = typeof SeverityBucket.Type

export const SEVERITY_BUCKETS: ReadonlyArray<SeverityBucket> = SeverityBucket.literals

/** The buckets a tile or a count shows: every one but the disproved. */
export const SCORED_BUCKETS = SEVERITY_BUCKETS.filter((bucket) => bucket !== "rejected")

export const BUCKET_LABEL = {
	critical: "Critical",
	high: "High",
	medium: "Medium",
	low: "Low",
	informational: "Info",
	needs_validation: "Needs validation",
	rejected: "Rejected",
} satisfies Record<SeverityBucket, string>

/** A lead the engine scored from source but nothing has proven yet. */
export const isUnverified = (finding: SecurityAuditFinding): boolean =>
	finding.verdict === "needs_validation" && finding.estimatedSeverity !== null

/** A confirmed finding by its severity (unscored reads as informational, as the counts API files
 * it), a scored lead by its estimate; an unscored lead or a disproved claim by its verdict. */
export const bucketOf = (finding: SecurityAuditFinding): SeverityBucket =>
	finding.verdict === "confirmed"
		? (finding.overallSeverity ?? "informational")
		: isUnverified(finding) && finding.estimatedSeverity !== null
			? finding.estimatedSeverity
			: finding.verdict

export type BucketCounts = Readonly<Record<SeverityBucket, number>>

const ZERO = {
	critical: 0,
	high: 0,
	medium: 0,
	low: 0,
	informational: 0,
	needs_validation: 0,
	rejected: 0,
} satisfies BucketCounts

export const countByBucket = (findings: ReadonlyArray<SecurityAuditFinding>): BucketCounts =>
	findings.reduce<BucketCounts>((counts, finding) => {
		const bucket = bucketOf(finding)
		return { ...counts, [bucket]: counts[bucket] + 1 }
	}, ZERO)

export const countsFromRun = (counts: SecurityAuditRunFindingCounts): BucketCounts => ({
	critical: counts.critical,
	high: counts.high,
	medium: counts.medium,
	low: counts.low,
	informational: counts.informational,
	needs_validation: counts.needsValidation,
	rejected: counts.rejected,
})

export type FindingSection = Readonly<{
	bucket: SeverityBucket
	rows: ReadonlyArray<SecurityAuditFinding>
}>

/** Non-empty sections, most severe first; within one, proven before unverified, then the most
 * recently seen first. */
export const sectionsOf = (findings: ReadonlyArray<SecurityAuditFinding>): ReadonlyArray<FindingSection> =>
	SEVERITY_BUCKETS.map((bucket) => ({
		bucket,
		rows: findings
			.filter((finding) => bucketOf(finding) === bucket)
			.toSorted(
				(a, b) =>
					Number(isUnverified(a)) - Number(isUnverified(b)) ||
					b.updatedAt - a.updatedAt ||
					a.fingerprint.localeCompare(b.fingerprint),
			),
	})).filter((section) => section.rows.length > 0)

/** The model's confidence in a confirmed finding; leads and rejections carry none. */
export const confidenceOf = (finding: SecurityAuditFinding): "low" | "medium" | "high" | null =>
	finding.record.verdict === "confirmed" ? finding.record.confidence.score : null

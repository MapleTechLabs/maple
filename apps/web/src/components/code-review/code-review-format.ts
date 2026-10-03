import type {
	CodeReviewListItem,
	PrReviewCategory,
	PrReviewFindingStatus,
	PrReviewSeverity,
	PrReviewSkipReason,
} from "@maple/domain/http"

export const CATEGORY_LABELS = {
	correctness: "Correctness",
	security: "Security",
	performance: "Performance",
	observability: "Observability",
	convention: "Conventions",
	tests: "Tests",
	maintainability: "Maintainability",
} satisfies Record<PrReviewCategory, string>

export const SEVERITY_LABELS = {
	critical: "Critical",
	warn: "Warning",
	info: "Note",
} satisfies Record<PrReviewSeverity, string>

/** Text tones for a severity, from the shared severity tokens. */
export const SEVERITY_TONES = {
	critical: "text-[var(--severity-error)]",
	warn: "text-[var(--severity-warn)]",
	info: "text-muted-foreground",
} satisfies Record<PrReviewSeverity, string>

export const FINDING_STATUS_LABELS = {
	open: "Open",
	resolved: "Resolved",
	dismissed: "Dismissed",
} satisfies Record<PrReviewFindingStatus, string>

export const SKIP_LABELS = {
	disabled: "reviews off",
	draft: "draft",
	bot_author: "bot author",
	action: "not reviewed for this event",
	no_head_sha: "no head commit",
	quota: "daily limit reached",
	duplicate: "already reviewed",
	superseded: "a newer push was reviewed",
	agent_unavailable: "reviewer unavailable",
	not_rolled_out: "not enabled for this organization",
	automatic_limit: "pull request limit reached",
} satisfies Record<PrReviewSkipReason, string>

const COUNT = new Intl.NumberFormat("en-US")
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })

export const formatCount = (value: number) => (value >= 10_000 ? COMPACT.format(value) : COUNT.format(value))

/** A span in the largest unit that keeps it readable: `42s`, `14m`, `5.2h`, `7.0d`. */
export function formatSpan(seconds: number | null): string {
	if (seconds === null || !Number.isFinite(seconds)) return "–"
	if (seconds < 60) return `${Math.round(seconds)}s`
	if (seconds < 3_600) return `${Math.round(seconds / 60)}m`
	if (seconds < 86_400) return `${(seconds / 3_600).toFixed(1)}h`
	return `${(seconds / 86_400).toFixed(1)}d`
}

export interface Delta {
	/** Signed fraction, e.g. -0.6 for "60% fewer". */
	readonly change: number
	/** Whether the move is the good direction for this number. */
	readonly good: boolean
}

/**
 * Change against the previous window. Null with nothing to compare against: a jump from zero is
 * not a percentage anyone can read.
 */
export function deltaOf(
	current: number | null,
	previous: number | null,
	higherIsBetter: boolean,
): Delta | null {
	if (current === null || previous === null || previous === 0) return null
	const change = (current - previous) / previous
	if (!Number.isFinite(change)) return null
	return { change, good: change === 0 || change > 0 === higherIsBetter }
}

export const formatDelta = (delta: Delta) =>
	`${delta.change > 0 ? "+" : ""}${Math.round(delta.change * 100)}%`

export interface ReviewOutcome {
	readonly label: string
	readonly tone: string
	readonly kind: "queued" | "running" | "failed" | "skipped" | "issues" | "clean" | "neutral"
}

export const outcomeOf = (review: Pick<CodeReviewListItem, "status" | "verdict">): ReviewOutcome => {
	switch (review.status) {
		case "queued":
			return { label: "Queued", tone: "text-muted-foreground", kind: "queued" }
		case "running":
			return { label: "Reviewing", tone: "text-info-foreground", kind: "running" }
		case "failed":
			return { label: "Failed", tone: "text-destructive-foreground", kind: "failed" }
		case "skipped":
			return { label: "Skipped", tone: "text-muted-foreground", kind: "skipped" }
		case "completed":
			return review.verdict === "issues"
				? { label: "Issues found", tone: "text-warning-foreground", kind: "issues" }
				: review.verdict === "not_applicable"
					? { label: "Nothing to review", tone: "text-muted-foreground", kind: "neutral" }
					: { label: "Clean", tone: "text-success-foreground", kind: "clean" }
	}
}

/** Bucket starts as the ISO strings the shared charts parse. */
export const bucketIso = (bucketMs: number) => new Date(bucketMs).toISOString()

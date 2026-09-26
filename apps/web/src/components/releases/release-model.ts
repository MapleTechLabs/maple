// Pure derivations for the Releases pages. Kept free of React so the
// thresholds unit-test cleanly and the list, the swimlanes and the detail page
// all describe a release the same way.

import { startOfDayInTimeZone } from "@maple/query-engine/datetime"
import { toEpochMs } from "@maple/ui/lib/time-format"
import type { Release, ReleaseTimelineBucket } from "@/api/warehouse/releases"

/**
 * Health, worst first. A single band per release so the sidebar facet and the
 * row pill never disagree.
 *
 * - `regressed`: this version errors at least twice as often as the version it
 *   replaced on the same service, by a margin that cannot be rounding noise.
 * - `watch`: p95 is up by a quarter or more against that previous version.
 * - `rolling`: the newest version of its service, still short of carrying the
 *   whole of the last bucket's traffic.
 * - `healthy`: none of the above, with enough traffic to say so.
 */
export type ReleaseHealth = "regressed" | "watch" | "rolling" | "healthy"

export const RELEASE_HEALTH_ORDER: ReadonlyArray<ReleaseHealth> = ["regressed", "watch", "rolling", "healthy"]

export function isReleaseHealth(value: string): value is ReleaseHealth {
	return (RELEASE_HEALTH_ORDER as ReadonlyArray<string>).includes(value)
}

// Same constants as the services table's deploy cell, so a release the list
// calls regressed is one the services page flags "errors ↑ since deploy".
export const MIN_COMPARE_SPANS = 50
const ERROR_RATIO_THRESHOLD = 2
const ERROR_RATE_MIN_DIFF = 0.005
const P95_DELTA_THRESHOLD = 0.25
/** Below this share of the last bucket, the newest version is still rolling out. */
export const ROLLOUT_COMPLETE_SHARE = 0.9

/**
 * The version this one replaced: the previous first-seen on the same (service,
 * environment). Measured over its own lifetime in the window, so a service that
 * deploys hourly compares hour against hour, not against the whole week.
 */
export interface ReleaseBaseline {
	commitSha: string
	firstSeen: string
	spanCount: number
	errorCount: number
	errorRate: number
	p50LatencyMs: number
	p95LatencyMs: number
	p99LatencyMs: number
	apdexScore: number
}

/** One (service, environment) slice of a release, with its impact derived. */
export interface ReleaseServiceImpact {
	serviceName: string
	environment: string
	commitSha: string
	firstSeen: string
	spanCount: number
	errorCount: number
	errorRate: number
	p50LatencyMs: number
	p95LatencyMs: number
	p99LatencyMs: number
	apdexScore: number
	/** The previous version; undefined for the oldest version of the service in the window. */
	baseline: ReleaseBaseline | undefined
	/** `errorRate / baseline.errorRate`, only when both sides clear the span floor. */
	errorRatio: number | undefined
	/** `(p95 - baseline.p95) / baseline.p95`, under the same floor. */
	p95Delta: number | undefined
	/** Share of the service's traffic in the last bucket it reported; 0 once replaced. */
	share: number | undefined
	/** True when no other version of the service has a later first-seen. */
	isNewest: boolean
	health: ReleaseHealth
}

/** One commit across every service it landed on. */
export interface ReleaseGroup {
	commitSha: string
	/** Earliest first-seen across services. */
	firstSeen: string
	services: ReleaseServiceImpact[]
	spanCount: number
	errorCount: number
	errorRate: number
	health: ReleaseHealth
}

const rate = (errors: number, spans: number) => (spans > 0 ? errors / spans : 0)

function worstHealth(values: ReadonlyArray<ReleaseHealth>): ReleaseHealth {
	for (const band of RELEASE_HEALTH_ORDER) if (values.includes(band)) return band
	return "healthy"
}

function serviceKey(serviceName: string, environment: string): string {
	return `${serviceName} ${environment}`
}

/**
 * Share of each (service, environment, commit) in the last bucket that
 * service reported. A version absent from that bucket has been replaced and
 * reads 0; a service with no timeline rows yields no entry at all.
 */
export function lastBucketShares(timeline: ReadonlyArray<ReleaseTimelineBucket>): Map<string, number> {
	const lastBucket = new Map<string, string>()
	for (const point of timeline) {
		const current = lastBucket.get(point.serviceName)
		if (current === undefined || point.bucket > current) lastBucket.set(point.serviceName, point.bucket)
	}
	const totals = new Map<string, number>()
	const counts = new Map<string, number>()
	for (const point of timeline) {
		if (lastBucket.get(point.serviceName) !== point.bucket) continue
		totals.set(point.serviceName, (totals.get(point.serviceName) ?? 0) + point.count)
		counts.set(`${point.serviceName} ${point.commitSha}`, point.count)
	}
	const shares = new Map<string, number>()
	for (const [serviceName, total] of totals) {
		if (total <= 0) continue
		for (const point of timeline) {
			if (point.serviceName !== serviceName) continue
			const key = `${serviceName} ${point.commitSha}`
			shares.set(key, (counts.get(key) ?? 0) / total)
		}
	}
	return shares
}

function deriveHealth(impact: Omit<ReleaseServiceImpact, "health">): ReleaseHealth {
	if (
		impact.errorRatio !== undefined &&
		impact.baseline !== undefined &&
		impact.errorRatio >= ERROR_RATIO_THRESHOLD &&
		impact.errorRate - impact.baseline.errorRate >= ERROR_RATE_MIN_DIFF
	) {
		return "regressed"
	}
	if (impact.p95Delta !== undefined && impact.p95Delta >= P95_DELTA_THRESHOLD) return "watch"
	// The same floor as the comparisons: a dozen spans on a brand-new version
	// is a canary's first minute, not a rollout worth a band.
	if (
		impact.isNewest &&
		impact.spanCount >= MIN_COMPARE_SPANS &&
		impact.share !== undefined &&
		impact.share > 0 &&
		impact.share < ROLLOUT_COMPLETE_SHARE &&
		impact.baseline !== undefined
	) {
		return "rolling"
	}
	return "healthy"
}

/**
 * Derive every release's impact from the per-(service, env, commit) rows and
 * the timeline. Each version is compared against the one it replaced; the
 * oldest version of a service in the window has no baseline and reads healthy.
 */
export function deriveReleaseImpacts(
	releases: ReadonlyArray<Release>,
	timeline: ReadonlyArray<ReleaseTimelineBucket>,
): ReleaseServiceImpact[] {
	const byService = new Map<string, Release[]>()
	for (const release of releases) {
		const key = serviceKey(release.serviceName, release.environment)
		const rows = byService.get(key)
		if (rows === undefined) byService.set(key, [release])
		else rows.push(release)
	}
	const shares = lastBucketShares(timeline)

	const impacts: ReleaseServiceImpact[] = []
	for (const rows of byService.values()) {
		const ordered = rows.toSorted(compareFirstSeen)
		const newestFirstSeen = ordered.at(-1)?.firstSeen ?? ""
		for (const row of rows) {
			// Strictly earlier: versions first seen in the same second have no known
			// order, so neither is the other's predecessor.
			const previous = ordered.findLast((candidate) => candidate.firstSeen < row.firstSeen)
			const baseline = previous === undefined ? undefined : toBaseline(previous)
			const errorRate = rate(row.errorCount, row.spanCount)
			const comparable =
				baseline !== undefined &&
				row.spanCount >= MIN_COMPARE_SPANS &&
				baseline.spanCount >= MIN_COMPARE_SPANS
			const errorRatio =
				comparable && baseline !== undefined
					? baseline.errorRate > 0
						? errorRate / baseline.errorRate
						: errorRate > 0
							? Number.POSITIVE_INFINITY
							: 1
					: undefined
			const p95Delta =
				comparable && baseline !== undefined && baseline.p95LatencyMs > 0
					? (row.p95LatencyMs - baseline.p95LatencyMs) / baseline.p95LatencyMs
					: undefined
			const partial: Omit<ReleaseServiceImpact, "health"> = {
				serviceName: row.serviceName,
				environment: row.environment,
				commitSha: row.commitSha,
				firstSeen: row.firstSeen,
				spanCount: row.spanCount,
				errorCount: row.errorCount,
				errorRate,
				p50LatencyMs: row.p50LatencyMs,
				p95LatencyMs: row.p95LatencyMs,
				p99LatencyMs: row.p99LatencyMs,
				apdexScore: row.apdexScore,
				baseline,
				errorRatio,
				p95Delta,
				share: shares.get(`${row.serviceName} ${row.commitSha}`),
				isNewest: row.firstSeen === newestFirstSeen,
			}
			impacts.push({ ...partial, health: deriveHealth(partial) })
		}
	}
	return impacts
}

const compareFirstSeen = (a: { firstSeen: string }, b: { firstSeen: string }) =>
	a.firstSeen < b.firstSeen ? -1 : a.firstSeen > b.firstSeen ? 1 : 0

function toBaseline(row: Release): ReleaseBaseline {
	return {
		commitSha: row.commitSha,
		firstSeen: row.firstSeen,
		spanCount: row.spanCount,
		errorCount: row.errorCount,
		errorRate: rate(row.errorCount, row.spanCount),
		p50LatencyMs: row.p50LatencyMs,
		p95LatencyMs: row.p95LatencyMs,
		p99LatencyMs: row.p99LatencyMs,
		apdexScore: row.apdexScore,
	}
}

/** Fold per-service impacts into one group per commit, newest first. */
export function groupReleases(impacts: ReadonlyArray<ReleaseServiceImpact>): ReleaseGroup[] {
	const bySha = new Map<string, ReleaseServiceImpact[]>()
	for (const impact of impacts) {
		const list = bySha.get(impact.commitSha)
		if (list === undefined) bySha.set(impact.commitSha, [impact])
		else list.push(impact)
	}
	const groups: ReleaseGroup[] = []
	for (const [commitSha, services] of bySha) {
		const sorted = services.toSorted((a, b) => b.spanCount - a.spanCount)
		const spanCount = sorted.reduce((sum, s) => sum + s.spanCount, 0)
		const errorCount = sorted.reduce((sum, s) => sum + s.errorCount, 0)
		groups.push({
			commitSha,
			firstSeen: sorted.reduce(
				(min, s) => (s.firstSeen < min ? s.firstSeen : min),
				sorted[0]!.firstSeen,
			),
			services: sorted,
			spanCount,
			errorCount,
			errorRate: rate(errorCount, spanCount),
			health: worstHealth(sorted.map((s) => s.health)),
		})
	}
	return groups.toSorted((a, b) => (a.firstSeen < b.firstSeen ? 1 : a.firstSeen > b.firstSeen ? -1 : 0))
}

export interface ReleaseFacetCounts {
	health: Record<ReleaseHealth, number>
	services: Array<{ name: string; count: number }>
	environments: Array<{ name: string; count: number }>
}

/** Sidebar counts, from the same groups the table renders. */
export function releaseFacetCounts(groups: ReadonlyArray<ReleaseGroup>): ReleaseFacetCounts {
	const health = { regressed: 0, watch: 0, rolling: 0, healthy: 0 } satisfies Record<ReleaseHealth, number>
	const services = new Map<string, number>()
	const environments = new Map<string, number>()
	for (const group of groups) {
		health[group.health] += 1
		for (const service of group.services) {
			services.set(service.serviceName, (services.get(service.serviceName) ?? 0) + 1)
			const env = service.environment === "" ? "unknown" : service.environment
			environments.set(env, (environments.get(env) ?? 0) + 1)
		}
	}
	const toSorted = (map: Map<string, number>) =>
		[...map.entries()]
			.map(([name, count]) => ({ name, count }))
			.toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name))
	return { health, services: toSorted(services), environments: toSorted(environments) }
}

/** A 40-hex git sha reads as its 7-char short form; tags and versions stay verbatim. */
export function shortReleaseLabel(sha: string): string {
	return /^[0-9a-f]{40}$/i.test(sha) ? sha.slice(0, 7) : sha
}

/**
 * Calendar-day bucket for the table's group headers, in the viewer's zone.
 * "Today" / "Yesterday" / a medium date.
 */
export function releaseDayLabel(iso: string, nowMs: number, timeZone: string): string {
	const date = new Date(toEpochMs(iso))
	if (Number.isNaN(date.getTime())) return iso
	const startOfDay = (ms: number) => startOfDayInTimeZone(ms, timeZone)
	const dayDiff = Math.round((startOfDay(nowMs) - startOfDay(date.getTime())) / 86_400_000)
	if (dayDiff === 0) return "Today"
	if (dayDiff === 1) return "Yesterday"
	return date.toLocaleDateString(undefined, { timeZone, weekday: "short", month: "short", day: "numeric" })
}

/**
 * The service whose figures stand for a multi-service release in the list:
 * worst health first, then the largest error-rate jump, then the busiest.
 */
export function releaseHeadline(group: ReleaseGroup): ReleaseServiceImpact {
	const rank = (impact: ReleaseServiceImpact) => RELEASE_HEALTH_ORDER.indexOf(impact.health)
	return group.services.reduce((best, impact) => {
		if (rank(impact) !== rank(best)) return rank(impact) < rank(best) ? impact : best
		if ((impact.errorRatio ?? 0) !== (best.errorRatio ?? 0))
			return (impact.errorRatio ?? 0) > (best.errorRatio ?? 0) ? impact : best
		return impact.spanCount > best.spanCount ? impact : best
	})
}

/**
 * Slack between a version's first span and an issue it introduced: the
 * rollup's first-seen is bucket-floored, and an error can land a beat early.
 */
export const NEW_ISSUE_SLACK_MS = 5 * 60 * 1000

export interface ReleaseIssueCounts {
	fresh: number
	regressed: number
}

export interface IntroducedIssue {
	readonly serviceName: string
	readonly firstSeenAt: string
	readonly lastRegressedAt: string | null
}

export interface ReleaseIssues<T extends IntroducedIssue> {
	fresh: T[]
	regressed: T[]
}

/**
 * Credit each issue to the release of its service that was newest when the
 * issue first appeared, or last regressed. Keyed by commit sha.
 */
export function attributeIssues<T extends IntroducedIssue>(
	impacts: ReadonlyArray<ReleaseServiceImpact>,
	issues: ReadonlyArray<T>,
): Map<string, ReleaseIssues<T>> {
	const byService = new Map<string, ReleaseServiceImpact[]>()
	for (const impact of impacts) {
		const list = byService.get(impact.serviceName)
		if (list === undefined) byService.set(impact.serviceName, [impact])
		else list.push(impact)
	}
	const attributed = new Map<string, ReleaseIssues<T>>()
	for (const issue of issues) {
		const firstMs = Date.parse(issue.firstSeenAt)
		const regressedMs = issue.lastRegressedAt === null ? Number.NaN : Date.parse(issue.lastRegressedAt)
		const regressed = Number.isFinite(regressedMs) && regressedMs > firstMs
		const atMs = regressed ? regressedMs : firstMs
		if (!Number.isFinite(atMs)) continue
		let owner: ReleaseServiceImpact | undefined
		for (const impact of byService.get(issue.serviceName) ?? []) {
			const startMs = Date.parse(impact.firstSeen) - NEW_ISSUE_SLACK_MS
			if (startMs <= atMs && (owner === undefined || impact.firstSeen > owner.firstSeen)) owner = impact
		}
		if (owner === undefined) continue
		const entry = attributed.get(owner.commitSha) ?? { fresh: [], regressed: [] }
		if (regressed) entry.regressed.push(issue)
		else entry.fresh.push(issue)
		attributed.set(owner.commitSha, entry)
	}
	return attributed
}

/** `attributeIssues`, reduced to counts for the list. */
export function countIssues<T extends IntroducedIssue>(
	attributed: ReadonlyMap<string, ReleaseIssues<T>>,
): Map<string, ReleaseIssueCounts> {
	return new Map(
		[...attributed].map(([sha, issues]) => [
			sha,
			{ fresh: issues.fresh.length, regressed: issues.regressed.length },
		]),
	)
}

export interface LiveVersion {
	serviceName: string
	commitSha: string
	/** Share of the service's last bucket this version carried. */
	share: number
	/**
	 * Newer releases its usual siblings already serve, but this service does not.
	 * Zero for a service that never co-deploys with another.
	 */
	behind: number
}

/** What each service is serving right now, and how far it trails its siblings. */
export function liveVersions(
	timeline: ReadonlyArray<ReleaseTimelineBucket>,
	groups: ReadonlyArray<ReleaseGroup>,
): LiveVersion[] {
	const shares = lastBucketShares(timeline)
	const live = new Map<string, { commitSha: string; share: number }>()
	for (const [key, share] of shares) {
		const split = key.lastIndexOf(" ")
		const serviceName = key.slice(0, split)
		const commitSha = key.slice(split + 1)
		const current = live.get(serviceName)
		if (current === undefined || share > current.share) live.set(serviceName, { commitSha, share })
	}
	const groupBySha = new Map(groups.map((group) => [group.commitSha, group]))
	const result: LiveVersion[] = []
	for (const [serviceName, { commitSha, share }] of live) {
		const liveGroup = groupBySha.get(commitSha)
		const siblings = new Set(
			(liveGroup?.services ?? [])
				.map((impact) => impact.serviceName)
				.filter((name) => name !== serviceName),
		)
		// Only releases some sibling is already serving count: one still rolling
		// out elsewhere would otherwise mark every service behind for minutes.
		let siblingsNewest = ""
		for (const sibling of siblings) {
			const seen = groupBySha.get(live.get(sibling)?.commitSha ?? "")?.firstSeen ?? ""
			if (seen > siblingsNewest) siblingsNewest = seen
		}
		const behind =
			liveGroup === undefined || siblings.size === 0
				? 0
				: groups.filter(
						(group) =>
							group.firstSeen > liveGroup.firstSeen &&
							group.firstSeen <= siblingsNewest &&
							!group.services.some((impact) => impact.serviceName === serviceName) &&
							group.services.some((impact) => siblings.has(impact.serviceName)),
					).length
		result.push({ serviceName, commitSha, share, behind })
	}
	return result.toSorted((a, b) => b.behind - a.behind || a.serviceName.localeCompare(b.serviceName))
}

/**
 * The commit a release replaced, for its changeset: the predecessor most of its
 * services agree on. Undefined when none of them has one in the window.
 */
export function previousSha(group: ReleaseGroup): string | undefined {
	const votes = new Map<string, number>()
	for (const impact of group.services) {
		const sha = impact.baseline?.commitSha
		if (sha !== undefined) votes.set(sha, (votes.get(sha) ?? 0) + 1)
	}
	let best: string | undefined
	for (const [sha, count] of votes) if (best === undefined || count > (votes.get(best) ?? 0)) best = sha
	return best
}

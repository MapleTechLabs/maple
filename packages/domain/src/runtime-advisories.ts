import { compareVersions, type RuntimeProduct, runtimePosture } from "./runtime-posture"

// Known vulnerabilities in a runtime version for the Security Center's Runtimes tab, read from
// OSV.dev. Pure, so the web bundle and the API share it.

export const ADVISORY_SEVERITIES = ["critical", "high", "medium", "low", "unknown"] as const
export type AdvisorySeverity = (typeof ADVISORY_SEVERITIES)[number]

/**
 * The OSV package per runtime. The Bitnami ecosystem mirrors each vendor's advisories with a
 * severity and fixed versions for all of these; Bun and Deno have no runtime advisories there.
 */
export const OSV_RUNTIME_PACKAGES = new Map<RuntimeProduct, string>([
	["nodejs", "node"],
	["python", "python"],
	["go", "golang"],
	["java", "java"],
	["dotnet", "dotnet"],
	["ruby", "ruby"],
	["php", "php"],
])

export const OSV_RUNTIME_ECOSYSTEM = "Bitnami"

export interface RuntimeAdvisory {
	/** The CVE id when the advisory has one, else the OSV id. */
	readonly id: string
	readonly osvId: string
	readonly summary: string | null
	readonly severity: AdvisorySeverity
	/** The first version that fixes it for this version's line, null when none is published. */
	readonly fixedIn: string | null
	readonly published: string | null
}

export interface AdvisoryTarget {
	readonly product: RuntimeProduct
	readonly version: string
}

export const advisoryKey = (target: AdvisoryTarget): string => `${target.product}@${target.version}`

/** The runtime version to look up, undefined when there is none or OSV does not cover the runtime. */
export function advisoryTargetOf(input: Parameters<typeof runtimePosture>[0]): AdvisoryTarget | undefined {
	// Without release data every versioned, tracked runtime lands on `catalog_unavailable`.
	const posture = runtimePosture(input, () => undefined)
	if (posture.status !== "catalog_unavailable") return undefined
	return !OSV_RUNTIME_PACKAGES.has(posture.product)
		? undefined
		: { product: posture.product, version: posture.version }
}

export function severityOf(raw: string | undefined): AdvisorySeverity {
	const severity = (raw ?? "").trim().toLowerCase()
	// GitHub's advisory database says MODERATE for medium.
	if (severity === "moderate") return "medium"
	return ADVISORY_SEVERITIES.find((known) => known === severity) ?? "unknown"
}

/** Orders two versions: negative, zero or positive. Ecosystems with their own rules pass theirs. */
export type VersionComparator = (a: string, b: string) => number

export interface OsvRangeEvent {
	readonly introduced?: string
	readonly fixed?: string
}

/**
 * The fix for `version` in OSV range events, which pair an `introduced` with the `fixed` after it:
 * the `fixed` of the pair whose span holds the version.
 */
export function fixedVersionFor(
	events: ReadonlyArray<OsvRangeEvent>,
	version: string,
	compare: VersionComparator = compareVersions,
): string | null {
	const spans = events.reduce<{ introduced: string | null; fixes: ReadonlyArray<string> }>(
		(state, event) => {
			if (event.introduced !== undefined) return { ...state, introduced: event.introduced }
			if (event.fixed === undefined || state.introduced === null) return state
			const holds = compare(version, state.introduced) >= 0 && compare(version, event.fixed) < 0
			return { introduced: null, fixes: holds ? [...state.fixes, event.fixed] : state.fixes }
		},
		{ introduced: null, fixes: [] },
	)
	return spans.fixes[0] ?? null
}

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 } satisfies Record<
	AdvisorySeverity,
	number
>

/** Worst first, then newest. */
export const sortAdvisories = (advisories: ReadonlyArray<RuntimeAdvisory>): ReadonlyArray<RuntimeAdvisory> =>
	[...advisories].sort(
		(a, b) =>
			SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
			(b.published ?? "").localeCompare(a.published ?? "") ||
			a.id.localeCompare(b.id),
	)

export const isUrgentSeverity = (severity: AdvisorySeverity): boolean =>
	severity === "critical" || severity === "high"

/** The lowest of the versions, null for none. */
export const lowestVersion = (
	versions: ReadonlyArray<string>,
	compare: VersionComparator = compareVersions,
): string | null =>
	versions.reduce<string | null>(
		(lowest, version) => (lowest === null || compare(version, lowest) < 0 ? version : lowest),
		null,
	)

export interface AdvisorySummary {
	readonly total: number
	readonly counts: Record<AdvisorySeverity, number>
	readonly worst: AdvisorySeverity | null
	/** A critical or high advisory: upgrade now. */
	readonly urgent: boolean
	/**
	 * The lowest version that fixes every critical and high advisory with a fix. Medium and low ones
	 * often only list a fix in the newest line, which would point at a release nobody runs yet.
	 */
	readonly upgradeTo: string | null
	/** Critical and high advisories with no fixed version for this line. */
	readonly unfixed: number
}

export function summarizeAdvisories(advisories: ReadonlyArray<RuntimeAdvisory>): AdvisorySummary {
	const count = (severity: AdvisorySeverity) =>
		advisories.filter((advisory) => advisory.severity === severity).length
	const counts = {
		critical: count("critical"),
		high: count("high"),
		medium: count("medium"),
		low: count("low"),
		unknown: count("unknown"),
	}
	const urgent = advisories.filter((advisory) => isUrgentSeverity(advisory.severity))
	const fixes = urgent.flatMap((advisory) => (advisory.fixedIn === null ? [] : [advisory.fixedIn]))
	return {
		total: advisories.length,
		counts,
		worst: ADVISORY_SEVERITIES.find((severity) => counts[severity] > 0) ?? null,
		urgent: counts.critical + counts.high > 0,
		upgradeTo: fixes.reduce<string | null>(
			(highest, fix) => (highest === null || compareVersions(fix, highest) > 0 ? fix : highest),
			null,
		),
		unfixed: urgent.length - fixes.length,
	}
}

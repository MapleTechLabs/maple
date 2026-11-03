import {
	compareVersions,
	normalizeRuntimeVersion,
	type RuntimeProduct,
	runtimePosture,
} from "./runtime-posture"
import { Array as Arr, String as Str } from "effect"

// Known vulnerabilities in a runtime version for the Security Center's Runtimes tab. Pure, so the
// web bundle and the API share it.

export const ADVISORY_SEVERITIES = ["critical", "high", "medium", "low", "unknown"] as const
export type AdvisorySeverity = (typeof ADVISORY_SEVERITIES)[number]

export type AdvisorySource =
	/** A package in OSV's Bitnami ecosystem, which mirrors each vendor's advisories with fixed versions. */
	| { readonly _tag: "osv"; readonly package: string }
	/** The security advisories a GitHub repository publishes, for runtimes no advisory database tracks. */
	| { readonly _tag: "github"; readonly repo: string }

/** Where each runtime's advisories come from. Every tracked runtime needs one. */
export const ADVISORY_SOURCES = {
	nodejs: { _tag: "osv", package: "node" },
	python: { _tag: "osv", package: "python" },
	go: { _tag: "osv", package: "golang" },
	java: { _tag: "osv", package: "java" },
	dotnet: { _tag: "osv", package: "dotnet" },
	ruby: { _tag: "osv", package: "ruby" },
	php: { _tag: "osv", package: "php" },
	bun: { _tag: "github", repo: "oven-sh/bun" },
	deno: { _tag: "github", repo: "denoland/deno" },
} as const satisfies Record<RuntimeProduct, AdvisorySource>

export const OSV_RUNTIME_ECOSYSTEM = "Bitnami"

export interface RuntimeAdvisory {
	/** The CVE id when the advisory has one, else the source's id. */
	readonly id: string
	/** The advisory's page at its source. */
	readonly url: string
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

/**
 * The runtime version to look up, undefined when there is none: no version, an untracked runtime,
 * or Bun and Deno reporting the Node.js version they emulate instead of their own.
 */
export function advisoryTargetOf(input: Parameters<typeof runtimePosture>[0]): AdvisoryTarget | undefined {
	// Without release data every versioned, tracked runtime lands on `catalog_unavailable`.
	const posture = runtimePosture(input, () => undefined)
	return posture.status === "catalog_unavailable"
		? { product: posture.product, version: posture.version }
		: undefined
}

export function severityOf(raw: string | null | undefined): AdvisorySeverity {
	const severity = Str.toLowerCase(Str.trim(raw ?? ""))
	// GitHub's advisory database says MODERATE for medium.
	if (severity === "moderate") return "medium"
	return ADVISORY_SEVERITIES.find((known) => known === severity) ?? "unknown"
}

type RangeClause = { readonly op: string; readonly bound: string }

/**
 * A GitHub advisory range's clauses: `>= 1.0.21, < 1.4.4`, `> 1.46.0 <= 2.1.6`, an inclusive
 * `1.5.0 - 1.10.1`, or a bare version. Undefined when any clause is unreadable.
 */
const rangeClauses = (range: string): ReadonlyArray<RangeClause> | undefined => {
	const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(Str.trim(range))
	const text = hyphen === null ? range : `>= ${hyphen[1]}, <= ${hyphen[2]}`
	const tokens = Arr.filter(
		Str.split(/[\s,]+/)(Str.replace(/(>=|<=|>|<|=)\s+/g, "$1")(text)),
		(token) => token !== "",
	)
	const clauses = Arr.flatMap(tokens, (token) => {
		const match = /^(>=|<=|>|<|=)?(.+)$/.exec(token)
		const bound = normalizeRuntimeVersion(match?.[2] ?? "")
		return match === null || bound === undefined ? [] : [{ op: match[1] ?? "=", bound }]
	})
	return clauses.length === 0 || clauses.length !== tokens.length ? undefined : clauses
}

const holds = (clause: RangeClause, version: string): boolean => {
	const order = compareVersions(version, clause.bound)
	switch (clause.op) {
		case ">=":
			return order >= 0
		case ">":
			return order > 0
		case "<=":
			return order <= 0
		case "<":
			return order < 0
		default:
			return order === 0
	}
}

const isUpperBound = (clause: RangeClause) => clause.op === "<" || clause.op === "<="

/**
 * Whether `version` is in a GitHub advisory range. Clauses must all hold, except a list of upper
 * bounds only (`<1.46.4, <2.1.2`), which names one per release line. Unreadable ranges match nothing.
 */
export function inAdvisoryRange(range: string, version: string): boolean {
	const clauses = rangeClauses(range)
	if (clauses === undefined) return false
	return clauses.length > 1 && Arr.every(clauses, isUpperBound)
		? Arr.some(clauses, (clause) => holds(clause, version))
		: Arr.every(clauses, (clause) => holds(clause, version))
}

/** The lowest exclusive upper bound above `version`: the fix when an advisory lists no patched version. */
export function rangeEndFor(range: string, version: string): string | null {
	const ends = Arr.flatMap(rangeClauses(range) ?? [], (clause) =>
		clause.op === "<" && compareVersions(clause.bound, version) > 0 ? [clause.bound] : [],
	)
	return lowestVersion(ends)
}

const patchedVersions = (patched: string | null): ReadonlyArray<string> =>
	Arr.flatMap(Str.split(",")(patched ?? ""), (raw) => {
		const fixed = normalizeRuntimeVersion(raw)
		return fixed === undefined ? [] : [fixed]
	}).sort(compareVersions)

/** The lowest of a GitHub advisory's comma-separated patched versions above `version`, null for none. */
export function patchedVersionFor(patched: string | null, version: string): string | null {
	return lowestVersion(Arr.filter(patchedVersions(patched), (fixed) => compareVersions(fixed, version) > 0))
}

const lineOf = (version: string) => Arr.join(Str.split(".")(version).slice(0, 2), ".")

/**
 * Whether `version` already has a fix from patched versions such as `2.1.13, 2.2.13, >=2.3.3`: one on
 * its own release line, or the newest. Advisories often leave the vulnerable range open (`>= 2.0.0`)
 * and say where it ends only here.
 */
export function isPatched(patched: string | null, version: string): boolean {
	const fixes = patchedVersions(patched)
	const below = Arr.filter(fixes, (fixed) => compareVersions(fixed, version) <= 0)
	const nearest = below.at(-1)
	return nearest !== undefined && (nearest === fixes.at(-1) || lineOf(nearest) === lineOf(version))
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
			Str.localeCompare(a.published ?? "")(b.published ?? "") ||
			Str.localeCompare(b.id)(a.id),
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
		Arr.filter(advisories, (advisory) => advisory.severity === severity).length
	const counts = {
		critical: count("critical"),
		high: count("high"),
		medium: count("medium"),
		low: count("low"),
		unknown: count("unknown"),
	}
	const urgent = Arr.filter(advisories, (advisory) => isUrgentSeverity(advisory.severity))
	const fixes = Arr.flatMap(urgent, (advisory) => (advisory.fixedIn === null ? [] : [advisory.fixedIn]))
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

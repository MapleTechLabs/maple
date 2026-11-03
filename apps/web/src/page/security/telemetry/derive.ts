import {
	type AdvisorySummary,
	advisoryKey,
	advisoryTargetOf,
	type RuntimeAdvisory,
	summarizeAdvisories,
} from "@maple/domain/runtime-advisories"
import {
	type RuntimePosture,
	RUNTIME_PRODUCTS,
	type RuntimeProduct,
	runtimePosture,
	runtimeProductOf,
} from "@maple/domain/runtime-posture"
import { PROBE_CATEGORIES, type ProbeCategoryInfo, probeCategoryOf } from "@maple/domain/security-telemetry"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { Schema, Array as Arr, String as Str } from "effect"
import type { Exposure, Runtimes } from "./model"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

// Pure readings of the two responses: the Exposure tab's totals and categories, the Runtimes
// tab's postures in the order the table shows them.

const sum = (values: ReadonlyArray<number>): number => Arr.reduce(values, 0, (total, value) => total + value)
const distinct = (values: ReadonlyArray<string>): number => new Set(values).size

type SignatureRow = Exposure["signatures"][number]

// EXPOSURE

/** The sources query returns the most active addresses only, so past this the count is a floor. */
export const SOURCES_SHOWN = 20

/** The exposed-probe query returns at most this many rows, most recent first. */
export const EXPOSED_SHOWN = 50

/** True when the exposed list hit the query's cap, so its length is a floor. */
export const isExposedCapped = (exposure: Exposure): boolean => exposure.exposed.length >= EXPOSED_SHOWN

/** The signature query returns at most this many (signature, service) rows, busiest first. */
export const SIGNATURES_SHOWN = 5000

export interface ExposureTotals {
	readonly probeRequests: number
	readonly scannerRequests: number
	readonly sources: number
	readonly isSourcesCapped: boolean
	/** The signature rows hit the query's cap, so request and service totals are floors. */
	readonly isSignaturesCapped: boolean
	readonly servicesProbed: number
}

export const exposureTotals = (exposure: Exposure): ExposureTotals => {
	const probes = Arr.filter(exposure.signatures, (row) => row.signature !== "")
	const scanners = Arr.filter(exposure.signatures, (row) => row.signature === "")
	return {
		probeRequests: sum(Arr.map(probes, (row) => row.requests)),
		scannerRequests: sum(Arr.map(scanners, (row) => row.requests)),
		sources: exposure.sources.length,
		isSourcesCapped: exposure.sources.length >= SOURCES_SHOWN,
		isSignaturesCapped: exposure.signatures.length >= SIGNATURES_SHOWN,
		servicesProbed: distinct(Arr.map(probes, (row) => row.service)),
	}
}

export const isExposureEmpty = (exposure: Exposure): boolean =>
	exposure.signatures.length === 0 && exposure.sources.length === 0

const isCriticalSignature = (signature: string): boolean => {
	const category = probeCategoryOf(signature)
	return Arr.some(PROBE_CATEGORIES, (info) => info.id === category && info.critical)
}

/** A service answering this share of distinct probes, and at least this many, serves every path. */
const CATCH_ALL_SHARE = 0.8
const CATCH_ALL_MIN_ANSWERED = 3

export interface CatchAllService {
	readonly service: string
	readonly answered: number
	readonly probed: number
	/** A trace of one answered sensitive probe, `''` when the exposed list holds none for it. */
	readonly sampleTraceId: string
}

/**
 * Services that answer most critical probe paths with a success. A single-page app or a soft-404 route serves
 * its index page for `/.env` too, so their answered probes are a warning, not an exposure.
 */
export const catchAllServices = (exposure: Exposure): ReadonlyArray<CatchAllService> => {
	// Critical paths only: a WordPress site answers its own WordPress paths for real.
	const probes = Arr.filter(exposure.signatures, (row) => isCriticalSignature(row.signature))
	return Arr.flatMap([...new Set(Arr.map(probes, (row) => row.service))], (service) => {
		const own = Arr.filter(probes, (row) => row.service === service)
		const probed = distinct(Arr.map(own, (row) => row.signature))
		const answered = distinct(
			Arr.map(
				Arr.filter(own, (row) => row.answered > 0),
				(row) => row.signature,
			),
		)
		return answered >= CATCH_ALL_MIN_ANSWERED && answered / probed >= CATCH_ALL_SHARE
			? [
					{
						service,
						answered,
						probed,
						sampleTraceId:
							exposure.exposed.find(
								(row) => row.service === service && row.sampleTraceId !== "",
							)?.sampleTraceId ?? "",
					},
				]
			: []
	})
}

/** Answered critical probes on services that do not answer every path. */
export const exposedRows = (exposure: Exposure): Exposure["exposed"] => {
	const catchAll = new Set(Arr.map(catchAllServices(exposure), (entry) => entry.service))
	return Arr.filter(exposure.exposed, (row) => !catchAll.has(row.service))
}

export interface SignatureCount {
	readonly signature: string
	readonly requests: number
}

export interface CategoryRow {
	readonly key: string
	readonly label: string
	/** Null for the named-scanner row, which has no category. */
	readonly category: ProbeCategoryInfo | null
	readonly requests: number
	readonly answered: number
	readonly services: number
	readonly topSignatures: ReadonlyArray<SignatureCount>
}

/** A signature's requests across services, most first. */
const topSignaturesOf = (rows: ReadonlyArray<SignatureRow>, limit: number): ReadonlyArray<SignatureCount> => {
	const totals = rows.reduce<ReadonlyMap<string, number>>(
		(acc, row) => new Map(acc).set(row.signature, (acc.get(row.signature) ?? 0) + row.requests),
		new Map(),
	)
	return Arr.map([...totals], ([signature, requests]) => ({ signature, requests }))
		.sort((a, b) => b.requests - a.requests || Str.localeCompare(b.signature)(a.signature))
		.slice(0, limit)
}

const rowOf = (
	key: string,
	label: string,
	category: ProbeCategoryInfo | null,
	rows: ReadonlyArray<SignatureRow>,
	catchAll: ReadonlySet<string>,
): CategoryRow => ({
	key,
	label,
	category,
	requests: sum(Arr.map(rows, (row) => row.requests)),
	// Like the callout, a catch-all route's answers are not counted as served.
	answered: sum(
		Arr.map(
			Arr.filter(rows, (row) => !catchAll.has(row.service)),
			(row) => row.answered,
		),
	),
	services: distinct(Arr.map(rows, (row) => row.service)),
	topSignatures: category === null ? [] : topSignaturesOf(rows, 3),
})

/** One row per category with traffic, in catalog order, then named scanners on ordinary paths. */
export const categoryRows = (exposure: Exposure): ReadonlyArray<CategoryRow> => {
	const catchAll = new Set(Arr.map(catchAllServices(exposure), (entry) => entry.service))
	const byCategory = Arr.flatMap(PROBE_CATEGORIES, (category) => {
		const rows = Arr.filter(exposure.signatures, (row) => probeCategoryOf(row.signature) === category.id)
		return rows.length === 0 ? [] : [rowOf(category.id, category.label, category, rows, catchAll)]
	})
	const scanners = Arr.filter(exposure.signatures, (row) => row.signature === "")
	return scanners.length === 0
		? byCategory
		: [...byCategory, rowOf("scanners", "Named scanners on ordinary paths", null, scanners, catchAll)]
}

export const categoryLabelOf = (signature: string): string => {
	const id = probeCategoryOf(signature)
	return PROBE_CATEGORIES.find((category) => category.id === id)?.label ?? "Unclassified"
}

/**
 * Requests per bucket over the window ending at `nowMs`, oldest first, empty buckets as zero (the
 * query only returns buckets with traffic). Buckets start on multiples of `bucketSeconds`, as
 * `toStartOfInterval` aligns them.
 */
export const timelineValues = (
	exposure: Exposure,
	nowMs: number,
	bucketSeconds: number,
	count: number,
): ReadonlyArray<number> => {
	const bucketMs = bucketSeconds * 1000
	const last = Math.floor(nowMs / bucketMs) * bucketMs
	const byBucket = new Map(
		Arr.map(exposure.timeline, (point) => [
			Math.floor(toEpochMs(point.bucket) / bucketMs) * bucketMs,
			point.requests,
		]),
	)
	return Array.from(
		{ length: count },
		(_, index) => byBucket.get(last - (count - 1 - index) * bucketMs) ?? 0,
	)
}

// RUNTIMES

export type RuntimeStatus = RuntimePosture["status"]

/** Worst first: what needs an upgrade, then what Maple could not judge, then what is fine. */
const STATUS_RANK = {
	end_of_life: 0,
	behind: 1,
	no_version: 2,
	unknown_cycle: 3,
	catalog_unavailable: 4,
	emulated: 5,
	supported: 6,
	untracked: 7,
} satisfies Record<RuntimeStatus, number>

type RuntimeRow = Runtimes["runtimes"][number]

/** The known advisories for a row's runtime version. */
export type RuntimeVulnerabilities =
	/** No version to look up: none sent, an untracked runtime (Workers), or Bun and Deno posing as Node.js. */
	| { readonly status: "not_covered" }
	/** The advisory read failed. */
	| { readonly status: "unavailable"; readonly key: string }
	/** Not read this time: the request spent its read budget on busier services. */
	| { readonly status: "not_checked"; readonly key: string }
	| {
			readonly status: "checked"
			readonly key: string
			readonly advisories: ReadonlyArray<RuntimeAdvisory>
			readonly summary: AdvisorySummary
	  }

export interface RuntimeEntry {
	readonly row: RuntimeRow
	readonly posture: RuntimePosture
	readonly vulnerabilities: RuntimeVulnerabilities
	/** Last seen before another row of its service and environment: a version since upgraded away from. */
	readonly replaced: boolean
}

const releasesFor = (runtimes: Runtimes) => (product: RuntimeProduct) => runtimes.releases[product]

const vulnerabilitiesOf = (runtimes: Runtimes, row: RuntimeRow): RuntimeVulnerabilities => {
	const target = advisoryTargetOf(row)
	if (target === undefined) return { status: "not_covered" }
	const key = advisoryKey(target)
	const advisories = runtimes.advisories[key]
	if (advisories === undefined && runtimes.advisoriesSkipped.includes(key))
		return { status: "not_checked", key }
	return advisories === undefined
		? { status: "unavailable", key }
		: { status: "checked", key, advisories, summary: summarizeAdvisories(advisories) }
}

/** Critical, then high, then everything else: a known critical CVE outranks an end-of-life date. */
const urgencyRank = (vulnerabilities: RuntimeVulnerabilities): number => {
	if (vulnerabilities.status !== "checked") return 2
	if (vulnerabilities.summary.counts.critical > 0) return 0
	return vulnerabilities.summary.counts.high > 0 ? 1 : 2
}

const deploymentKey = (row: RuntimeRow): string => encodeJson([row.service, row.environment])

/** The hour each service and environment was last seen in, on any version. */
const newestSeenOf = (rows: ReadonlyArray<RuntimeRow>): ReadonlyMap<string, number> =>
	Arr.reduce(rows, new Map<string, number>(), (newest, row) => {
		const seen = toEpochMs(row.lastSeen)
		const key = deploymentKey(row)
		return seen > (newest.get(key) ?? Number.NEGATIVE_INFINITY) ? newest.set(key, seen) : newest
	})

/** Current versions first, worst first; a replaced version only shows as history below them. */
export const runtimeEntries = (runtimes: Runtimes): ReadonlyArray<RuntimeEntry> => {
	const newestSeen = newestSeenOf(runtimes.runtimes)
	return Arr.map(runtimes.runtimes, (row) => ({
		row,
		posture: runtimePosture(row, releasesFor(runtimes)),
		vulnerabilities: vulnerabilitiesOf(runtimes, row),
		replaced: toEpochMs(row.lastSeen) < (newestSeen.get(deploymentKey(row)) ?? Number.NEGATIVE_INFINITY),
	})).sort(
		(a, b) =>
			Number(a.replaced) - Number(b.replaced) ||
			urgencyRank(a.vulnerabilities) - urgencyRank(b.vulnerabilities) ||
			STATUS_RANK[a.posture.status] - STATUS_RANK[b.posture.status] ||
			Str.localeCompare(b.row.service)(a.row.service) ||
			Str.localeCompare(b.row.environment)(a.row.environment),
	)
}

/** The versions services run now: what the totals and the upgrade list judge. */
export const currentEntries = (entries: ReadonlyArray<RuntimeEntry>): ReadonlyArray<RuntimeEntry> =>
	Arr.filter(entries, (entry) => !entry.replaced)

export interface RuntimeTotals {
	readonly services: number
	/** Services on a version with a critical or high CVE. */
	readonly urgent: number
	readonly endOfLife: number
	readonly behind: number
	readonly noVersion: number
}

export const runtimeTotals = (all: ReadonlyArray<RuntimeEntry>): RuntimeTotals => {
	const entries = currentEntries(all)
	const servicesWith = (status: RuntimeStatus) =>
		distinct(
			Arr.map(
				Arr.filter(entries, (entry) => entry.posture.status === status),
				(entry) => entry.row.service,
			),
		)
	return {
		services: distinct(Arr.map(entries, (entry) => entry.row.service)),
		urgent: distinct(Arr.map(Arr.filter(entries, isUrgent), (entry) => entry.row.service)),
		endOfLife: servicesWith("end_of_life"),
		behind: servicesWith("behind"),
		noVersion: servicesWith("no_version"),
	}
}

/** The product's name when Maple tracks it (Bun or Deno for an emulated Node.js), else the raw name. */
const HOUR_MS = 3_600_000

/** The rollup is hourly, so a combination seen in the current hour cannot be dated closer. */
export const isSeenThisHour = (lastSeen: string, nowMs: number): boolean =>
	toEpochMs(lastSeen) >= Math.floor(nowMs / HOUR_MS) * HOUR_MS

export const runtimeLabelOf = (entry: RuntimeEntry): string => {
	if ("product" in entry.posture) return RUNTIME_PRODUCTS[entry.posture.product].label
	const product = runtimeProductOf(entry.row.runtimeName, entry.row.sdkLanguage)
	if (product !== undefined) return RUNTIME_PRODUCTS[product].label
	return Str.trim(entry.row.runtimeName) === "" ? "Unknown" : entry.row.runtimeName
}

export const sdkLabelOf = (row: RuntimeRow): string => {
	const named = Arr.join(
		Arr.filter([row.sdkName, row.sdkVersion], (part) => Str.trim(part) !== ""),
		" ",
	)
	return named !== "" ? named : row.sdkLanguage
}

type CheckedEntry = RuntimeEntry & {
	readonly vulnerabilities: Extract<RuntimeVulnerabilities, { status: "checked" }>
}

const isUrgent = (entry: RuntimeEntry): entry is CheckedEntry =>
	entry.vulnerabilities.status === "checked" && entry.vulnerabilities.summary.urgent

/** One runtime version with a critical or high CVE, and every service that runs it. */
export interface CriticalUpgrade {
	readonly key: string
	/** The first entry on this version, worst posture first. */
	readonly entry: RuntimeEntry
	readonly advisories: ReadonlyArray<RuntimeAdvisory>
	readonly summary: AdvisorySummary
	readonly services: ReadonlyArray<string>
}

/** Versions to upgrade now: most critical CVEs first, then most high, then most services. */
export const criticalUpgrades = (entries: ReadonlyArray<RuntimeEntry>): ReadonlyArray<CriticalUpgrade> => {
	const byKey = Arr.reduce(
		Arr.filter(currentEntries(entries), isUrgent),
		new Map<string, ReadonlyArray<CheckedEntry>>(),
		(groups, entry) => {
			const key = entry.vulnerabilities.key
			return groups.set(key, [...(groups.get(key) ?? []), entry])
		},
	)
	return Arr.flatMap([...byKey.entries()], ([key, group]): ReadonlyArray<CriticalUpgrade> => {
		const entry = group[0]
		if (entry === undefined) return []
		return [
			{
				key,
				entry,
				advisories: entry.vulnerabilities.advisories,
				summary: entry.vulnerabilities.summary,
				services: [...new Set(Arr.map(group, (member) => member.row.service))],
			},
		]
	}).sort(
		(a, b) =>
			b.summary.counts.critical - a.summary.counts.critical ||
			b.summary.counts.high - a.summary.counts.high ||
			b.services.length - a.services.length ||
			Str.localeCompare(b.key)(a.key),
	)
}

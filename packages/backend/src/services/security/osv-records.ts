import { compareVersions } from "@maple/lockfiles"
import type { PackageAdvisory, PackageRef } from "@maple/domain/package-advisories"
import {
	ADVISORY_SEVERITIES,
	type AdvisorySeverity,
	fixedVersionFor,
	lowestVersion,
	severityOf,
} from "@maple/domain/runtime-advisories"
import { Schema } from "effect"
import { cvss3BaseScore, severityOfScore } from "./cvss"

// OSV vulnerability records, slimmed to what the scanner keeps, and how the records of one
// vulnerability (a GO- and a GHSA- entry sharing a CVE) become one advisory.

const SUMMARY_MAX_LENGTH = 160

const OsvEvent = Schema.Struct({
	introduced: Schema.optionalKey(Schema.String),
	fixed: Schema.optionalKey(Schema.String),
})

/** The `GET /v1/vulns/{id}` payload, only the fields read here. */
export const OsvVulnResponse = Schema.Struct({
	id: Schema.String,
	aliases: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
	summary: Schema.optionalKey(Schema.String),
	details: Schema.optionalKey(Schema.String),
	published: Schema.optionalKey(Schema.String),
	withdrawn: Schema.optionalKey(Schema.String),
	severity: Schema.optionalKey(
		Schema.NullOr(Schema.Array(Schema.Struct({ type: Schema.String, score: Schema.String }))),
	),
	database_specific: Schema.optionalKey(
		Schema.NullOr(Schema.Struct({ severity: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
	),
	affected: Schema.optionalKey(
		Schema.NullOr(
			Schema.Array(
				Schema.Struct({
					package: Schema.optionalKey(
						Schema.Struct({ ecosystem: Schema.String, name: Schema.String }),
					),
					ranges: Schema.optionalKey(
						Schema.NullOr(
							Schema.Array(
								Schema.Struct({ type: Schema.String, events: Schema.Array(OsvEvent) }),
							),
						),
					),
				}),
			),
		),
	),
})
type OsvVulnResponse = typeof OsvVulnResponse.Type

/** What is cached per vulnerability id and modification time. */
export const OsvRecord = Schema.Struct({
	id: Schema.String,
	aliases: Schema.Array(Schema.String),
	summary: Schema.NullOr(Schema.String),
	published: Schema.NullOr(Schema.String),
	withdrawn: Schema.Boolean,
	/** The database's own rating (GitHub's, for GHSA records). */
	curatedSeverity: Schema.NullOr(Schema.String),
	cvssV3: Schema.NullOr(Schema.String),
	affected: Schema.Array(
		Schema.Struct({ ecosystem: Schema.String, name: Schema.String, events: Schema.Array(OsvEvent) }),
	),
})
export type OsvRecord = typeof OsvRecord.Type

/** Many advisories carry no summary, only details: their first sentence stands in, capped. */
const summaryOf = (vuln: OsvVulnResponse): string | null => {
	const text = (vuln.summary ?? vuln.details?.split(/(?<=\.)\s/)[0] ?? "").trim()
	if (text === "") return null
	return text.length > SUMMARY_MAX_LENGTH ? `${text.slice(0, SUMMARY_MAX_LENGTH - 1).trimEnd()}…` : text
}

export const toOsvRecord = (vuln: OsvVulnResponse): OsvRecord => ({
	id: vuln.id,
	aliases: vuln.aliases ?? [],
	summary: summaryOf(vuln),
	published: vuln.published ?? null,
	withdrawn: vuln.withdrawn !== undefined,
	curatedSeverity: vuln.database_specific?.severity ?? null,
	cvssV3: (vuln.severity ?? []).find((entry) => entry.type === "CVSS_V3")?.score ?? null,
	affected: (vuln.affected ?? []).flatMap(({ package: pkg, ranges }) =>
		pkg === undefined
			? []
			: (ranges ?? [])
					// GIT ranges are commit hashes, not versions.
					.filter((range) => range.type === "SEMVER" || range.type === "ECOSYSTEM")
					.map((range) => ({ ecosystem: pkg.ecosystem, name: pkg.name, events: range.events })),
	),
})

const severityRank = (severity: AdvisorySeverity): number => ADVISORY_SEVERITIES.indexOf(severity)

/** The curated rating when the database has one, else the CVSS 3 base score's rating. */
const recordSeverity = (record: OsvRecord): AdvisorySeverity => {
	const curated = severityOf(record.curatedSeverity ?? undefined)
	if (curated !== "unknown") return curated
	const score = record.cvssV3 === null ? undefined : cvss3BaseScore(record.cvssV3)
	return score === undefined ? "unknown" : severityOfScore(score)
}

/** The lowest fix of the locked version across the record's ranges for that package. */
const recordFix = (record: OsvRecord, ref: PackageRef): string | null => {
	const compare = (a: string, b: string) => compareVersions(ref.ecosystem, a, b)
	const fixes = record.affected
		.filter((affected) => affected.ecosystem === ref.ecosystem && affected.name === ref.name)
		.flatMap((affected) => {
			const fixed = fixedVersionFor(affected.events, ref.version, compare)
			return fixed === null ? [] : [fixed]
		})
	return lowestVersion(fixes, compare)
}

/** Records naming each other (directly or through a shared CVE) are one vulnerability. */
export const groupByAlias = (records: ReadonlyArray<OsvRecord>): ReadonlyArray<ReadonlyArray<OsvRecord>> =>
	records
		.reduce<
			ReadonlyArray<{ readonly names: ReadonlySet<string>; readonly records: ReadonlyArray<OsvRecord> }>
		>((groups, record) => {
			const names = [record.id, ...record.aliases]
			const linked = groups.filter((group) => names.some((name) => group.names.has(name)))
			const rest = groups.filter((group) => !linked.includes(group))
			return [
				...rest,
				{
					names: new Set([...names, ...linked.flatMap((group) => [...group.names])]),
					records: [...linked.flatMap((group) => group.records), record],
				},
			]
		}, [])
		.map((group) => group.records)

/** Go fixes are listed without the `v` that go.mod versions carry. */
const displayVersion = (ref: PackageRef, version: string): string =>
	ref.ecosystem === "Go" && !version.startsWith("v") ? `v${version}` : version

/**
 * One advisory from the records of one vulnerability: the GHSA id (stable across scans) when there
 * is one, the worst rating any record gives, and the highest of their fixes, so every source agrees.
 */
export const mergeAdvisory = (records: ReadonlyArray<OsvRecord>, ref: PackageRef): PackageAdvisory => {
	const ids = [...new Set(records.map((record) => record.id))].sort()
	const id = ids.find((candidate) => candidate.startsWith("GHSA-")) ?? ids[0] ?? ""
	const ordered = [...records].sort((a, b) =>
		a.id === id ? -1 : b.id === id ? 1 : a.id.localeCompare(b.id),
	)
	const names = new Set(ordered.flatMap((record) => [record.id, ...record.aliases]))
	const compare = (a: string, b: string) => compareVersions(ref.ecosystem, a, b)
	const fixes = ordered.flatMap((record) => {
		const fix = recordFix(record, ref)
		return fix === null ? [] : [fix]
	})
	const highestFix = fixes.reduce<string | null>(
		(highest, fix) => (highest === null || compare(fix, highest) > 0 ? fix : highest),
		null,
	)
	const severity = ordered
		.map(recordSeverity)
		.filter((rated) => rated !== "unknown")
		.reduce<AdvisorySeverity>(
			(worst, rated) =>
				worst === "unknown" || severityRank(rated) < severityRank(worst) ? rated : worst,
			"unknown",
		)
	const published = ordered
		.flatMap((record) => (record.published === null ? [] : [record.published]))
		.sort()
	return {
		id,
		aliases: [...names].filter((name) => name !== id).sort(),
		summary: ordered.find((record) => record.summary !== null)?.summary ?? null,
		severity,
		fixedIn: highestFix === null ? null : displayVersion(ref, highestFix),
		published: published[0] ?? null,
	}
}

/** A package's advisories from its matching records, withdrawn ones left out. */
export const advisoriesOf = (
	records: ReadonlyArray<OsvRecord>,
	ref: PackageRef,
): ReadonlyArray<PackageAdvisory> =>
	groupByAlias(records.filter((record) => !record.withdrawn)).map((group) => mergeAdvisory(group, ref))

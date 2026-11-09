import { compareVersions } from "@maple/lockfiles"
import type { PackageAdvisory, PackageRef } from "@maple/domain/package-advisories"
import {
	ADVISORY_SEVERITIES,
	type AdvisorySeverity,
	fixedVersionFor,
	lowestVersion,
	severityOf,
} from "@maple/domain/runtime-advisories"
import { Option, Schema, Array as Arr, String as Str } from "effect"
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
	const text = Str.trim(
		vuln.summary ??
			(vuln.details === undefined ? undefined : Str.split(vuln.details, /(?<=\.)\s/)[0]) ??
			"",
	)
	if (text === "") return null
	return text.length > SUMMARY_MAX_LENGTH
		? `${Str.trimEnd(Str.slice(0, SUMMARY_MAX_LENGTH - 1)(text))}…`
		: text
}

export const toOsvRecord = (vuln: OsvVulnResponse): OsvRecord => ({
	id: vuln.id,
	aliases: vuln.aliases ?? [],
	summary: summaryOf(vuln),
	published: vuln.published ?? null,
	withdrawn: vuln.withdrawn !== undefined,
	curatedSeverity: vuln.database_specific?.severity ?? null,
	cvssV3: Option.getOrNull(
		Option.map(
			Arr.findFirst(vuln.severity ?? [], (entry) => entry.type === "CVSS_V3"),
			(entry) => entry.score,
		),
	),
	affected: Arr.flatMap(vuln.affected ?? [], ({ package: pkg, ranges }) =>
		pkg === undefined
			? []
			: Arr.map(
					Arr.filter(
						ranges ?? [],
						(range) => range.type === "SEMVER" || range.type === "ECOSYSTEM",
					),
					(range) => ({ ecosystem: pkg.ecosystem, name: pkg.name, events: range.events }),
				),
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
	const matching = Arr.filter(
		record.affected,
		(affected) => affected.ecosystem === ref.ecosystem && affected.name === ref.name,
	)
	const fixes = Arr.flatMap(matching, (affected) => {
		const fixed = fixedVersionFor(affected.events, ref.version, compare)
		return fixed === null ? [] : [fixed]
	})
	return lowestVersion(fixes, compare)
}

/** Records naming each other (directly or through a shared CVE) are one vulnerability. */
export const groupByAlias = (records: ReadonlyArray<OsvRecord>): ReadonlyArray<ReadonlyArray<OsvRecord>> =>
	Arr.map(
		Arr.reduce<
			OsvRecord,
			ReadonlyArray<{ readonly names: ReadonlySet<string>; readonly records: ReadonlyArray<OsvRecord> }>
		>(records, [], (groups, record) => {
			const names = [record.id, ...record.aliases]
			const linked = Arr.filter(groups, (group) => Arr.some(names, (name) => group.names.has(name)))
			const rest = Arr.filter(groups, (group) => !linked.includes(group))
			return [
				...rest,
				{
					names: new Set([...names, ...Arr.flatMap(linked, (group) => [...group.names])]),
					records: [...Arr.flatMap(linked, (group) => group.records), record],
				},
			]
		}),
		(group) => group.records,
	)

/** Go fixes are listed without the `v` that go.mod versions carry. */
const displayVersion = (ref: PackageRef, version: string): string =>
	ref.ecosystem === "Go" && !Str.startsWith("v")(version) ? `v${version}` : version

/**
 * One advisory from the records of one vulnerability: the GHSA id (stable across scans) when there
 * is one, the worst rating any record gives, and the highest of their fixes, so every source agrees.
 */
export const mergeAdvisory = (records: ReadonlyArray<OsvRecord>, ref: PackageRef): PackageAdvisory => {
	const ids = [...new Set(Arr.map(records, (record) => record.id))].sort()
	const names = new Set(Arr.flatMap(records, (record) => [record.id, ...record.aliases]))
	// The GHSA id even when OSV only names it as an alias, so it holds once OSV returns that record too.
	const id = Option.getOrElse(
		Arr.findFirst([...names].sort(), (name) => Str.startsWith("GHSA-")(name)),
		() => ids[0] ?? "",
	)
	const ordered = [...records].sort((a, b) =>
		a.id === id ? -1 : b.id === id ? 1 : Str.localeCompare(b.id)(a.id),
	)
	const compare = (a: string, b: string) => compareVersions(ref.ecosystem, a, b)
	const fixes = Arr.flatMap(ordered, (record) => {
		const fix = recordFix(record, ref)
		return fix === null ? [] : [fix]
	})
	const highestFix = Arr.reduce<string, string | null>(fixes, null, (highest, fix) =>
		highest === null || compare(fix, highest) > 0 ? fix : highest,
	)
	const severity = Arr.reduce<AdvisorySeverity, AdvisorySeverity>(
		Arr.filter(Arr.map(ordered, recordSeverity), (rated) => rated !== "unknown"),
		"unknown",
		(worst, rated) => (worst === "unknown" || severityRank(rated) < severityRank(worst) ? rated : worst),
	)
	const published = Arr.flatMap(ordered, (record) =>
		record.published === null ? [] : [record.published],
	).sort()
	return {
		id,
		aliases: Arr.filter([...names], (name) => name !== id).sort(),
		summary: Option.getOrNull(
			Option.flatMap(
				Arr.findFirst(ordered, (record) => record.summary !== null),
				(record) => Option.fromNullishOr(record.summary),
			),
		),
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
	Arr.map(groupByAlias(Arr.filter(records, (record) => !record.withdrawn)), (group) =>
		mergeAdvisory(group, ref),
	)

import { Schema } from "effect"
import { ADVISORY_SEVERITIES } from "./runtime-advisories"

// Known vulnerabilities in a locked package version, read from OSV.dev for the dependency scanner.

/** OSV ecosystem names of the package managers the scanner reads. */
export const PACKAGE_ECOSYSTEMS = ["npm", "Go", "crates.io"] as const
export const PackageEcosystem = Schema.Literals(PACKAGE_ECOSYSTEMS)
export type PackageEcosystem = typeof PackageEcosystem.Type

export const AdvisorySeverity = Schema.Literals(ADVISORY_SEVERITIES)
export type AdvisorySeverity = typeof AdvisorySeverity.Type

export const PackageAdvisory = Schema.Struct({
	/** Stable across scans: the GitHub advisory id when OSV has one, else the first OSV id. */
	id: Schema.String,
	/** Every other id the advisory goes by (CVE, GO-, RUSTSEC-, GHSA-). */
	aliases: Schema.Array(Schema.String),
	summary: Schema.NullOr(Schema.String),
	severity: AdvisorySeverity,
	/** The first version that fixes it for the locked version, null when none is published. */
	fixedIn: Schema.NullOr(Schema.String),
	published: Schema.NullOr(Schema.String),
})
export type PackageAdvisory = typeof PackageAdvisory.Type

export interface PackageRef {
	readonly ecosystem: PackageEcosystem
	readonly name: string
	readonly version: string
}

export const packageKey = (ref: PackageRef): string => `${ref.ecosystem}:${ref.name}@${ref.version}`

/** The id shown to people: the CVE when there is one. */
export const displayAdvisoryId = (advisory: Pick<PackageAdvisory, "id" | "aliases">): string =>
	advisory.aliases.find((alias) => alias.startsWith("CVE-")) ?? advisory.id

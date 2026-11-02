/** Shapes mirror `@changesets/types` so `status --output` JSON matches field for field. */
import type { BumpType } from "./semver.ts"

export type VersionType = BumpType | "none"

export interface Release {
	readonly name: string
	readonly type: VersionType
}

export interface Changeset {
	readonly releases: ReadonlyArray<Release>
	readonly summary: string
}

export interface NewChangeset extends Changeset {
	readonly id: string
}

export interface NewChangesetWithCommit extends NewChangeset {
	readonly commit: string | undefined
}

export type DependencyRanges = Readonly<Record<string, string>>

export interface PackageJson {
	readonly name: string
	readonly version?: string
	readonly private?: boolean
	readonly dependencies?: DependencyRanges
	readonly devDependencies?: DependencyRanges
	readonly peerDependencies?: DependencyRanges
	readonly optionalDependencies?: DependencyRanges
}

export interface Package {
	readonly dir: string
	readonly relativeDir: string
	readonly packageJson: PackageJson
}

export interface Packages {
	readonly rootDir: string
	readonly rootPackage: Package
	readonly packages: ReadonlyArray<Package>
}

export interface ComprehensiveRelease {
	readonly name: string
	readonly type: VersionType
	readonly oldVersion: string | undefined
	readonly changesets: ReadonlyArray<string>
	readonly newVersion: string | undefined
}

export interface ReleasePlan {
	readonly changesets: ReadonlyArray<NewChangeset>
	readonly releases: ReadonlyArray<ComprehensiveRelease>
}

export const DEPENDENCY_TYPES = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
] as const

export type DependencyType = (typeof DEPENDENCY_TYPES)[number]

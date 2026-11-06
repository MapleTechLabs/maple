/** OSV ecosystem names. */
export type Ecosystem = "npm" | "Go" | "crates.io"

export type LockfileKind =
	| "package-lock"
	| "pnpm-lock"
	| "yarn-v1"
	| "yarn-berry"
	| "bun-lock"
	| "bun-lockb"
	| "go-mod"
	| "go-sum"
	| "cargo-lock"

export type Relation = "direct" | "dev" | "transitive" | "unknown"

export interface LockedPackage {
	readonly ecosystem: Ecosystem
	readonly name: string
	readonly version: string
	readonly relation: Relation
}

export interface ParsedLockfile {
	readonly path: string
	readonly kind: LockfileKind
	readonly packages: ReadonlyArray<LockedPackage>
	readonly warnings: ReadonlyArray<string>
}

export interface LockfileInput {
	readonly path: string
	readonly content: string
	/** Manifests keyed by path relative to the lockfile's directory (e.g. "packages/a/package.json"). */
	readonly manifests?: ReadonlyMap<string, string>
}

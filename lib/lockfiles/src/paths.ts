import type { LockfileKind } from "./types.ts"

const KIND_BY_NAME: ReadonlyMap<string, LockfileKind> = new Map([
	["package-lock.json", "package-lock"],
	["npm-shrinkwrap.json", "package-lock"],
	["pnpm-lock.yaml", "pnpm-lock"],
	["yarn.lock", "yarn-v1"],
	["bun.lock", "bun-lock"],
	["bun.lockb", "bun-lockb"],
	["go.mod", "go-mod"],
	["go.sum", "go-sum"],
	["Cargo.lock", "cargo-lock"],
])

const IGNORED_SEGMENTS = new Set(["node_modules", "vendor", "testdata", "fixtures", "__fixtures__", ".git"])

const segmentsOf = (path: string): ReadonlyArray<string> => path.split(/[\\/]+/).filter((s) => s !== "")

/** Kind by basename. yarn.lock is "yarn-v1" here; the parser detects berry from its content. */
export const lockfileKindOf = (path: string): LockfileKind | undefined =>
	KIND_BY_NAME.get(segmentsOf(path).at(-1) ?? "")

/** Paths a scan skips: vendored, test or dependency trees. */
export const isIgnoredLockfilePath = (path: string): boolean =>
	segmentsOf(path).some((segment) => IGNORED_SEGMENTS.has(segment))

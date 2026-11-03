import type { DependencyScanLockfile } from "@maple/domain/dependency-scan"
import { isIgnoredLockfilePath, type LockfileKind, lockfileKindOf } from "@maple/lockfiles"
import type { VcsTreeFile } from "@maple/backend/services/integrations/vcs/VcsProviderClient"
import { Array as Arr, String as Str } from "effect"

// Which files of a repository tree a scan reads. Pure, so the rules are testable without GitHub.

/** Lockfiles read per scan; the rest are left out, deepest paths first. */
export const MAX_LOCKFILES = 50
/** Manifests read for one yarn lockfile, which says nothing about direct and dev dependencies. */
export const MAX_MANIFESTS = 20

export interface SelectedLockfile {
	readonly file: VcsTreeFile
	readonly kind: LockfileKind
}

export const directoryOf = (path: string): string => {
	const slash = path.lastIndexOf("/")
	return slash === -1 ? "" : Str.slice(0, slash + 1)(path)
}

const depth = (path: string): number => Str.split("/")(path).length

/**
 * The tree's lockfiles, shallowest first, capped. A go.sum next to a go.mod is skipped: go.sum
 * also lists versions the build never selects, which would only add false positives.
 */
export function selectLockfiles(files: ReadonlyArray<VcsTreeFile>): {
	readonly selected: ReadonlyArray<SelectedLockfile>
	/** Past the cap: recorded as skipped so their findings are kept, not read as deleted. */
	readonly skipped: ReadonlyArray<SelectedLockfile>
} {
	const candidates = Arr.flatMap(files, (file): ReadonlyArray<SelectedLockfile> => {
		const kind = lockfileKindOf(file.path)
		return kind === undefined || isIgnoredLockfilePath(file.path) ? [] : [{ file, kind }]
	})
	const goModDirs = new Set(
		Arr.map(
			Arr.filter(candidates, (c) => c.kind === "go-mod"),
			(c) => directoryOf(c.file.path),
		),
	)
	const kept = Arr.filter(
		candidates,
		(c) => c.kind !== "go-sum" || !goModDirs.has(directoryOf(c.file.path)),
	).sort((a, b) => depth(a.file.path) - depth(b.file.path) || Str.localeCompare(b.file.path)(a.file.path))
	return { selected: kept.slice(0, MAX_LOCKFILES), skipped: kept.slice(MAX_LOCKFILES) }
}

/** The package.json files under a yarn lockfile's directory, keyed relative to it. */
export function manifestsFor(
	lockfile: SelectedLockfile,
	files: ReadonlyArray<VcsTreeFile>,
): ReadonlyArray<{ readonly relativePath: string; readonly file: VcsTreeFile }> {
	if (lockfile.kind !== "yarn-v1" && lockfile.kind !== "yarn-berry") return []
	const dir = directoryOf(lockfile.file.path)
	return Arr.map(
		Arr.filter(
			files,
			(file) =>
				Str.startsWith(dir)(file.path) &&
				(file.path === `${dir}package.json` || Str.endsWith("/package.json")(file.path)) &&
				!isIgnoredLockfilePath(file.path),
		)
			.sort((a, b) => depth(a.path) - depth(b.path) || Str.localeCompare(b.path)(a.path))
			.slice(0, MAX_MANIFESTS),
		(file) => ({ relativePath: Str.slice(dir.length)(file.path), file }),
	)
}

/** Whether a scan would read exactly the lockfile contents an earlier scan read. */
export const sameLockfiles = (
	previous: ReadonlyArray<DependencyScanLockfile>,
	selected: ReadonlyArray<SelectedLockfile>,
): boolean =>
	previous.length === selected.length &&
	Arr.every(selected, ({ file }) =>
		Arr.some(previous, (lockfile) => lockfile.path === file.path && lockfile.blobSha === file.sha),
	)

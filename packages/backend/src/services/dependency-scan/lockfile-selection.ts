import type { DependencyScanLockfile } from "@maple/domain/dependency-scan"
import { isIgnoredLockfilePath, type LockfileKind, lockfileKindOf } from "@maple/lockfiles"
import type { VcsTreeFile } from "@maple/backend/services/integrations/vcs/VcsProviderClient"

// Which files of a repository tree a scan reads. Pure, so the rules are testable without GitHub.

/** Lockfiles read per scan; the rest are left out, deepest paths first. */
export const MAX_LOCKFILES = 50
/** Manifests read for one yarn lockfile, which says nothing about direct and dev dependencies. */
export const MAX_MANIFESTS = 50

export interface SelectedLockfile {
	readonly file: VcsTreeFile
	readonly kind: LockfileKind
}

export const directoryOf = (path: string): string => {
	const slash = path.lastIndexOf("/")
	return slash === -1 ? "" : path.slice(0, slash + 1)
}

const depth = (path: string): number => path.split("/").length

/**
 * The tree's lockfiles, shallowest first, capped. A go.sum next to a go.mod is skipped: go.sum
 * also lists versions the build never selects, which would only add false positives.
 */
export function selectLockfiles(files: ReadonlyArray<VcsTreeFile>): {
	readonly selected: ReadonlyArray<SelectedLockfile>
	readonly skipped: number
} {
	const candidates = files.flatMap((file): ReadonlyArray<SelectedLockfile> => {
		const kind = lockfileKindOf(file.path)
		return kind === undefined || isIgnoredLockfilePath(file.path) ? [] : [{ file, kind }]
	})
	const goModDirs = new Set(
		candidates.filter((c) => c.kind === "go-mod").map((c) => directoryOf(c.file.path)),
	)
	const kept = candidates
		.filter((c) => c.kind !== "go-sum" || !goModDirs.has(directoryOf(c.file.path)))
		.sort((a, b) => depth(a.file.path) - depth(b.file.path) || a.file.path.localeCompare(b.file.path))
	return { selected: kept.slice(0, MAX_LOCKFILES), skipped: Math.max(0, kept.length - MAX_LOCKFILES) }
}

/** The package.json files under a yarn lockfile's directory, keyed relative to it. */
export function manifestsFor(
	lockfile: SelectedLockfile,
	files: ReadonlyArray<VcsTreeFile>,
): ReadonlyArray<{ readonly relativePath: string; readonly file: VcsTreeFile }> {
	if (lockfile.kind !== "yarn-v1" && lockfile.kind !== "yarn-berry") return []
	const dir = directoryOf(lockfile.file.path)
	return files
		.filter(
			(file) =>
				file.path.startsWith(dir) &&
				(file.path === `${dir}package.json` || file.path.endsWith("/package.json")) &&
				!isIgnoredLockfilePath(file.path),
		)
		.sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path))
		.slice(0, MAX_MANIFESTS)
		.map((file) => ({ relativePath: file.path.slice(dir.length), file }))
}

/** Whether a scan would read exactly the lockfile contents an earlier scan read. */
export const sameLockfiles = (
	previous: ReadonlyArray<DependencyScanLockfile>,
	selected: ReadonlyArray<SelectedLockfile>,
): boolean =>
	previous.length === selected.length &&
	selected.every(({ file }) =>
		previous.some((lockfile) => lockfile.path === file.path && lockfile.blobSha === file.sha),
	)

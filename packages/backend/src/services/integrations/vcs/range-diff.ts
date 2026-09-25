/**
 * A rebase-safe delta between two versions of a pull request, in the spirit of `git range-diff`:
 * each version's diff against its own base is compared per file, so a rebase onto a newer base
 * reports only the files whose change actually differs, not everything the base branch moved.
 */

/** One file of a pull request's diff against its base. */
export interface FileChange {
	readonly path: string
	readonly previousPath?: string | undefined
	readonly status: string
	/** Absent for binary files and for diffs too large to inline; such a file always counts as changed. */
	readonly patch?: string | undefined
}

// Hunk headers carry line numbers that shift whenever the base moves under the change.
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/gm

const sameChange = (before: FileChange, after: FileChange) =>
	before.patch !== undefined &&
	after.patch !== undefined &&
	before.status === after.status &&
	before.previousPath === after.previousPath &&
	before.patch.replace(HUNK_HEADER, "@@") === after.patch.replace(HUNK_HEADER, "@@")

/**
 * Paths whose change differs between two diffs of one pull request: changed, added to the pull
 * request, or dropped from it (the author reverted that file's change).
 */
export const rangeDiffPaths = (
	before: ReadonlyArray<FileChange>,
	after: ReadonlyArray<FileChange>,
): ReadonlyArray<string> => {
	const earlier = new Map(before.map((file) => [file.path, file]))
	const changed: Array<string> = []
	for (const file of after) {
		const previous = earlier.get(file.path)
		earlier.delete(file.path)
		if (previous === undefined || !sameChange(previous, file)) changed.push(file.path)
	}
	return [...changed, ...earlier.keys()]
}

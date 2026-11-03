import { Array as Arr, String as Str } from "effect"
/**
 * `changedSincePrior` from a list of changed files. A unit's paths may be directories, so a path
 * counts as changed when a changed file is it or sits under it. `*` means the diff could not be read
 * in full, and everything counts as changed: never claim unchanged source the run did not see.
 */
export const EVERYTHING_CHANGED = "*"

export const changedMatcher = (changedFiles: ReadonlyArray<string>) => {
	const files = new Set(changedFiles)
	if (files.has(EVERYTHING_CHANGED)) return (_paths: ReadonlyArray<string>) => true
	return (paths: ReadonlyArray<string>) =>
		Arr.some(paths, (path) => {
			const root = Str.replace(/\/+$/, "")(path)
			return files.has(root) || Arr.some(changedFiles, (file) => Str.startsWith(`${root}/`)(file))
		})
}

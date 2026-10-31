/**
 * The repository's shape for hunters and critics: its directories to depth 3, so an agent lists a
 * real directory instead of guessing `packages/api/...` from naming conventions.
 */

/** Tracked directories to depth 3, each printed once, from one `git ls-files` in the sandbox. */
export const REPO_TREE_COMMAND = {
	command: "bash",
	args: [
		"-c",
		[
			"set -euo pipefail",
			`git --no-optional-locks -c core.quotePath=false ls-files | awk -F/ '{ p = ""; for (i = 1; i < NF && i <= 3; i++) { p = (i == 1 ? $1 : p "/" $i); if (!seen[p]++) print p } }'`,
		].join("\n"),
	],
} as const

/** The prompt section's budget: a few KB, whatever the repository's size. */
export const MAX_REPO_TREE_BYTES = 4 * 1024

const OMITTED = "(deeper or further directories omitted: use list_files)"

const bySegments = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): number => {
	const i = a.findIndex((segment, n) => segment !== b[n])
	const [mine, other] = [a[i], b[i]]
	if (i === -1 || mine === undefined) return a.length - b.length
	return other === undefined ? 1 : mine < other ? -1 : 1
}

const render = (dirs: ReadonlyArray<ReadonlyArray<string>>): string =>
	[...dirs]
		.sort(bySegments)
		.map((segments) => `${"  ".repeat(segments.length - 1)}${segments.at(-1)}/`)
		.join("\n")

/**
 * The listing as an indented tree within `maxBytes`. Shallow levels go in whole first, so a large
 * repository keeps its top-level layout and loses depth, never one alphabetical end of the tree.
 */
export const formatRepoTree = (
	stdout: string,
	truncated: boolean,
	maxBytes = MAX_REPO_TREE_BYTES,
): string => {
	const lines = stdout.split("\n")
	// A cut stream's last line may be half a path.
	const complete = (truncated ? lines.slice(0, -1) : lines).filter((line) => line !== "")
	const dirs = complete.map((line) => line.split("/"))
	const fits = (chosen: ReadonlyArray<ReadonlyArray<string>>) =>
		new TextEncoder().encode(`${render(chosen)}\n${OMITTED}`).length <= maxBytes
	const chosen = [1, 2, 3].reduce<{
		readonly dirs: ReadonlyArray<ReadonlyArray<string>>
		readonly full: boolean
	}>(
		(acc, depth) => {
			if (acc.full) return acc
			const next = [...acc.dirs, ...dirs.filter((segments) => segments.length === depth)]
			return fits(next) ? { dirs: next, full: false } : { dirs: acc.dirs, full: true }
		},
		{ dirs: [], full: false },
	)
	// Even the top level is over budget: keep what fits of it.
	const kept =
		chosen.dirs.length > 0
			? chosen.dirs
			: dirs
					.filter((segments) => segments.length === 1)
					.sort(bySegments)
					.reduce<ReadonlyArray<ReadonlyArray<string>>>(
						(acc, segments) => (fits([...acc, segments]) ? [...acc, segments] : acc),
						[],
					)
	const omitted = truncated || kept.length < dirs.length
	return kept.length === 0 ? "" : omitted ? `${render(kept)}\n${OMITTED}` : render(kept)
}

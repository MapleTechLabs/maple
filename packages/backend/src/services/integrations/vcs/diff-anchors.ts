/**
 * Which new-side lines of a unified diff an inline review comment may anchor to.
 *
 * A provider rejects a whole review when one comment sits outside the diff, so comments are checked
 * here first and only the unanchorable ones are dropped. Pure, so the hunk rules are tested alone.
 */

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** Each new-side line a comment may sit on, mapped to the index of the hunk it belongs to. */
export const commentableLines = (patch: string): ReadonlyMap<number, number> => {
	const lines = new Map<number, number>()
	let hunk = -1
	let next: number | undefined
	for (const line of patch.split("\n")) {
		const header = HUNK_HEADER.exec(line)
		if (header !== null) {
			hunk++
			next = Number(header[1])
			continue
		}
		if (next === undefined || line.startsWith("-") || line.startsWith("\\")) continue
		// An added line (`+`) or a context line (` `, or empty where a tool trimmed the space).
		lines.set(next, hunk)
		next++
	}
	return lines
}

export interface AnchorableComment {
	readonly path: string
	readonly line: number
	readonly startLine?: number
}

/**
 * Split comments into the ones the diff can carry and the ones it cannot. A range must start and
 * end in the same hunk; a file with no textual patch (binary, or too large to inline) carries none.
 */
export const anchorComments = <C extends AnchorableComment>(
	comments: ReadonlyArray<C>,
	patches: ReadonlyMap<string, string | undefined>,
): { readonly anchored: ReadonlyArray<C>; readonly dropped: ReadonlyArray<C> } => {
	const cache = new Map<string, ReadonlyMap<number, number>>()
	const linesOf = (path: string) => {
		const cached = cache.get(path)
		if (cached !== undefined) return cached
		const patch = patches.get(path)
		const lines = patch === undefined ? new Map<number, number>() : commentableLines(patch)
		cache.set(path, lines)
		return lines
	}
	const anchored: Array<C> = []
	const dropped: Array<C> = []
	for (const comment of comments) {
		const lines = linesOf(comment.path)
		const end = lines.get(comment.line)
		const start = comment.startLine === undefined ? end : lines.get(comment.startLine)
		const fits =
			end !== undefined &&
			start === end &&
			(comment.startLine === undefined || comment.startLine < comment.line)
		;(fits ? anchored : dropped).push(comment)
	}
	return { anchored, dropped }
}

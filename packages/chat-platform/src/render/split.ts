/**
 * One turn's blocks, cut into as many platform messages as they need.
 *
 * The policy is neutral because the failure it prevents is: a platform rejects an over-long
 * message, so the whole answer disappears rather than arriving in two. Connectors declare the
 * budget they want to be held to; the cutting itself is written and tested once.
 *
 * A cut never lands inside a fenced code block. Markdown that opens a fence and never closes it
 * renders the rest of the message as code on every platform that has fences at all, so a fence
 * that spans a cut is closed at the end of one message and reopened at the top of the next.
 */
import { MAX_APPROVAL_OUTCOME_CHARS, type ChatBlock } from "./blocks"

export const splitBlocks = (
	blocks: ReadonlyArray<ChatBlock>,
	maxChars: number,
): ReadonlyArray<ReadonlyArray<ChatBlock>> => {
	const groups: Array<Array<ChatBlock>> = [[]]
	let used = 0

	const open = () => groups[groups.length - 1]
	const next = () => {
		groups.push([])
		used = 0
	}

	for (const block of blocks) {
		const weight = blockWeight(block)
		if (weight <= maxChars - used) {
			open().push(block)
			used += weight
			continue
		}
		// A block that does not fit starts a message of its own rather than filling the tail of this
		// one: half a paragraph followed by its other half is harder to read than a clean break.
		if (open().length > 0) next()
		if (block.kind !== "prose") {
			open().push(block)
			used += weight
			continue
		}
		for (const chunk of cutMarkdown(block.markdown, maxChars)) {
			if (open().length > 0) next()
			open().push({ kind: "prose", markdown: chunk })
			used = chunk.length
		}
	}

	return groups[0].length === 0 ? [[]] : groups
}

/**
 * How much of a message's budget a block spends.
 *
 * An estimate, not a measurement: what a connector finally writes is its own dialect, and only
 * prose is ever big enough for the difference to matter. A connector's declared budget is expected
 * to leave room for its own decoration — links, quote markers, an approval's label.
 */
const blockWeight = (block: ChatBlock): number => {
	switch (block.kind) {
		case "prose":
			return block.markdown.length
		case "chart":
			return (block.title?.length ?? 0) + block.summary.length + (block.imageUrl?.length ?? 0)
		case "entity":
			return block.label.length + (block.detail?.length ?? 0) + (block.url?.length ?? 0)
		case "activity":
			return block.tools.reduce(
				(total, tool) => total + tool.label.length + (tool.detail?.length ?? 0),
				0,
			)
		case "approval":
			// Charged for an outcome it may not have yet, so that deciding a proposal cannot move its
			// block into a different message from the one whose controls were clicked — which is the
			// message the settling edit addresses.
			return (
				block.toolName.length + block.summary.length + block.token.length + MAX_APPROVAL_OUTCOME_CHARS
			)
		case "notice":
			return block.text.length
		case "alert":
			return (
				block.title.length +
				block.summary.length +
				block.fields.reduce((total, field) => total + field.label.length + field.value.length, 0) +
				block.footer.reduce((total, part) => total + part.length, 0)
			)
	}
}

/** Room a cut leaves for the ``` that closes an open fence. */
const FENCE_CLOSE_COST = 4

/**
 * Markdown, cut into pieces of at most `maxChars`, preferring line boundaries.
 *
 * A single line longer than the budget — a pasted stack trace, a one-line JSON blob — is cut
 * mid-line, because the alternative is emitting a piece the platform rejects.
 */
export const cutMarkdown = (markdown: string, maxChars: number): Array<string> => {
	const chunks: Array<string> = []
	let current: Array<string> = []
	let length = 0
	/** No content line in the current chunk yet — it holds a reopened fence, or nothing. */
	let empty = true
	/** The opener of the fence held open across a cut, so the next chunk can reopen it. */
	let fence: string | null = null

	const budget = () => (fence === null ? maxChars : maxChars - FENCE_CLOSE_COST)
	const add = (line: string) => {
		length += current.length === 0 ? line.length : line.length + 1
		current.push(line)
		empty = false
	}
	const flush = () => {
		if (empty) return
		chunks.push(fence === null ? current.join("\n") : `${current.join("\n")}\n${FENCE}`)
		current = fence === null ? [] : [fence]
		length = fence === null ? 0 : fence.length
		empty = true
	}

	for (const line of markdown.split("\n")) {
		// A line that OPENS a fence pays for the closing ``` from its own budget, and counts as open
		// the moment its first character is packed — not after the whole line, which left an opener
		// that had to be cut mid-line sitting unbalanced at the end of a chunk.
		//
		// It cannot count as open any EARLIER either: a cut forced by this very line must close the
		// outgoing chunk only if that chunk was already inside a fence.
		const opens = fence === null && isFence(line)
		const lineBudget = opens ? maxChars - FENCE_CLOSE_COST : budget()
		const pack = (piece: string) => {
			add(piece)
			if (opens) fence = reopener(line)
		}
		let rest = line
		for (;;) {
			const needed = current.length === 0 ? rest.length : rest.length + 1
			if (needed <= lineBudget - length) {
				pack(rest)
				break
			}
			// A fresh chunk would fit it: start one. Otherwise the line itself is longer than a whole
			// message, and the only alternative to cutting mid-line is emitting a piece the platform
			// rejects.
			if (!empty) {
				flush()
				continue
			}
			// At least one character, always: a budget small enough to leave no room would otherwise
			// slice from the tail and repeat the line instead of advancing through it.
			const room = Math.max(lineBudget - length - (current.length === 0 ? 0 : 1), 1)
			pack(rest.slice(0, room))
			rest = rest.slice(room)
			flush()
			if (rest.length === 0) break
		}
		if (!opens && isFence(line)) fence = null
	}

	flush()
	return chunks.length === 0 ? [""] : chunks
}

const FENCE = "```"

const isFence = (line: string): boolean => line.trimStart().startsWith(FENCE)

/** An info string is at most this long once a cut has to repeat it at the top of every chunk. */
const MAX_REOPENER_CHARS = 24

/**
 * What a cut reopens a fence with: the delimiter and its language, never the opening line itself.
 *
 * A model writing ```` ```json ```` followed by the payload ON THE SAME LINE opens a fence whose
 * opener is longer than a whole message. Re-seeding every chunk with that line put each one over
 * the budget, forever — the cut has to repeat the fence, not the content that shared its line.
 */
const reopener = (line: string): string => {
	const info = line.trimStart().slice(FENCE.length).trim().split(/\s+/)[0] ?? ""
	return `${FENCE}${info}`.slice(0, MAX_REOPENER_CHARS)
}

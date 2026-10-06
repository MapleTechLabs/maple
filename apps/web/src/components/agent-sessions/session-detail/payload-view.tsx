import { useMemo } from "react"

import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
import { cn } from "@maple/ui/lib/utils"

import { tryParseJson } from "@/components/attributes"
import { ClampedText, type ClampLines } from "./clamped-text"

/**
 * The rendered ↔ raw affordances every captured body shares, wherever it is
 * opened — a transcript block, the span popover. Markdown
 * layout and pretty-printed JSON are readings of the capture, and a reading can
 * hide things — whitespace, key order, a literal `**` — so every rendered body
 * keeps a way back to the captured bytes.
 */

/**
 * A payload body, pretty-printed where it parses as JSON (object or array —
 * same test as the log body), verbatim otherwise. An emitter-truncated prefix
 * fails the parse and stays verbatim, which is right: pretty-printing a
 * fragment would dress it up as a whole document. Highlighting is the body's
 * own business (`ClampedText`), which dresses up only what it mounts.
 */
export function useJsonPayload(text: string): { formatted: string; isJson: boolean } {
	return useMemo(() => {
		const parsed = tryParseJson(text)
		if (parsed === null) return { formatted: text, isJson: false }
		return { formatted: JSON.stringify(parsed, null, 2), isJson: true }
	}, [text])
}

/**
 * A message body's rendering, chosen from the capture: markdown for prose, the
 * payload cards' pretty-printed JSON where the text parses as a JSON document —
 * a JSON message laid out as markdown collapses its structure into one
 * paragraph. `rendered` names the choice and is what the ViewSwitch shows.
 */
export function useMessageBody(text: string): { rendered: "md" | "json"; formatted: string } {
	const payload = useJsonPayload(text)
	return { rendered: payload.isJson ? "json" : "md", formatted: payload.formatted }
}

/**
 * The rendered ↔ raw selector: two labelled segments where the selected one is
 * the view the reader is IN — a lone pressed icon named either the current view
 * or the one a click would bring, depending on who read it.
 */
export function ViewSwitch({
	rendered,
	raw,
	onRawChange,
	className,
}: {
	/** The rendered segment's label — what the rendering IS: "md" or "json". */
	rendered: string
	raw: boolean
	onRawChange: (raw: boolean) => void
	className?: string
}) {
	return (
		<ToggleGroup
			aria-label="Body view"
			variant="outline"
			size="xs"
			value={[raw ? "raw" : "rendered"]}
			onValueChange={(next) => {
				// Clicking the pressed segment empties the group; the view stays put.
				if (next.length > 0) onRawChange(next[0] === "raw")
			}}
			className={cn("shrink-0 self-center", className)}
		>
			<ToggleGroupItem value="rendered" className={SEGMENT_CLASS} onClick={stopPropagation}>
				{rendered}
			</ToggleGroupItem>
			<ToggleGroupItem value="raw" className={SEGMENT_CLASS} onClick={stopPropagation}>
				raw
			</ToggleGroupItem>
		</ToggleGroup>
	)
}

const SEGMENT_CLASS = "font-mono text-[10px] uppercase tracking-[0.08em] sm:text-[10px]"

// The switch sits inside clickable rows; a segment click must not toggle the row.
const stopPropagation = (event: { stopPropagation: () => void }) => event.stopPropagation()

/**
 * Whether a keyed disclosure is open, given the default its section opens with.
 * Presence in the set means "flipped away from the default", so a toolbar chip
 * that changes the default still moves every row the reader has not touched.
 *
 * The set lives with the caller, never in the row: the transcript virtualizes,
 * and local state would leave with the row when it scrolls out of view.
 */
export function disclosed(openRows: ReadonlySet<string>, key: string, byDefault: boolean): boolean {
	return openRows.has(key) ? !byDefault : byDefault
}

/** The set with `id` flipped — the only write the disclosure set ever takes. */
export function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
	const next = new Set(set)
	if (!next.delete(id)) next.add(id)
	return next
}

/**
 * A captured message body, in whichever reading is selected, clamped with a
 * "Show full" control. Every message the transcript shows goes through here:
 * an uncapped body — one 900-line reply, one pasted file — pushes every row
 * after it off the page, and the list stops being a list.
 */
export function MessageBody({
	text,
	body,
	raw,
	clampLines,
	proseClassName = "text-foreground text-sm leading-relaxed",
	expanded,
	onToggleExpanded,
}: {
	text: string
	/** The reading chosen by `useMessageBody`, hoisted so the caller's ViewSwitch
	 *  can label the segment it selects. */
	body: { rendered: "md" | "json"; formatted: string }
	raw: boolean
	clampLines?: ClampLines
	proseClassName?: string
	expanded: boolean
	onToggleExpanded: () => void
}) {
	return (
		<ClampedText
			text={raw ? text : body.formatted}
			rendering={raw ? "text" : body.rendered}
			mono={!raw && body.rendered === "json"}
			clampLines={clampLines}
			proseClassName={proseClassName}
			expanded={expanded}
			onToggleExpanded={onToggleExpanded}
		/>
	)
}

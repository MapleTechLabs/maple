import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../button"

// Port of `ExcludedEmptyHint` (packages/ui/src/components/filters/excluded-empty-hint.tsx): why an
// empty list under an exclusion is empty, and the way out.

const MAX_NAMED_VALUES = 4

/** Nothing (`null`) when no value is excluded. */
export const excludedEmptyHint = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ excluded: ReadonlyArray<string>; onClear: M; className?: string }>,
): Html | null => {
	const { excluded } = options
	if (excluded.length === 0) return null
	const named = excluded.slice(0, MAX_NAMED_VALUES).join(", ")
	const rest = excluded.length - MAX_NAMED_VALUES
	const summary = rest > 0 ? `${named} +${rest} more` : named
	return h.div(
		[
			h.Class(
				cn(
					"mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-md border border-dashed border-destructive-a4 bg-destructive-a1 px-3 py-2 text-xs",
					options.className,
				),
			),
		],
		[
			h.span(
				[h.Class("text-muted-foreground")],
				[
					excluded.length === 1 ? "1 value is" : `${excluded.length} values are`,
					" being excluded:",
					" ",
					h.span([h.Class("text-destructive")], [summary]),
				],
			),
			button(h, { variant: "link", size: "xs", attributes: [h.OnClick(options.onClear)] }, [
				"Remove exclusions",
			]),
		],
	)
}

import type { ChipTone } from "@maple/ui/lib/log-attributes"
import type { Attribute, HtmlBuilder } from "foldkit/html"

/**
 * The class list as one `class` attribute. `h.Class` turns it into a class object that the differ
 * applies token by token (`classList.add` per class) on every created element: for virtualized rows
 * with 40-token Tailwind lists that was ~1.2ms of every scroll frame (S4 profile).
 */
export const rowClass = <Message>(h: HtmlBuilder<Message>, value: string): Attribute<Message> =>
	h.Attribute("class", value)

// styles: packages/ui/src/components/logs/log-attribute-chip.tsx
export const CHIP_TONE_CLASSES = {
	crit: "bg-severity-error-a2 text-severity-error border-severity-error-a3 hover:bg-severity-error-a2 active:bg-severity-error-a2",
	warn: "bg-severity-warn-a2 text-severity-warn border-severity-warn-a3 hover:bg-severity-warn-a2 active:bg-severity-warn-a2",
	emphasis: "bg-muted text-foreground-soft border-border hover:bg-surface-strong active:bg-surface-strong",
	muted: "bg-surface-sunken text-muted-foreground border-border-subtle hover:bg-surface-strong active:bg-surface-strong",
} satisfies Record<ChipTone, string>
/** The chip's key steps back from its value; error and warning keys keep their tone colour. */
export const CHIP_KEY_TONE_CLASSES = {
	crit: "opacity-70",
	warn: "opacity-70",
	// Full muted tone keeps the key at AA against the chip; the bright value carries the hierarchy.
	emphasis: "text-muted-foreground",
	muted: "opacity-70",
} satisfies Record<ChipTone, string>
export const CHIP_CLASS =
	"inline-flex items-center gap-1 h-[18px] min-w-0 px-1.5 rounded-sm border text-3xs font-mono leading-none whitespace-nowrap shrink-0 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
export const CHIP_FILTER_ACTION_CLASS =
	"inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-2xs text-muted-foreground hover:bg-muted active:bg-muted hover:text-foreground active:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

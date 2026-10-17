import { cn } from "@maple/ui/lib/utils"
import { cva } from "class-variance-authority"
import type { Attribute, HtmlBuilder } from "foldkit/html"

/**
 * The class list as one `class` attribute. `h.Class` turns it into a class object that the differ
 * applies token by token (`classList.add` per class) on every created element: for virtualized rows
 * with 40-token Tailwind lists that was ~1.2ms of every scroll frame (S4 profile).
 */
export const rowClass = <Message>(h: HtmlBuilder<Message>, value: string): Attribute<Message> =>
	h.Attribute("class", value)
import { TONE_SOFT } from "@maple/ui/lib/tone"
import type { ChipTone } from "@maple/ui/lib/log-attributes"

// styles: packages/ui/src/components/ui/eyebrow.tsx (a React module, so copied)
export const eyebrowVariants = cva("font-medium uppercase text-muted-foreground", {
	defaultVariants: { variant: "overline" },
	variants: {
		variant: {
			overline: "text-3xs tracking-[0.12em]",
			label: "text-2xs tracking-[0.08em]",
			mono: "font-mono text-3xs tracking-[0.12em] text-muted-foreground/70",
		},
	},
})

// styles: packages/ui/src/components/ui/badge.tsx
export const badgeVariants = cva(
	"relative inline-flex max-w-full shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-transparent font-medium outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [button&,a&]:cursor-pointer [button&,a&]:pointer-coarse:after:absolute [button&,a&]:pointer-coarse:after:size-full [button&,a&]:pointer-coarse:after:min-h-11 [button&,a&]:pointer-coarse:after:min-w-11",
	{
		compoundVariants: [
			{ class: "px-1.5", pill: true, size: "xs" },
			{ class: "px-2", pill: true, size: ["sm", "default"] },
			{ class: "px-2.5", pill: true, size: "lg" },
		],
		defaultVariants: { pill: false, size: "default", variant: "default" },
		variants: {
			size: {
				default:
					"h-5.5 min-w-5.5 px-[calc(--spacing(1)-1px)] text-sm sm:h-4.5 sm:min-w-4.5 sm:text-xs",
				lg: "h-6.5 min-w-6.5 px-[calc(--spacing(1.5)-1px)] text-base sm:h-5.5 sm:min-w-5.5 sm:text-sm",
				sm: "h-5 min-w-5 rounded-sm px-[calc(--spacing(1)-1px)] text-xs sm:h-4 sm:min-w-4 sm:text-3xs",
				xs: "h-4 min-w-4 rounded-sm px-1 text-3xs sm:h-4 sm:min-w-4 sm:text-3xs [&_svg:not([class*='size-'])]:size-2.5 sm:[&_svg:not([class*='size-'])]:size-2.5",
			},
			pill: { false: "", true: "rounded-full" },
			mono: { false: "", true: "font-mono tabular-nums" },
			variant: {
				default: "bg-primary text-primary-foreground [button&,a&]:hover:bg-primary/90",
				destructive: "bg-destructive text-white [button&,a&]:hover:bg-destructive/90",
				crit: TONE_SOFT.crit,
				info: TONE_SOFT.info,
				done: TONE_SOFT.done,
				muted: "bg-muted text-muted-foreground [button&,a&]:hover:bg-muted/80",
				meta: "border-border/70 bg-background text-muted-foreground [button&,a&]:hover:bg-muted/50",
				outline:
					"border-input bg-background text-foreground dark:bg-input/32 [button&,a&]:hover:bg-accent/50 dark:[button&,a&]:hover:bg-input/48",
				secondary: "bg-secondary text-secondary-foreground [button&,a&]:hover:bg-secondary/90",
				ok: TONE_SOFT.ok,
				warn: TONE_SOFT.warn,
				tag: "h-auto min-w-0 rounded-xs bg-muted px-1 py-px text-3xs text-muted-foreground uppercase tracking-wide sm:h-auto sm:min-w-0 sm:text-3xs [button&,a&]:hover:bg-muted/80 [button&,a&]:hover:text-foreground",
			},
		},
	},
)

// styles: packages/ui/src/components/logs/log-attribute-chip.tsx
export const CHIP_TONE_CLASSES = {
	crit: "bg-severity-error/10 text-severity-error border-severity-error/20 hover:bg-severity-error/15",
	warn: "bg-severity-warn/10 text-severity-warn border-severity-warn/20 hover:bg-severity-warn/15",
	emphasis: "bg-muted text-foreground/80 border-border hover:bg-muted/80",
	muted: "bg-muted/40 text-muted-foreground border-border/60 hover:bg-muted/70",
} satisfies Record<ChipTone, string>
export const CHIP_CLASS =
	"inline-flex items-center gap-1 h-[18px] min-w-0 px-1.5 rounded border text-3xs font-mono leading-none whitespace-nowrap shrink-0 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
export const CHIP_FILTER_ACTION_CLASS =
	"inline-flex h-6 items-center gap-1 rounded px-1.5 text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

// styles: packages/ui/src/components/ui/hover-card.tsx
export const HOVER_CARD_CONTENT_CLASS =
	"data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 bg-popover text-popover-foreground w-64 rounded-xl p-2.5 text-xs/relaxed shadow-md ring-1 duration-100 data-[side=inline-start]:slide-in-from-right-2 data-[side=inline-end]:slide-in-from-left-2 origin-(--transform-origin) outline-hidden"

// styles: packages/ui/src/components/ui/list-row.tsx (`ROW_LANE`, `rowSelectedClass`)
const ROW_LANE =
	"relative before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:transition-colors"
export const rowSelectedClass = (selected: boolean): string =>
	cn(ROW_LANE, selected ? "bg-muted/40 before:bg-primary" : "before:bg-transparent")

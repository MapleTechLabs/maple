import { TONE_FILL } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { cva, type VariantProps } from "class-variance-authority"
import type { Html, HtmlBuilder } from "foldkit/html"

// styles: packages/ui/src/components/ui/status-dot.tsx
export const statusDotVariants = cva("relative inline-flex shrink-0 rounded-full", {
	defaultVariants: { tone: "neutral", size: "default" },
	variants: {
		tone: {
			crit: TONE_FILL.crit,
			warn: TONE_FILL.warn,
			ok: TONE_FILL.ok,
			info: TONE_FILL.info,
			done: TONE_FILL.done,
			neutral: TONE_FILL.neutral,
			live: "bg-primary",
			custom: "",
		},
		size: {
			sm: "size-1",
			default: "size-1.5",
			lg: "size-2",
		},
	},
})

/** `<StatusDot>`: a static, decorative status dot. */
export const statusDot = <M>(h: HtmlBuilder<M>, options: VariantProps<typeof statusDotVariants>, className?: string): Html =>
	h.span([h.AriaHidden(true), h.Class(cn(statusDotVariants(options), className)), h.DataAttribute("slot", "status-dot")])

// styles: packages/ui/src/components/ui/eyebrow.tsx
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

/** `<Eyebrow>` as a `<span>`. */
export const eyebrow = <M>(h: HtmlBuilder<M>, className: string | undefined, children: ReadonlyArray<Html | string>): Html =>
	h.span([h.Class(cn(eyebrowVariants({}), className)), h.DataAttribute("slot", "eyebrow")], children)

/** `<MiddleTruncate>`: keeps the last `tail` characters visible, the full text in `title`. */
export const middleTruncate = <M>(h: HtmlBuilder<M>, text: string, tail: number, className: string): Html => {
	const chars = Array.from(text)
	const classes = cn("flex min-w-0 max-w-full", className)
	if (chars.length <= tail * 2) return h.span([h.Class(classes), h.Title(text)], [h.span([h.Class("truncate")], [text])])
	return h.span(
		[h.Class(classes), h.Title(text)],
		[
			h.span([h.Class("truncate")], [chars.slice(0, -tail).join("")]),
			h.span([h.Class("shrink-0 whitespace-pre")], [chars.slice(-tail).join("")]),
		],
	)
}

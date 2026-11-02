import { cn } from "@maple/ui/lib/utils"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"

// `Typography`: a run of text on the type scale and the text tones, instead of a hand-written
// `text-xs text-muted-foreground` string. Every option maps to one token; omit one to inherit it.

export type TypographySize = "4xs" | "3xs" | "2xs" | "xs" | "sm" | "base" | "lg"
export type TypographyTone =
	| "foreground"
	| "soft"
	| "muted"
	| "subtle"
	| "faint"
	| "primary"
	| "error"
	| "destructive"
	| "warning"
	| "success"
export type TypographyWeight = "normal" | "medium" | "semibold"

const SIZE = {
	"4xs": "text-4xs",
	"3xs": "text-3xs",
	"2xs": "text-2xs",
	xs: "text-xs",
	sm: "text-sm",
	base: "text-base",
	lg: "text-lg",
} as const satisfies Record<TypographySize, string>

const TONE = {
	foreground: "text-foreground",
	soft: "text-foreground-soft",
	muted: "text-muted-foreground",
	subtle: "text-foreground-subtle",
	faint: "text-foreground-faint",
	primary: "text-primary",
	error: "text-severity-error",
	/** A form error or a destructive action's text. */
	destructive: "text-destructive-foreground",
	warning: "text-severity-warn",
	success: "text-success",
} as const satisfies Record<TypographyTone, string>

const WEIGHT = {
	normal: "font-normal",
	medium: "font-medium",
	semibold: "font-semibold",
} as const satisfies Record<TypographyWeight, string>

export type TypographyOptions<M> = Readonly<{
	size?: TypographySize
	tone?: TypographyTone
	weight?: TypographyWeight
	/** Monospace. */
	mono?: boolean
	/** `tabular-nums`, for figures that line up. */
	numeric?: boolean
	truncate?: boolean
	/** The tone on hover and press, for text that is a control (a quiet link, a ghost icon button). */
	hoverTone?: TypographyHoverTone
	/** Underlined on hover and press, for a link set in running text. */
	hoverUnderline?: boolean
	as?: "span" | "p" | "div"
	/** Layout only (margins, `min-w-0`, `shrink-0`); type goes through the options. */
	className?: string
	attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
}>

export type TypographyHoverTone = "foreground"

const HOVER_TONE = {
	foreground: "hover:text-foreground active:text-foreground",
} as const satisfies Record<TypographyHoverTone, string>

export const typographyClass = (options: Omit<TypographyOptions<never>, "as" | "attributes">): string =>
	cn(
		options.size === undefined ? undefined : SIZE[options.size],
		options.tone === undefined ? undefined : TONE[options.tone],
		options.weight === undefined ? undefined : WEIGHT[options.weight],
		(options.mono ?? false) && "font-mono",
		(options.numeric ?? false) && "tabular-nums",
		(options.truncate ?? false) && "truncate",
		options.hoverTone === undefined ? undefined : HOVER_TONE[options.hoverTone],
		(options.hoverUnderline ?? false) && "underline-offset-4 hover:underline active:underline",
		options.className,
	)

export const typography = <M>(
	h: HtmlBuilder<M>,
	options: TypographyOptions<M>,
	children: ReadonlyArray<Html | string>,
): Html => {
	const attributes = [h.Class(typographyClass(options)), ...(options.attributes ?? [])]
	switch (options.as ?? "span") {
		case "span":
			return h.span(attributes, children)
		case "p":
			return h.p(attributes, children)
		case "div":
			return h.div(attributes, children)
	}
}

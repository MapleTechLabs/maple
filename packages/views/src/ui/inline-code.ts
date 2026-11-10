import { cn } from "@maple/ui/lib/utils"
import {
	inlineCodeChipStyles,
	inlineCodePlainStyles,
	inlineCodeStyles,
} from "@maple/ui/styles/ui/inline-code"
import type { Html, HtmlBuilder } from "foldkit/html"

export const inlineCodeClassName = (variant: "chip" | "plain", className?: string): string =>
	cn(inlineCodeStyles, variant === "chip" ? inlineCodeChipStyles : inlineCodePlainStyles, className)

const SIZE = { inherit: "", "2xs": "text-2xs" } as const
const TONE = { inherit: "", foreground: "text-foreground", muted: "text-muted-foreground" } as const

/** `InlineCode`: inline monospace for identifiers and commands inside prose. */
export const inlineCode = <Message>(
	h: HtmlBuilder<Message>,
	options: {
		readonly variant?: "chip" | "plain"
		/** `2xs` for ids in dense detail grids; otherwise it follows the surrounding text. */
		readonly size?: keyof typeof SIZE
		readonly tone?: keyof typeof TONE
		readonly className?: string
	},
	children: ReadonlyArray<Html | string>,
): Html =>
	h.code(
		[
			h.Class(
				inlineCodeClassName(
					options.variant ?? "chip",
					cn(SIZE[options.size ?? "inherit"], TONE[options.tone ?? "inherit"], options.className),
				),
			),
			h.DataAttribute("slot", "inline-code"),
		],
		children,
	)

import { cn } from "@maple/ui/lib/utils"
import {
	inlineCodeChipStyles,
	inlineCodePlainStyles,
	inlineCodeStyles,
} from "@maple/ui/styles/ui/inline-code"
import type { Html, HtmlBuilder } from "foldkit/html"

export const inlineCodeClassName = (variant: "chip" | "plain", className?: string): string =>
	cn(inlineCodeStyles, variant === "chip" ? inlineCodeChipStyles : inlineCodePlainStyles, className)

/** `InlineCode`: inline monospace for identifiers and commands inside prose. */
export const inlineCode = <Message>(
	h: HtmlBuilder<Message>,
	options: { readonly variant?: "chip" | "plain"; readonly className?: string },
	children: ReadonlyArray<Html | string>,
): Html =>
	h.code(
		[
			h.Class(inlineCodeClassName(options.variant ?? "chip", options.className)),
			h.DataAttribute("slot", "inline-code"),
		],
		children,
	)

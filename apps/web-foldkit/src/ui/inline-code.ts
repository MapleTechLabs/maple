import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

// styles: packages/ui/src/components/ui/inline-code.tsx (class composition copied; that module imports React)
export const inlineCodeClassName = (variant: "chip" | "plain", className?: string): string =>
	cn(
		"font-mono text-[0.9em]",
		variant === "chip" ? "rounded bg-muted px-1 py-px text-foreground" : "text-muted-foreground",
		className,
	)

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

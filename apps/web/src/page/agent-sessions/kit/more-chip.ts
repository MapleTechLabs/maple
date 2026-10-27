import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

/** The "+N" after a first name: a chip with a hover state, naming the hidden rest on hover. */
export const moreChip = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ count: number; names?: ReadonlyArray<string>; className?: string }>,
): Html =>
	h.span(
		[
			h.Class(
				cn(
					"shrink-0 cursor-default rounded-sm bg-muted/60 px-1 font-mono text-2xs tabular-nums text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
					options.className,
				),
			),
			...(options.names === undefined || options.names.length === 0
				? []
				: [h.Title(options.names.join(", "))]),
		],
		[`+${options.count}`],
	)

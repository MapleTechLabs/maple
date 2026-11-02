import { cn } from "@maple/ui/lib/utils"
import { truncatedTextMonoStyles, truncatedTextStyles } from "@maple/ui/styles/ui/truncated-text"
import type { Html, HtmlBuilder } from "foldkit/html"

// Port of packages/ui/src/components/ui/truncated-text.tsx, `tooltip="title" | "none"`.
// TODO(tooltip): `tooltip="overflow"` needs the Tooltip primitive (app-shell port).

export interface TruncatedTextOptions {
	readonly text: string
	readonly mono?: boolean
	readonly tooltip?: "title" | "none"
	readonly className?: string
}

/** Single-line text that ellipsizes, with the full value as the native tooltip. */
export const truncatedText = <M>(
	h: HtmlBuilder<M>,
	options: TruncatedTextOptions,
	children?: ReadonlyArray<Html | string>,
): Html =>
	h.span(
		[
			h.Class(
				cn(
					truncatedTextStyles,
					(options.mono ?? false) && truncatedTextMonoStyles,
					options.className,
				),
			),
			...((options.tooltip ?? "title") === "title" ? [h.Title(options.text)] : []),
		],
		children ?? [options.text],
	)

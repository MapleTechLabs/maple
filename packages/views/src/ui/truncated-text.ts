import { cn } from "@maple/ui/lib/utils"
import { truncatedTextMonoStyles, truncatedTextStyles } from "@maple/ui/styles/ui/truncated-text"
import type { Html, HtmlBuilder } from "foldkit/html"
import { tooltipTrigger } from "./tooltip-host"

// Port of packages/ui/src/components/ui/truncated-text.tsx.

export interface TruncatedTextOptions {
	readonly text: string
	readonly mono?: boolean
	/** `"overflow"`: the full value in a tooltip, only while it is cut off. */
	readonly tooltip?: "title" | "overflow" | "none"
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
			...(options.tooltip === "overflow"
				? tooltipTrigger(h, options.text, { isOverflowOnly: true })
				: []),
		],
		children ?? [options.text],
	)

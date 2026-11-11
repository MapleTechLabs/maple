import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Array as Arr } from "effect"

// A step flow's place, over a dialog's title: `1 WRITE / 2 REVIEW`.

/** `StepTrail`: a step flow's numbered steps in one mono uppercase row, the current one in primary. */
export const stepTrail = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ steps: ReadonlyArray<string>; current: number; className?: string }>,
): Html =>
	h.ol(
		[
			h.AriaLabel("Steps"),
			h.Class(
				cn(
					"flex items-center gap-2 font-mono text-2xs uppercase tracking-caption text-muted-foreground",
					options.className,
				),
			),
			h.DataAttribute("slot", "step-trail"),
		],
		Arr.map(options.steps, (step, index) =>
			h.li(
				[
					h.Key(step),
					h.Class("flex items-center gap-2"),
					...(index === options.current ? [h.AriaCurrent("step")] : []),
				],
				[
					...(index === 0 ? [] : [h.span([h.AriaHidden(true)], ["/"])]),
					h.span(
						[h.Class(index === options.current ? "text-primary" : "")],
						[`${index + 1} ${step}`],
					),
				],
			),
		),
	)

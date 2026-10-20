import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

// `RuleStep` and the editor's shared width.

/** `RULE_FORM_MAX_WIDTH`: the form body and the sticky action bar line up on it. */
export const RULE_FORM_MAX_WIDTH = "max-w-[1400px]"

export type RuleStepStatus = "done" | "missing" | "optional"

export type RuleStepOptions = Readonly<{
	number: number
	title: string
	hint?: string
	status: RuleStepStatus
	/** A rule above the step; off for the first step and for steps sharing a row. */
	hasDivider?: boolean
}>

/** One numbered step of the rule editor; says "Required" until it is filled in. */
export const ruleStep = <M>(h: HtmlBuilder<M>, options: RuleStepOptions, children: ReadonlyArray<Html>): Html => {
	const headingId = `rule-step-${options.number}`
	return h.section(
		[
			h.AriaLabelledBy(headingId),
			h.Class(cn("space-y-4", (options.hasDivider ?? true) && "border-t pt-8")),
		],
		[
			h.div(
				[h.Class("flex items-start justify-between gap-4")],
				[
					h.div(
						[h.Class("space-y-1")],
						[
							h.div(
								[h.Class("flex items-baseline gap-3")],
								[
									h.h2(
										[
											h.Id(headingId),
											h.Class("font-display text-lg font-medium tracking-tight text-foreground"),
										],
										[
											h.span(
												[h.Class("mr-2.5 font-mono text-sm font-normal text-muted-foreground")],
												[String(options.number)],
											),
											options.title,
										],
									),
									...(options.status === "missing"
										? [h.span([h.Class("text-xs text-severity-warn")], ["Required"])]
										: []),
								],
							),
							...(options.hint === undefined
								? []
								: [h.p([h.Class("text-xs text-muted-foreground")], [options.hint])]),
						],
					),
				],
			),
			...children,
		],
	)
}

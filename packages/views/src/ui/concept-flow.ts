import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon, type IconName } from "./icon"
import { panel } from "./panel"
import { typography } from "./typography"

// `ConceptFlow`: a short primer at the top of a page that introduces an idea: a title, one lead
// sentence, then the concepts it is built from as tiles joined by arrows (each leads to the next),
// stacked on narrow screens, and a footer for links.

export type ConceptFlowStep = Readonly<{ icon: IconName; title: string; body: ReadonlyArray<Html | string> }>

const arrow = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[
			h.Class("flex items-center justify-center self-center text-foreground-faint max-md:rotate-90"),
			h.AriaHidden(true),
		],
		[icon(h, "ArrowRightIcon", { size: 16 })],
	)

const tile = <M>(h: HtmlBuilder<M>, step: ConceptFlowStep): Html =>
	h.li(
		[h.Class("flex min-w-0 flex-1 gap-3 rounded-lg bg-surface-faint p-3")],
		[
			h.div(
				[
					h.Class(
						"flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-card text-primary",
					),
					h.AriaHidden(true),
				],
				[icon(h, step.icon, { size: 16 })],
			),
			h.div(
				[h.Class("flex min-w-0 flex-col gap-0.5")],
				[
					typography(h, { size: "sm", weight: "medium", as: "span" }, [step.title]),
					typography(
						h,
						{ size: "xs", tone: "muted", as: "span", className: "font-prose" },
						step.body,
					),
				],
			),
		],
	)

export const conceptFlow = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		/** The heading id, so the section is labelled by its title. */
		id: string
		title: string
		lead: ReadonlyArray<Html | string>
		steps: ReadonlyArray<ConceptFlowStep>
		footer?: ReadonlyArray<Html>
	}>,
): Html =>
	panel(
		h,
		{ padded: true, attributes: [h.AriaLabelledBy(options.id), h.DataAttribute("slot", "concept-flow")] },
		[
			h.div(
				[h.Class("flex flex-col gap-4")],
				[
					h.div(
						[h.Class("flex flex-col gap-1")],
						[
							h.h2(
								[h.Id(options.id), h.Class("text-sm font-medium text-foreground")],
								[options.title],
							),
							typography(
								h,
								{ size: "sm", tone: "muted", as: "p", className: "font-prose" },
								options.lead,
							),
						],
					),
					h.ol(
						[h.Class("flex flex-col items-stretch gap-2 md:flex-row")],
						Arr.flatMap(options.steps, (step, index) =>
							index === 0
								? [tile(h, step)]
								: [
										h.li([h.Class("contents"), h.AriaHidden(true)], [arrow(h)]),
										tile(h, step),
									],
						),
					),
					...(options.footer === undefined || options.footer.length === 0
						? []
						: [
								h.div(
									[h.Class("flex flex-wrap items-center gap-x-4 gap-y-1 text-sm")],
									options.footer,
								),
							]),
				],
			),
		],
	)

import { cn } from "@maple/ui/lib/utils"
import type { GcpManualStep, GcpStepField } from "../../components/integrations/gcp-setup-steps"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../ui/icon"
import { inlineCode } from "../../ui/inline-code"
import type { ConfigureModel } from "./gcp-configure-schema"
import { Message } from "./message"
import type { Model } from "./model"
import { externalLink } from "./view-gcp-configure-parts"
import { copyOf, GCP_TITLE, SMALL } from "./view-gcp-parts"

// `GcpValue` and `GcpManualSteps`.

type H = HtmlBuilder<Message>

/** An exact name in mono with its copy button, or a setting in words. */
export const gcpValue = (h: H, model: Model, value: GcpStepField["value"], copy = true): Html => {
	if (typeof value !== "string")
		return h.span(
			[h.Class("flex flex-wrap gap-x-2 gap-y-1")],
			value.map((one) => gcpValue(h, model, one, copy)),
		)
	if (!copy) return h.span([h.Class("text-foreground")], [value])
	return h.span(
		[h.Class("inline-flex max-w-full items-start gap-0.5")],
		[
			inlineCode(h, { className: "min-w-0 break-all text-xs/5" }, [value]),
			copyOf(h, model, `value-${value}`, value, {
				label: "value",
				iconSize: 12,
				className: "size-6 shrink-0",
			}),
		],
	)
}

/** A removal row: what, its name to copy, and where in the console. */
export const removalItem = (
	h: H,
	model: Model,
	item: Readonly<{ what: string; name: string; consoleUrl: string }>,
): Html =>
	h.li(
		[h.Key(item.what)],
		[
			h.span([h.Class("text-muted-foreground")], [item.what]),
			" ",
			gcpValue(h, model, item.name),
			" ",
			externalLink(h, item.consoleUrl, "Open in console"),
		],
	)

const manualStepBody = (h: H, model: Model, step: GcpManualStep): Html =>
	h.div(
		[h.Class("flex flex-col gap-3 pr-4 pb-4 pl-12")],
		[
			h.p(
				[h.Class(SMALL)],
				[
					step.intro,
					" ",
					h.a(
						[
							h.Href(step.consoleUrl),
							h.Target("_blank"),
							h.Rel("noreferrer"),
							h.Class(
								"inline-flex items-center gap-1 font-medium text-foreground hover:underline",
							),
						],
						["Open in console", icon(h, "ExternalLinkIcon", { size: 12 })],
					),
				],
			),
			h.dl(
				[
					h.Class(
						"grid grid-cols-1 items-baseline gap-x-4 gap-y-1 text-xs/5 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:gap-y-2",
					),
				],
				step.fields.map((field) =>
					h.div(
						[h.Key(field.label), h.Class("contents")],
						[
							h.dt([h.Class("text-muted-foreground")], [field.label]),
							h.dd([h.Class("min-w-0")], [gcpValue(h, model, field.value, field.copy)]),
						],
					),
				),
			),
			...(step.notes.length === 0
				? []
				: [
						h.ul(
							[
								h.Class(
									"flex list-disc flex-col gap-1 pl-4 text-xs/5 text-pretty text-muted-foreground",
								),
							],
							step.notes.map((note) => h.li([h.Key(note)], [note])),
						),
					]),
		],
	)

/** The console steps as one list, one open at a time; untouched, the first is open. */
export const manualSteps = (
	h: H,
	model: Model,
	configure: ConfigureModel,
	options: Readonly<{
		heading: string
		detail: string
		steps: ReadonlyArray<GcpManualStep>
		docsHref: string
	}>,
): Html => {
	const firstTitle = options.steps[0]?.title ?? null
	const open = configure.isManualTouched ? configure.manualOpen : firstTitle
	return h.section(
		[h.Class("flex flex-col gap-3")],
		[
			h.div(
				[h.Class("flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1")],
				[
					h.div(
						[h.Class("flex flex-col gap-0.5")],
						[
							h.h3([h.Class(GCP_TITLE)], [options.heading]),
							h.p([h.Class(SMALL)], [options.detail]),
						],
					),
					h.span(
						[h.Class("text-xs/5")],
						[externalLink(h, options.docsHref, "Full guide in the docs")],
					),
				],
			),
			h.ol(
				[h.Class("divide-y divide-border/60 rounded-md border")],
				options.steps.map((step, index) => {
					const expanded = open === step.title
					return h.li(
						[h.Key(step.title)],
						[
							h.div(
								[h.Class("flex items-center gap-3 px-4 py-3")],
								[
									h.span(
										[
											h.AriaHidden(true),
											h.Class(
												"flex size-5 shrink-0 items-center justify-center rounded-full border text-2xs font-medium text-muted-foreground",
											),
										],
										[String(index + 1)],
									),
									h.button(
										[
											h.Type("button"),
											h.AriaExpanded(expanded),
											h.OnClick(
												Message.ClickedGcpManualStep({
													title: step.title,
													firstTitle,
												}),
											),
											h.Class(
												"flex min-w-0 flex-1 items-center gap-3 text-left text-sm font-medium outline-none focus-visible:underline",
											),
										],
										[
											h.span([h.Class("min-w-0 flex-1")], [step.title]),
											...(expanded
												? []
												: [
														h.span(
															[
																h.Class(
																	"max-w-1/2 min-w-0 truncate font-mono text-xs font-normal text-muted-foreground",
																),
															],
															[step.summary],
														),
													]),
											icon(h, "ChevronDownIcon", {
												size: 14,
												className: cn(
													"shrink-0 text-muted-foreground transition-transform",
													expanded && "rotate-180",
												),
											}),
										],
									),
								],
							),
							...(expanded ? [manualStepBody(h, model, step)] : []),
						],
					)
				}),
			),
		],
	)
}

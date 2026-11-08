import { cn } from "@maple/ui/lib/utils"
import type { GcpManualStep, GcpStepField } from "../../components/integrations/gcp-setup-steps"
import type { Html, HtmlBuilder } from "foldkit/html"
import { pressable } from "@maple/views/ui/pressable"
import { heading } from "@maple/views/ui/heading"
import { icon } from "@maple/views/ui/icon"
import { inlineCode } from "@maple/views/ui/inline-code"
import type { ConfigureModel } from "./gcp-configure-schema"
import { Message } from "./message"
import type { Model } from "./model"
import { externalLink } from "./view-gcp-configure-parts"
import { copyOf, SMALL } from "./view-gcp-parts"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"
import { textLink } from "@maple/views/ui/text-link"
import { dividedList } from "@maple/views/ui/rule"

// `GcpValue` and `GcpManualSteps`.

type H = HtmlBuilder<Message>

/** An exact name in mono with its copy button, or a setting in words. */
export const gcpValue = (h: H, model: Model, value: GcpStepField["value"], copy = true): Html => {
	if (typeof value !== "string")
		return hstack(
			h,
			{ align: "stretch", wrap: true, as: "span", className: "gap-x-2 gap-y-1" },
			Arr.map(value, (one) => gcpValue(h, model, one, copy)),
		)
	if (!copy) return typography(h, { tone: "foreground" }, [value])
	return hstack(h, { gap: "0.5", align: "start", inline: true, as: "span", className: "max-w-full" }, [
		inlineCode(h, { className: "min-w-0 break-all text-xs/5" }, [value]),
		copyOf(h, model, `value-${value}`, value, {
			label: "value",
			iconSize: 12,
			className: "size-6 shrink-0",
		}),
	])
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
			typography(h, { tone: "muted" }, [item.what]),
			" ",
			gcpValue(h, model, item.name),
			" ",
			externalLink(h, item.consoleUrl, "Open in console"),
		],
	)

const manualStepBody = (h: H, model: Model, step: GcpManualStep): Html =>
	vstack(h, { gap: "3", className: "pr-4 pb-4 pl-12" }, [
		h.p(
			[h.Class(SMALL)],
			[
				step.intro,
				" ",
				textLink(
					h,
					{
						href: step.consoleUrl,
						tone: "inherit",
						className: "font-medium text-foreground",
						attributes: [h.Target("_blank"), h.Rel("noreferrer")],
					},
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
			Arr.map(step.fields, (field) =>
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
					vstack(
						h,
						{
							gap: "1",
							as: "ul",
							className: "list-disc pl-4 text-xs/5 text-pretty text-muted-foreground",
						},
						Arr.map(step.notes, (note) => h.li([h.Key(note)], [note])),
					),
				]),
	])

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
	return vstack(h, { gap: "3", as: "section" }, [
		hstack(h, { align: "baseline", justify: "between", wrap: true, className: "gap-x-4 gap-y-1" }, [
			vstack(h, { gap: "0.5" }, [
				heading(h, { level: 3, variant: "subsection" }, [options.heading]),
				h.p([h.Class(SMALL)], [options.detail]),
			]),
			h.span([h.Class("text-xs/5")], [externalLink(h, options.docsHref, "Full guide in the docs")]),
		]),
		dividedList(
			h,
			{ as: "ol", className: "divide-border-subtle" },
			Arr.map(options.steps, (step, index) => {
				const expanded = open === step.title
				return h.li(
					[h.Key(step.title)],
					[
						hstack(h, { gap: "3", className: "px-4 py-3" }, [
							hstack(
								h,
								{
									align: "center",
									justify: "center",
									as: "span",
									className:
										"size-5 shrink-0 rounded-full border text-2xs font-medium text-muted-foreground",
									attributes: [h.AriaHidden(true)],
								},
								[String(index + 1)],
							),
							pressable(
								h,
								{
									onClick: Message.ClickedGcpManualStep({ title: step.title, firstTitle }),
									className:
										"flex min-w-0 flex-1 items-center gap-3 text-left text-sm font-medium outline-none focus-visible:underline focus-visible:ring-0",
									attributes: [h.AriaExpanded(expanded)],
								},
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
											typographyClass({
												tone: "muted",
												className: "shrink-0 transition-transform",
											}),
											expanded && "rotate-180",
										),
									}),
								],
							),
						]),
						...(expanded ? [manualStepBody(h, model, step)] : []),
					],
				)
			}),
		),
	])
}

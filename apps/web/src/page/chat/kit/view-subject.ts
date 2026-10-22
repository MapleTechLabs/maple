import { shortId } from "@maple/ui/lib/ids"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../../../ui/eyebrow"
import { panel } from "../../../ui/panel"
import { statusDot } from "../../../ui/status-dot"
import type { InvestigationContext, WidgetFixContext } from "./subject"

// `AttachmentCard`, `InvestigationAttachmentCard`
// and `WidgetFixAttachmentCard`: the subject pinned above the thread.

const ACCENT = new Map([
	["critical", { stripe: "bg-severity-fatal", tint: "bg-severity-fatal/[0.04]" }],
	["high", { stripe: "bg-severity-error", tint: "bg-severity-error/[0.04]" }],
	["warning", { stripe: "bg-severity-warn", tint: "bg-severity-warn/[0.04]" }],
	["medium", { stripe: "bg-severity-warn", tint: "bg-severity-warn/[0.04]" }],
	["low", { stripe: "bg-severity-debug", tint: "bg-severity-debug/[0.04]" }],
])

const KIND_LABEL = {
	alert: "Attached alert",
	anomaly: "Attached anomaly",
	error: "Attached error",
	freeform: "Investigation subject",
} satisfies Record<InvestigationContext["kind"], string>

const STATUS_TONE = new Map([
	["Firing", TONE_TEXT.crit],
	["Open", TONE_TEXT.crit],
	["Resolved", TONE_TEXT.info],
])

/** The last dash segment of a UUID-ish id, cut to 8 chars. */
const attachmentId = (id: string): string => shortId(id.split("-").at(-1) ?? id, "generic", { length: 8 })

const attachmentCard = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ stripe: string; tint: string; meta: ReadonlyArray<Html>; title: string }>,
	children: ReadonlyArray<Html>,
): Html =>
	h.div(
		[h.Class("mx-auto w-full max-w-3xl px-4 pt-3")],
		[
			panel(h, { className: cn("relative bg-card/80 backdrop-blur-sm", options.tint) }, [
				h.div(
					[h.Class(cn("absolute inset-y-0 left-0 w-[3px]", options.stripe)), h.AriaHidden(true)],
					[],
				),
				h.div(
					[h.Class("min-w-0 py-2.5 pr-3 pl-3.5")],
					[
						eyebrow(
							h,
							{
								as: "div",
								className: "flex flex-wrap items-center gap-x-2 gap-y-0.5 font-normal",
							},
							options.meta.flatMap((item, index) =>
								index > 0
									? [
											h.span(
												[
													h.Class("size-0.5 rounded-full bg-muted-foreground/40"),
													h.AriaHidden(true),
												],
												[],
											),
											item,
										]
									: [item],
							),
						),
						h.div(
							[h.Class("mt-1 truncate text-ui font-medium text-foreground")],
							[options.title],
						),
						...children,
					],
				),
			]),
		],
	)

/** `InvestigationAttachmentCard`. */
export const investigationCard = <M>(h: HtmlBuilder<M>, ctx: InvestigationContext): Html => {
	const accent = ACCENT.get(ctx.severity) ?? { stripe: "bg-muted-foreground", tint: "bg-muted/30" }
	const statusTone = STATUS_TONE.get(ctx.status) ?? "text-muted-foreground"
	return attachmentCard(
		h,
		{
			stripe: accent.stripe,
			tint: accent.tint,
			title: ctx.title,
			meta: [
				h.span([h.Class("font-medium")], [KIND_LABEL[ctx.kind]]),
				h.span([h.Class("font-mono capitalize")], [ctx.severity]),
				h.span(
					[h.Class(cn("inline-flex items-center gap-1 font-mono", statusTone))],
					[
						ctx.status === "Resolved"
							? statusDot(h, { tone: "ok" })
							: statusDot(h, { tone: "custom", className: accent.stripe }),
						ctx.status,
					],
				),
				h.span([h.Class("font-mono normal-case tracking-normal")], ["#", attachmentId(ctx.id)]),
			],
		},
		ctx.facts.length === 0
			? []
			: [
					h.ul(
						[h.Class("mt-2 flex flex-wrap gap-x-5 gap-y-1.5")],
						ctx.facts.map((fact) =>
							h.li(
								[h.Class("flex min-w-0 flex-col leading-tight")],
								[
									eyebrow(h, {}, [fact.label]),
									h.span(
										[h.Class("truncate font-mono text-2xs text-foreground")],
										[fact.value],
									),
								],
							),
						),
					),
				],
	)
}

/** `WidgetFixAttachmentCard`. */
export const widgetFixCard = <M>(h: HtmlBuilder<M>, ctx: WidgetFixContext): Html =>
	attachmentCard(
		h,
		{
			stripe: "bg-severity-error",
			tint: "bg-severity-error/[0.04]",
			title: ctx.widgetTitle || "Untitled widget",
			meta: [
				h.span([h.Class("font-medium")], ["Broken widget"]),
				h.span(
					[h.Class("font-mono normal-case tracking-normal")],
					[attachmentId(ctx.dashboardId), "/", attachmentId(ctx.widgetId)],
				),
			],
		},
		ctx.errorTitle || ctx.errorMessage
			? [
					h.div(
						[h.Class("mt-2 space-y-0.5")],
						[
							...(ctx.errorTitle
								? [
										h.div(
											[h.Class("text-2xs font-medium text-severity-error")],
											[ctx.errorTitle],
										),
									]
								: []),
							...(ctx.errorMessage
								? [
										h.div(
											[h.Class("text-2xs text-severity-error/80 line-clamp-2")],
											[ctx.errorMessage],
										),
									]
								: []),
						],
					),
				]
			: [],
	)

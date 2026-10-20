import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as DialogView from "../../ui/dialog-view"
import { icon } from "../../ui/icon"
import { STEPS } from "./gcp-configure-copy"
import { CONFIGURE_DIALOG_ID } from "./gcp-configure"
import type { Message } from "./message"
import { GCP_LINK } from "./view-gcp-parts"

// `GcpExternalLink`, `Mono`, `Chip`, `FooterNote`, `Stepper` and `ConfigureHeader`.

type H = HtmlBuilder<Message>
type Children = ReadonlyArray<Html | string>

/** A named link stays on one line; the icon never wraps away from the last word. */
export const externalLink = (h: H, href: string, children: string): Html =>
	h.a(
		[
			h.Href(href),
			h.Target("_blank"),
			h.Rel("noreferrer"),
			h.Class(cn(GCP_LINK, children !== href && "whitespace-nowrap")),
		],
		[
			children,
			h.span(
				[h.Class("whitespace-nowrap")],
				["⁠", icon(h, "ExternalLinkIcon", { size: 12, className: "ml-1 inline align-[-1px]" })],
			),
		],
	)

/** An identifier inside a sentence: mono without a chip. */
export const mono = (h: H, text: string): Html =>
	h.span([h.Class("font-mono whitespace-nowrap text-foreground")], [text])

export const chip = (h: H, children: Children): Html =>
	h.span(
		[
			h.Class(
				"inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-0.5 text-xs/5",
			),
		],
		children,
	)

/** One short line at the footer's start: why the action waits, or what closing leaves behind. */
export const footerNote = (h: H, children: Children): Html =>
	h.p([h.Class("text-xs/5 text-pretty text-muted-foreground sm:mr-auto sm:self-center")], children)

export type StepIndex = 0 | 1 | 2 | 3

/** Where the flow is: done steps are checked, the current one is filled, later ones are outlined. */
const stepper = (h: H, current: StepIndex): Html =>
	h.ol(
		[h.Class("flex items-center gap-3 text-sm")],
		STEPS.map((label, index) => {
			const done = index < current
			const active = index === current
			return h.li(
				[
					...(active ? [h.AriaCurrent("step")] : []),
					h.Class(cn("flex items-center gap-3", index > 0 && "flex-1")),
				],
				[
					...(index === 0
						? []
						: [
								h.span([
									h.AriaHidden(true),
									h.Class(
										cn("h-px flex-1", done || active ? "bg-foreground/24" : "bg-border"),
									),
								]),
							]),
					h.span(
						[h.Class("flex shrink-0 items-center gap-2")],
						[
							h.span(
								[
									h.AriaHidden(true),
									h.Class(
										cn(
											"flex size-5 items-center justify-center rounded-full text-2xs font-medium tabular-nums",
											done
												? "bg-severity-info/16 text-severity-info"
												: active
													? "bg-primary text-primary-foreground"
													: "border border-input text-muted-foreground",
										),
									),
								],
								[done ? icon(h, "CheckIcon", { size: 12 }) : String(index + 1)],
							),
							h.span(
								[
									h.Class(
										active
											? "font-medium text-foreground"
											: done
												? "text-foreground"
												: "text-muted-foreground",
									),
								],
								[label, ...(done ? [h.span([h.Class("sr-only")], [" (done)"])] : [])],
							),
						],
					),
				],
			)
		}),
	)

/** `step` is null once every step is done: the finished flow shows no stepper. */
export const configureHeader = (h: H, title: Children, step: StepIndex | null): Html =>
	DialogView.dialogHeader(
		h,
		"dialog",
		[
			DialogView.dialogTitle(
				h,
				"dialog",
				CONFIGURE_DIALOG_ID,
				[
					h.span(
						[
							h.Class(
								"flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/60",
							),
						],
						[icon(h, "GoogleCloudIcon", { size: 18 })],
					),
					h.span([h.Class("min-w-0")], title),
				],
				"flex items-center gap-3 pr-8",
			),
			...(step === null ? [] : [stepper(h, step)]),
		],
		"gap-5",
	)

export const configurePanel = (h: H, children: ReadonlyArray<Html>, className?: string): Html =>
	DialogView.dialogPanel(h, "dialog", CONFIGURE_DIALOG_ID, children, className)

export const configureFooter = (h: H, children: ReadonlyArray<Html>): Html =>
	DialogView.dialogFooter(h, "dialog", children)

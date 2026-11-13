import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as DialogView from "@maple/views/ui/dialog-view"
import { icon } from "@maple/views/ui/icon"
import { answerTrail } from "@maple/views/ui/answer-trail"
import { STEPS } from "./gcp-configure-copy"
import { CONFIGURE_DIALOG_ID } from "./gcp-configure"
import type { Message } from "../../../integrations/message"
import { GCP_LINK } from "./view-gcp-parts"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"
import { typography } from "@maple/views/ui/typography"

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
	typography(h, { tone: "foreground", mono: true, className: "whitespace-nowrap" }, [text])

export const chip = (h: H, children: Children): Html =>
	hstack(
		h,
		{
			gap: "1.5",
			align: "center",
			inline: true,
			as: "span",
			className: "rounded-md border border-border-subtle bg-surface-sunken px-2 py-0.5 text-xs/5",
		},
		children,
	)

/** One short line at the footer's start: why the action waits, or what closing leaves behind. */
export const footerNote = (h: H, children: Children): Html =>
	h.p(
		[h.Class("font-prose text-xs/5 text-pretty text-muted-foreground sm:mr-auto sm:self-center")],
		children,
	)

export type StepIndex = 0 | 1 | 2 | 3

/** Where the flow is, the same trail as `/sources/new`: done steps checked, the current one underlined. */
const stepper = (h: H, current: StepIndex): Html =>
	answerTrail(h, {
		label: "Setup progress",
		steps: Arr.map(STEPS, (label, index) => ({
			label,
			state: index < current ? "done" : index === current ? "current" : "next",
		})),
	})

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
					hstack(
						h,
						{
							align: "center",
							justify: "center",
							as: "span",
							className: "size-8 shrink-0 rounded-md border bg-surface-strong",
						},
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

// The popup reads in the display face; the footer's buttons keep the standard button face.
export const configureFooter = (h: H, children: ReadonlyArray<Html>): Html =>
	DialogView.dialogFooter(h, "dialog", children, "font-sans")

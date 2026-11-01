import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { cloudShellUrl } from "../../components/integrations/gcp-connector-state"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "../../ui/button"
import * as CopyButton from "../../ui/copy-button"
import { eyebrow } from "../../ui/eyebrow"
import { icon } from "../../ui/icon"
import { inlineCode } from "../../ui/inline-code"
import { skeleton } from "../../ui/skeleton"
import { spinner } from "../../ui/spinner"
import { Message } from "./message"
import type { Model } from "./model"

// `GcpCommand`, `GcpOpenCloudShellButton`, `GcpCopyScriptButton`, `Script` and `Step`.

type H = HtmlBuilder<Message>

export const GCP_LINK = "underline underline-offset-2 hover:no-underline active:no-underline"
export const SMALL = "text-xs/5 text-pretty text-muted-foreground"
export const GCP_TITLE = "text-base/6 font-medium sm:text-sm/5"

export const copyOf = (
	h: H,
	model: Model,
	id: string,
	value: string,
	options: Omit<CopyButton.CopyButtonViewConfig<Message>, "model" | "toParentMessage" | "value">,
): Html =>
	CopyButton.view(h, {
		...options,
		model: model.gcpCard.copies[id] ?? CopyButton.init(),
		toParentMessage: (message) => Message.GotGcpCopyMessage({ id, message }),
		value,
	})

/** A shell command to copy; too long for its line, it breaks between its words only. */
export const gcpCommand = (h: H, model: Model, id: string, command: string): Html =>
	h.span(
		[h.Class("inline-flex max-w-full items-start gap-0.5 align-top")],
		[
			inlineCode(
				h,
				{ className: "min-w-0" },
				command
					.split(" ")
					.flatMap((word, index) => [
						...(index === 0 ? [] : [" "]),
						h.span([h.Class("whitespace-nowrap")], [word]),
					]),
			),
			copyOf(h, model, id, command, { label: "command", iconSize: 12, className: "size-5" }),
		],
	)

export const openCloudShellButton = (
	h: H,
	projectId: string,
	variant: "default" | "outline" = "outline",
): Html =>
	linkButton(
		h,
		{
			size: "sm",
			variant,
			attributes: [h.Target("_blank"), h.Rel("noreferrer")],
			href: cloudShellUrl(projectId),
		},
		["Open Cloud Shell", icon(h, "ExternalLinkIcon")],
	)

export const copyScriptButton = (
	h: H,
	model: Model,
	id: string,
	script: string | null,
	label: string,
): Html =>
	copyOf(h, model, id, script ?? "", {
		label,
		idleLabel: `Copy ${label}`,
		variant: "default",
		className: "text-primary-foreground hover:text-primary-foreground active:text-primary-foreground",
		attributes: script === null ? [h.Disabled(true)] : [],
	})

export type ScriptFailure = Readonly<{ message: string; isRetrying: boolean }>

/** `Script`: copy, read on request; `leading` are the buttons before the copy button. */
export const scriptBlock = (
	h: H,
	model: Model,
	options: Readonly<{ id: string; script: string | null; label: string; failure: ScriptFailure | null }>,
	leading: ReadonlyArray<Html>,
): Html => {
	const shown = model.gcpCard.isScriptShown
	const text = options.script?.trimEnd() ?? null
	return h.div(
		[h.Class("flex flex-col gap-2")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-x-3 gap-y-2")],
				[
					...leading,
					copyScriptButton(h, model, options.id, options.script, options.label),
					button(
						h,
						{
							variant: "link",
							size: "xs",
							className: cn(
								"h-auto p-0 font-normal text-xs text-muted-foreground hover:text-foreground active:text-foreground",
								GCP_LINK,
							),
							attributes: [h.AriaExpanded(shown), h.OnClick(Message.ClickedGcpScriptToggle())],
						},
						[shown ? "Hide the script" : "Read the script"],
					),
				],
			),
			...(options.failure === null
				? []
				: [
						h.div(
							[h.Class("flex flex-wrap items-center gap-2")],
							[
								h.p(
									[h.Class("text-xs text-severity-error"), h.Role("alert")],
									[options.failure.message],
								),
								button(
									h,
									{
										size: "sm",
										variant: "outline",
										isLoading: options.failure.isRetrying,
										attributes: [h.OnClick(Message.ClickedGcpScriptRetry())],
									},
									["Try again"],
								),
							],
						),
					]),
			h.p(
				[h.Class(cn(SMALL, "flex items-start gap-1.5"))],
				[
					icon(h, "LockIcon", { size: 12, className: "mt-1 shrink-0" }),
					"Holds this connection's secret. Don't share or commit it.",
				],
			),
			...(!shown || options.failure !== null
				? []
				: text === null
					? [skeleton(h, "mt-1 h-72 w-full")]
					: [scriptText(h, options.label, text)]),
		],
	)
}

const scriptText = (h: H, label: string, text: string): Html =>
	h.div(
		[h.Class("mt-1 overflow-clip rounded-md border border-border bg-muted")],
		[
			h.div(
				[h.Class("flex items-center justify-between px-3 py-1.5")],
				[
					eyebrow(h, {}, ["Bash"]),
					h.span(
						[h.Class("text-2xs text-muted-foreground")],
						[countLabel(text.split("\n").length, "line")],
					),
				],
			),
			h.pre(
				[
					h.Tabindex(0),
					h.Role("region"),
					h.AriaLabel(`The ${label}`),
					h.Class(
						"max-h-80 overflow-auto bg-background/50 p-3 font-mono text-xs/5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 rr-block",
					),
				],
				[text],
			),
		],
	)

export type StepState = "current" | "pending" | "waiting" | "done"

/** `Step`: a numbered marker on a line to the next step, the title, a line under it, the controls. */
export const step = (
	h: H,
	options: Readonly<{
		number: number
		state: StepState
		title: string
		detail?: ReadonlyArray<Html | string>
	}>,
	children: ReadonlyArray<Html>,
): Html =>
	h.li(
		[
			h.Class(
				cn(
					"relative flex gap-3 before:absolute before:top-6 before:bottom-1 before:left-2.5 before:w-px before:-translate-x-1/2 before:bg-border last:pb-0 last:before:hidden",
					options.state === "done" ? "pb-4" : "pb-6",
				),
			),
		],
		[
			options.state === "done"
				? icon(h, "CircleCheckIcon", { size: 20, className: "shrink-0 text-severity-info" })
				: options.state === "waiting"
					? spinner(h, "size-5 shrink-0 p-0.5 text-muted-foreground")
					: h.span(
							[
								h.AriaHidden(true),
								h.Class(
									cn(
										"flex size-5 shrink-0 items-center justify-center rounded-full border text-2xs font-medium",
										options.state === "current"
											? "border-border-strong text-foreground"
											: "border-border text-muted-foreground",
									),
								),
							],
							[String(options.number)],
						),
			h.div(
				[h.Class("flex min-w-0 flex-1 flex-col gap-2.5")],
				[
					h.div(
						[h.Class("flex flex-col gap-0.5")],
						[
							h.h4(
								[
									h.Class(
										cn(GCP_TITLE, options.state === "pending" && "text-muted-foreground"),
									),
								],
								[options.title],
							),
							...(options.detail === undefined ? [] : [h.p([h.Class(SMALL)], options.detail)]),
						],
					),
					...children,
				],
			),
		],
	)

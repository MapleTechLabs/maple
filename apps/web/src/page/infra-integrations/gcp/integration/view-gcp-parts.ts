import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { cloudShellUrl } from "../connector-state"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "@maple/views/ui/button"
import * as CopyButton from "@maple/views/ui/copy-button"
import { codeBlock } from "../../../kit/code-block"
import { icon } from "@maple/views/ui/icon"
import { inlineCode } from "@maple/views/ui/inline-code"
import { skeleton } from "@maple/views/ui/skeleton"
import { Message } from "../../../integrations/message"
import { GcpMessage } from "./gcp"
import type { Model } from "../../../integrations/model"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, hstackClass, vstack } from "@maple/views/ui/stack"
import { Array as Arr, String as Str } from "effect"

type H = HtmlBuilder<Message>

/** A Google Cloud module message, as the hub carries it. */
export const toHub = (message: GcpMessage): Message => Message.GotGcpMessage({ message })

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
		toParentMessage: (message) => toHub(GcpMessage.GotGcpCopyMessage({ id, message })),
		value,
	})

/** A shell command to copy; too long for its line, it breaks between its words only. */
export const gcpCommand = (h: H, model: Model, id: string, command: string): Html =>
	hstack(h, { gap: "0.5", align: "start", inline: true, as: "span", className: "max-w-full align-top" }, [
		inlineCode(
			h,
			{ className: "min-w-0" },
			Arr.flatMap(Str.split(" ")(command), (word, index) => [
				...(index === 0 ? [] : [" "]),
				h.span([h.Class("whitespace-nowrap")], [word]),
			]),
		),
		copyOf(h, model, id, command, { label: "command", iconSize: 12, className: "size-5" }),
	])

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
		keepsFillInk: true,
		attributes: script === null ? [h.Disabled(true)] : [],
	})

export type ScriptFailure = Readonly<{ message: string; isRetrying: boolean }>

/** Copy, read on request; `leading` are the buttons before the copy button. */
export const scriptBlock = (
	h: H,
	model: Model,
	options: Readonly<{ id: string; script: string | null; label: string; failure: ScriptFailure | null }>,
	leading: ReadonlyArray<Html>,
): Html => {
	const shown = model.gcpCard.isScriptShown
	const text = options.script === null ? null : Str.trimEnd(options.script)
	return vstack(h, { gap: "2" }, [
		hstack(h, { wrap: true, className: "gap-x-3 gap-y-2" }, [
			...leading,
			copyScriptButton(h, model, options.id, options.script, options.label),
			button(
				h,
				{
					variant: "link",
					size: "xs",
					className: cn(
						typographyClass({
							size: "xs",
							tone: "muted",
							weight: "normal",
							hoverTone: "foreground",
							className: "h-auto p-0",
						}),
						GCP_LINK,
					),
					attributes: [
						h.AriaExpanded(shown),
						h.OnClick(toHub(GcpMessage.ClickedGcpScriptToggle())),
					],
				},
				[shown ? "Hide the script" : "Read the script"],
			),
		]),
		...(options.failure === null
			? []
			: [
					hstack(h, { gap: "2", wrap: true }, [
						typography(
							h,
							{ size: "xs", tone: "destructive", as: "p", attributes: [h.Role("alert")] },
							[options.failure.message],
						),
						button(
							h,
							{
								size: "sm",
								variant: "outline",
								isLoading: options.failure.isRetrying,
								attributes: [h.OnClick(toHub(GcpMessage.ClickedGcpScriptRetry()))],
							},
							["Try again"],
						),
					]),
				]),
		h.p(
			[h.Class(cn(SMALL, hstackClass({ gap: "1.5", align: "start" })))],
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
	])
}

/** Read-only: the script's copy button sits beside Open Cloud Shell. */
const scriptText = (h: H, label: string, text: string): Html =>
	codeBlock(h, {
		code: text,
		language: "Bash",
		lang: "bash",
		secret: true,
		scrollLabel: `The ${label}`,
		className: "mt-1",
		bodyClassName: "max-h-80 overflow-y-auto",
		actions: [
			typography(h, { size: "2xs", tone: "muted" }, [countLabel(Str.split("\n")(text).length, "line")]),
		],
	})

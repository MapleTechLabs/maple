import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { REPLAY_BLOCK_CLASS } from "../../components/common/replay-privacy"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import * as CopyButton from "../../ui/copy-button"
import { icon } from "../../ui/icon"
import { skeleton } from "../../ui/skeleton"
import type { ConfigureModel } from "./gcp-configure-schema"
import { Message } from "./message"
import type { Model } from "./model"
import type { ScriptFailure } from "./view-gcp-parts"

// `FileCard` and `LoadFailure`: a generated file to copy, the start in view, the rest on request.

type H = HtmlBuilder<Message>

const COPY_ID = "configure-file"
const LINK =
	"h-auto p-0 font-normal text-xs text-muted-foreground hover:text-foreground active:text-foreground"

/** Why a file couldn't be loaded, and the way to load it again. */
export const loadFailure = (h: H, failure: ScriptFailure): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center gap-2")],
		[
			h.p([h.Class("text-xs text-severity-error"), h.Role("alert")], [failure.message]),
			button(
				h,
				{
					size: "sm",
					variant: "outline",
					isLoading: failure.isRetrying,
					attributes: [h.OnClick(Message.ClickedGcpConfigureScriptRetry())],
				},
				["Try again"],
			),
		],
	)

export type FileCardOptions = Readonly<{
	name: string
	text: string | null
	failure: ScriptFailure | null
	/** The setup script embeds the connection's secret; a setup as code carries none. */
	secret: boolean
	/** With a prompt, copying it shows the coding-agent prompt in the file's place. */
	prompt?: string | null
	/** After the copy button. */
	children?: ReadonlyArray<Html>
}>

const promptButton = (h: H, configure: ConfigureModel, prompt: string | null): Html => {
	const isCopied = configure.isPromptShown && configure.promptCopied === true
	return button(
		h,
		{
			size: "sm",
			variant: "outline",
			isDisabled: prompt === null,
			attributes: prompt === null ? [] : [h.OnClick(Message.ClickedGcpCopyPrompt({ prompt }))],
		},
		[
			...(isCopied ? [icon(h, "CheckIcon", { size: 12 })] : []),
			isCopied ? "Prompt copied" : "Copy prompt for coding agent",
		],
	)
}

export const fileCard = (h: H, model: Model, configure: ConfigureModel, options: FileCardOptions): Html => {
	const { name, text, failure, secret, prompt, children } = options
	const promptShown = configure.isPromptShown
	const expanded = configure.isScriptExpanded
	// Copy takes whatever is on screen.
	const copyable = promptShown ? (prompt ?? null) : text
	const shown = promptShown ? (prompt?.trimEnd() ?? null) : (text?.trimEnd() ?? null)
	return h.div(
		[h.Class("overflow-clip rounded-md border")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-2 border-b bg-surface-sunken px-3 py-2")],
				[
					h.span(
						[h.Class("font-mono text-xs text-muted-foreground")],
						[
							promptShown ? "Prompt for a coding agent" : name,
							...(shown === null || promptShown
								? []
								: [` · ${countLabel(shown.split("\n").length, "line")}`]),
						],
					),
					h.span(
						[h.Class("ml-auto flex flex-wrap items-center justify-end gap-2")],
						[
							...(prompt === undefined ? [] : [promptButton(h, configure, prompt)]),
							CopyButton.view(h, {
								model: model.gcpCard.copies[COPY_ID] ?? CopyButton.init(),
								toParentMessage: (message) =>
									Message.GotGcpCopyMessage({ id: COPY_ID, message }),
								value: copyable ?? "",
								label: promptShown ? "prompt" : name,
								idleLabel: secret ? "Copy script" : "Copy",
								variant: children === undefined ? "default" : "outline",
								size: "sm",
								className: cn(
									children === undefined &&
										"text-primary-foreground hover:text-primary-foreground active:text-primary-foreground",
								),
								attributes: copyable === null ? [h.Disabled(true)] : [],
							}),
							...(children ?? []),
						],
					),
				],
			),
			failure !== null
				? h.div([h.Class("p-3")], [loadFailure(h, failure)])
				: shown === null
					? h.div([h.Class("p-3")], [skeleton(h, "h-26 w-full")])
					: fileText(h, shown, { expanded, promptShown, secret, name }),
			footer(h, configure, { name, secret, canExpand: shown !== null && failure === null }),
		],
	)
}

/** The dashboard records itself with rrweb, which serializes plain text verbatim. */
const fileText = (
	h: H,
	shown: string,
	options: Readonly<{ expanded: boolean; promptShown: boolean; secret: boolean; name: string }>,
): Html =>
	h.div(
		[h.Class("relative")],
		[
			h.pre(
				[
					h.Tabindex(0),
					h.Role("region"),
					h.AriaLabel(options.promptShown ? "The prompt for a coding agent" : options.name),
					h.Class(
						cn(
							"overflow-x-auto p-3 font-mono text-xs/5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
							// The prompt is prose; code keeps its lines.
							options.promptShown && "whitespace-pre-wrap",
							options.expanded ? "max-h-80 overflow-y-auto" : "max-h-32 overflow-y-hidden",
							options.secret && REPLAY_BLOCK_CLASS,
						),
					),
				],
				[shown],
			),
			...(options.expanded
				? []
				: [
						h.div([
							h.AriaHidden(true),
							h.Class(
								"pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-popover to-transparent",
							),
						]),
					]),
		],
	)

const footerText = (configure: ConfigureModel, name: string, secret: boolean): string => {
	if (!configure.isPromptShown)
		return secret
			? "Holds this connection's secret. Don't share or commit it."
			: "No secrets in this file. Safe to commit."
	const copied = configure.promptCopied
	const status =
		copied === false
			? "Couldn't copy: select the prompt and copy it."
			: copied === true
				? "Copied."
				: "Copying."
	return `${status} It ends with the full ${name}.`
}

const footer = (
	h: H,
	configure: ConfigureModel,
	options: Readonly<{ name: string; secret: boolean; canExpand: boolean }>,
): Html =>
	h.div(
		[h.Class("flex items-center gap-3 border-t px-3 py-1.5 text-xs/5 text-muted-foreground")],
		[
			h.span(
				[h.Class("flex min-w-0 flex-1 items-center gap-1.5 text-pretty")],
				[
					icon(h, "LockIcon", { size: 12, className: "shrink-0" }),
					footerText(configure, options.name, options.secret),
				],
			),
			...(configure.isPromptShown
				? [
						button(
							h,
							{
								variant: "link",
								size: "xs",
								className: LINK,
								attributes: [h.OnClick(Message.ClickedGcpPromptBack())],
							},
							[`Back to ${options.name}`],
						),
					]
				: []),
			...(options.canExpand
				? [
						button(
							h,
							{
								variant: "link",
								size: "xs",
								className: LINK,
								attributes: [
									h.AriaExpanded(configure.isScriptExpanded),
									h.OnClick(Message.ClickedGcpScriptExpand()),
								],
							},
							[configure.isScriptExpanded ? "Show less" : "Show all"],
						),
					]
				: []),
		],
	)

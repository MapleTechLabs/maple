import { autoContextDisplay, autoContextLabel, type AutoContext } from "../../../components/chat/auto-contexts"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { alertDescriptionStyles } from "@maple/ui/styles/ui/alert"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertAction } from "../../../ui/alert"
import { button } from "../../../ui/button"
import { icon, type IconName } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { inputGroup, inputGroupAddon, inputGroupButton } from "../../../ui/input-group"
import { textarea } from "../../../ui/textarea"
import { dotLoader } from "./dot-loader"
import type { ChatStatus } from "./ui-message"

// The prompt input, the page context chips and the failure notices. The textarea's text lives
// in the host's Model.

export type ComposerOptions<M> = Readonly<{
	/** Base UI's `useId` on the textarea. */
	textareaId: string
	draft: string
	placeholder: string
	status: ChatStatus
	/** A stop control while a turn runs; `undefined` leaves the loader inert. */
	onStop: M | undefined
	isDisabled: boolean
	onInput: (text: string) => M
	onSubmit: M
	/** The context tray above the textarea (`PageContextChips`). */
	chips: ReadonlyArray<Html>
}>

const STOP_LAYER = cn(
	"col-start-1 row-start-1 transition-[opacity,scale] duration-[160ms]",
	"ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
)

/** The send button, a stop button while a turn runs. */
const submitButton = <M>(h: HtmlBuilder<M>, options: ComposerOptions<M>): Html => {
	const isGenerating = options.status === "submitted" || options.status === "streaming"
	const canStop = isGenerating && options.onStop !== undefined
	const glyph = canStop
		? h.span(
				[h.Class("grid place-items-center")],
				[
					dotLoader(h, {
						color: "var(--primary-foreground)",
						className: cn(
							STOP_LAYER,
							"group-hover/submit:scale-[0.92] group-hover/submit:opacity-0",
							"group-focus-visible/submit:scale-[0.92] group-focus-visible/submit:opacity-0",
						),
					}),
					icon(h, "SquareIcon", {
						className: cn(
							STOP_LAYER,
							"size-3.5 scale-[0.92] opacity-0",
							"group-hover/submit:scale-100 group-hover/submit:opacity-100",
							"group-focus-visible/submit:scale-100 group-focus-visible/submit:opacity-100",
						),
					}),
				],
			)
		: isGenerating
			? dotLoader(h, { color: "var(--primary-foreground)" })
			: options.status === "error"
				? icon(h, "XmarkIcon", { className: "size-4" })
				: icon(h, "ArrowUpIcon", { className: "size-4" })
	return inputGroupButton(
		h,
		{
			size: "icon-sm",
			variant: "default",
			type: canStop ? "button" : "submit",
			className: "group/submit",
			isDisabled: options.isDisabled,
			attributes: [
				h.AriaLabel(canStop ? "Stop generating" : isGenerating ? "Sending" : "Submit"),
				...(canStop && options.onStop !== undefined ? [h.OnClick(options.onStop)] : []),
			],
		},
		[glyph],
	)
}

export const composer = <M>(h: HtmlBuilder<M>, options: ComposerOptions<M>): Html =>
	h.form(
		[h.Class("w-full"), h.OnSubmit(options.onSubmit)],
		[
			inputGroup(h, { className: "overflow-hidden" }, [
				...options.chips,
				textarea(h, {
					id: options.textareaId,
					isUnstyled: true,
					className: "field-sizing-content max-h-48 min-h-16",
					attributes: [
						h.Name("message"),
						h.Placeholder(options.placeholder),
						h.Value(options.draft),
						h.OnInput(options.onInput),
						// Enter sends, Shift+Enter breaks the line. An IME composition's Enter arrives as
						// `Process`, so it never submits a half-typed word.
						h.OnKeyDownPreventDefault((key, modifiers) =>
							key === "Enter" && !modifiers.shiftKey && !options.isDisabled
								? Option.some(options.onSubmit)
								: Option.none(),
						),
					],
				}),
				inputGroupAddon(h, { align: "block-end", className: "justify-end gap-1" }, [submitButton(h, options)]),
			]),
		],
	)

const CONTEXT_ICONS = new Map<AutoContext["kind"], IconName>([
	["alert_rule", "BellIcon"],
	["container", "DockerIcon"],
	["dashboard", "GridSquareCirclePlusIcon"],
	["error_issue", "CircleWarningIcon"],
	["error_type", "CircleWarningIcon"],
	["host", "ServerIcon"],
	["logs_explorer", "FileIcon"],
	["metrics_explorer", "ChartLineIcon"],
	["service", "ServerIcon"],
	["service_map", "NetworkNodesIcon"],
	["trace", "PulseIcon"],
	["traces_explorer", "PulseIcon"],
])

/** What the chat is already looking at, as a tray inside the composer. */
export const contextChips = <M>(
	h: HtmlBuilder<M>,
	contexts: ReadonlyArray<AutoContext>,
	onDismiss: (id: string) => M,
): ReadonlyArray<Html> =>
	contexts.length === 0
		? []
		: [
				inputGroupAddon(
					h,
					{ align: "block-start", className: "flex-wrap gap-1 border-b" },
					contexts.map((context) => {
						const { kind, subject } = autoContextDisplay(context)
						return h.span(
							[
								h.Class(
									cn(
										"group/chip inline-flex h-6 max-w-64 min-w-0 items-center gap-1.5",
										"rounded-md border border-border/60 bg-muted/40 py-0 pr-0.5 pl-1.5",
										"font-normal text-xs transition-colors hover:bg-muted/70",
									),
								),
							],
							[
								icon(h, CONTEXT_ICONS.get(context.kind) ?? "ServerIcon", {
									className: "size-3.5 shrink-0 text-muted-foreground",
								}),
								h.span(
									[h.Class("min-w-0 truncate")],
									[
										h.span([h.Class("text-muted-foreground")], [kind]),
										...(subject === undefined || subject === ""
											? []
											: [h.span([h.Class("ml-1 text-foreground")], [subject])]),
									],
								),
								iconButton(
									h,
									{
										size: "icon-2xs",
										label: `Remove ${autoContextLabel(context)}`,
										hasTooltip: false,
										className: "text-muted-foreground/70 hover:text-foreground",
										attributes: [h.OnClick(onDismiss(context.id))],
									},
									[icon(h, "XmarkIcon")],
								),
							],
						)
					}),
				),
			]

/** `ChatFailureNotice`: what failed, and one way to try again. */
export const failureNotice = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ text: ReadonlyArray<string>; actionLabel: string; onAction: M; truncateTitle?: string }>,
): Html =>
	alert(h, { variant: "crit", size: "sm", className: "mb-3 text-sm" }, [
		h.div(
			[
				h.Class(cn(alertDescriptionStyles, "min-w-0", TONE_TEXT.crit)),
				h.DataAttribute("slot", "alert-description"),
				...(options.truncateTitle === undefined ? [] : [h.Title(options.truncateTitle)]),
			],
			options.truncateTitle === undefined
				? options.text
				: [h.span([h.Class("line-clamp-2 [overflow-wrap:anywhere]")], options.text)],
		),
		alertAction(h, [
			button(h, { size: "sm", variant: "outline", attributes: [h.OnClick(options.onAction)] }, [options.actionLabel]),
		]),
	])

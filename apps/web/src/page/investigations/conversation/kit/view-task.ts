import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { sheetDescriptionStyles } from "@maple/ui/styles/ui/sheet"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription } from "../../../../ui/alert"
import * as Dialog from "../../../../ui/dialog"
import * as DialogView from "../../../../ui/dialog-view"
import { icon } from "../../../../ui/icon"
import { trace, traceDescription, traceIcon, traceLine } from "../../../../ui/trace"
import { detailEyebrow } from "../../../kit/detail-header"
import { sectionHeading } from "../../../kit/section-heading"
import { dotLoader } from "./dot-loader"
import type { TaskPart, ToolPart } from "./ui-message"
import { agentPresentation } from "./view-cards"
import { type PanelHost, runningClock } from "./view-tool"

// `TaskCard`: one sub-agent run as a line that opens its
// sheet: the question in full, the answer, and whatever of the child's own steps reached the parent.

/** What a task row needs from its host: its sheet, and how the answer and steps are drawn. */
export type TaskHost<M> = Readonly<{
	dialog: (toolCallId: string) => Dialog.Model
	onDialog: (toolCallId: string, message: Dialog.Message) => M
	richText: (text: string) => Html
	tool: (part: ToolPart) => Html
	clockMount: PanelHost<M>["clockMount"]
}>

/** `taskSheetId`: the sheet a task row opens. */
export const taskSheetId = (toolCallId: string): string => `chat-task-${toolCallId}`

const OUTCOME = new Map([
	["completed", "answered"],
	["error", "failed"],
	["aborted", "stopped"],
])

const taskGlyph = <M>(h: HtmlBuilder<M>, status: TaskPart["status"]): Html => {
	if (status === "running") return dotLoader(h)
	if (status === "error") return icon(h, "CircleXmarkIcon", { className: "size-3.5 text-severity-error" })
	if (status === "aborted")
		return icon(h, "CircleWarningIcon", { className: "size-3.5 text-muted-foreground" })
	return icon(h, "CircleCheckIcon", { className: "size-3.5 text-severity-info" })
}

const outcomeTag = <M>(h: HtmlBuilder<M>, part: TaskPart): ReadonlyArray<Html> =>
	part.status === "error"
		? [h.span([h.Class(cn("shrink-0 text-2xs", TONE_TEXT.crit))], ["failed"])]
		: part.budgetExhausted === true
			? [h.span([h.Class(cn("shrink-0 text-2xs", TONE_TEXT.warn))], ["partial"])]
			: []

/** The line: what it is doing (or who it was), its question, its outcome. */
const taskLine = <M>(h: HtmlBuilder<M>, host: TaskHost<M>, part: TaskPart): Html => {
	const running = part.status === "running"
	const agent = agentPresentation(part.agent)
	return traceLine(
		h,
		running ? { status: "running" } : part.status === "error" ? { status: "error" } : {},
		[
			traceIcon(h, [taskGlyph(h, part.status)], running ? "size-5" : undefined),
			...(running
				? []
				: [traceIcon(h, [icon(h, agent.icon, { className: "size-3.5 text-foreground-subtle" })])]),
			h.span(
				[
					h.Class(
						"min-w-0 truncate motion-reduce:shimmer-none shrink-0 font-medium text-foreground",
					),
					h.DataAttribute("slot", "trace-title"),
				],
				[running ? `${agent.activity}…` : agent.label],
			),
			traceDescription(
				h,
				[h.span([h.Class("mr-1 text-foreground-faint")], ["·"]), part.prompt],
				"min-w-0 shrink truncate text-2xs",
			),
			...outcomeTag(h, part),
			...(running ? runningClock(h, host.clockMount) : []),
			traceIcon(h, [icon(h, "ChevronRightIcon", { className: "size-3 text-foreground-subtle" })]),
		],
	)
}

/** The answer section: live, the error, the answer, or the note that none came back. */
const answer = <M>(h: HtmlBuilder<M>, host: TaskHost<M>, part: TaskPart): Html => {
	if (part.status === "running")
		return h.div(
			[h.Class("flex items-center gap-2 text-sm text-muted-foreground")],
			[
				dotLoader(h),
				h.span([h.Class("shimmer")], [`${agentPresentation(part.agent).activity}…`]),
				...runningClock(h, host.clockMount),
			],
		)
	if (part.errorText !== undefined)
		return h.pre(
			[h.Class("max-h-60 overflow-auto whitespace-pre-wrap text-xs text-severity-error/80")],
			[part.errorText],
		)
	if (part.answer !== undefined) return h.div([h.Class("text-sm")], [host.richText(part.answer)])
	return h.p([h.Class("text-sm text-muted-foreground")], ["The run ended without returning an answer."])
}

/** `SheetDetailHeader` (not mono) over the `SheetPanel` of answer and steps. */
const sheetContent = <M>(
	h: HtmlBuilder<M>,
	host: TaskHost<M>,
	part: TaskPart,
	id: string,
): ReadonlyArray<Html> => {
	const agent = agentPresentation(part.agent)
	const kind = h.span(
		[h.Class("inline-flex items-center gap-2")],
		[
			icon(h, agent.icon, { className: "size-3 shrink-0" }),
			agent.label,
			" sub-agent",
			h.span([h.Class("text-foreground-faint")], ["·"]),
			part.status === "running" ? "running" : (OUTCOME.get(part.status) ?? ""),
		],
	)
	return [
		DialogView.dialogHeader(
			h,
			"sheet",
			[
				...Option.toArray(Option.fromNullishOr(detailEyebrow(h, [kind]))),
				DialogView.dialogTitle(
					h,
					"sheet",
					id,
					[h.span([h.Class("min-w-0 break-words")], [part.prompt])],
					"flex flex-wrap items-center gap-2 text-title leading-tight",
				),
				h.p(
					[
						h.Class(cn(sheetDescriptionStyles, "sr-only")),
						h.DataAttribute("slot", "sheet-description"),
						h.Id(Dialog.descriptionId(id)),
					],
					["What this sub-agent was asked, and what it came back with."],
				),
			],
			"gap-1.5 pr-14",
		),
		DialogView.dialogPanel(
			h,
			"sheet",
			id,
			[
				...(part.budgetExhausted === true
					? [
							alert(h, { variant: "warn", size: "sm" }, [
								alertDescription(h, [
									"Answered from what it had: the run spent its budget before it finished searching.",
								]),
							]),
						]
					: []),
				h.section(
					[h.Class("flex flex-col gap-2")],
					[
						sectionHeading(h, {
							variant: "eyebrow",
							as: "h3",
							title: "Answer",
							className: "mb-0",
						}),
						answer(h, host, part),
					],
				),
				...steps(h, host, part),
			],
			"flex flex-col gap-6",
		),
	]
}

/** One sub-agent run: its line is the trigger of its own sheet. */
export const taskCard = <M>(h: HtmlBuilder<M>, host: TaskHost<M>, part: TaskPart): Html => {
	const id = taskSheetId(part.toolCallId)
	return h.submodel({
		slotId: id,
		model: host.dialog(part.toolCallId),
		view: DialogView.view,
		toParentMessage: (message: Dialog.Message) => host.onDialog(part.toolCallId, message),
		viewInputs: {
			side: "right",
			className: "sm:max-w-xl",
			hasDescription: true,
			toView: ({ trigger, portal }) =>
				trace(h, [h.button([...trigger, h.Type("button")], [taskLine(h, host, part)]), portal]),
			toContent: () => sheetContent(h, host, part, id),
		},
	})
}

/** Its own steps: the child's prose and tool calls, when the conversation recorded them. */
const steps = <M>(h: HtmlBuilder<M>, host: TaskHost<M>, part: TaskPart): ReadonlyArray<Html> =>
	part.messages.length === 0
		? []
		: [
				h.section(
					[h.Class("flex flex-col gap-2")],
					[
						sectionHeading(h, {
							variant: "eyebrow",
							as: "h3",
							title: "Its own steps",
							className: "mb-0",
						}),
						...part.messages.map((message) =>
							h.keyed("div")(
								message.id,
								[h.Class("flex flex-col gap-1.5")],
								message.parts.flatMap((leaf) =>
									leaf._tag === "text"
										? [host.richText(leaf.text)]
										: leaf._tag === "dynamic-tool"
											? [host.tool(leaf)]
											: [],
								),
							),
						),
					],
				),
			]

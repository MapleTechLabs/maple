import type { AiCardGate } from "@maple/domain/billing"
import { aiCardAction } from "../../kit/billing/ai-card-gate"
import type { ErrorIssueDocument } from "@maple/domain/http"
import type { V2Investigation } from "@maple/domain/http/v2"
import type { Html, HtmlBuilder } from "foldkit/html"
import { agentPromptFromIssue } from "../kit/agent-debug-prompt"
import { docsUrl } from "../../kit/docs"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "@maple/views/ui/button"
import * as CopyButton from "@maple/views/ui/copy-button"
import { badge } from "@maple/views/ui/display"
import { icon, type IconName } from "@maple/views/ui/icon"
import { panel } from "@maple/views/ui/panel"
import { stripClass } from "@maple/views/ui/rule"
import { Message } from "./message"
import type { Model } from "./model"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { Array as Arr, String as Str } from "effect"
import { canRunInvestigations } from "../../kit/session-grants"
import { disclosureStrip } from "../../kit/disclosure-strip"

type H = HtmlBuilder<Message>

const AGENTS: ReadonlyArray<readonly [string, IconName]> = [
	["Claude Code", "ClaudeIcon"],
	["Cursor", "CursorIcon"],
	["Codex", "OpenAiIcon"],
]

/** The agents the prompt is written for, as small overlapping glyph tiles beside the title. */
const agentGlyphs = (h: H): Html =>
	hstack(
		h,
		{ align: "stretch", as: "span", className: "shrink-0 -space-x-1", attributes: [h.AriaHidden(true)] },
		Arr.map(AGENTS, ([name, glyph]) =>
			hstack(
				h,
				{
					align: "center",
					justify: "center",
					as: "span",
					className: "size-5 rounded-sm border bg-surface-sunken text-foreground ring-2 ring-card",
					attributes: [h.Key(name), h.Title(name)],
				},
				[icon(h, glyph, { size: 11 })],
			),
		),
	)

/** A row's mark: one glyph in a small sunken tile, the same size on every row so the titles align. */
const markTile = (h: H, glyph: IconName): Html =>
	hstack(
		h,
		{
			align: "center",
			justify: "center",
			as: "span",
			className: "size-8 shrink-0 rounded-md border bg-surface-sunken text-muted-foreground",
			attributes: [h.AriaHidden(true)],
		},
		[icon(h, glyph, { size: 15 })],
	)

/** One way to get it fixed, as a row: its mark, a title over one line of what it does, its actions. */
const lane = (
	h: H,
	options: Readonly<{
		glyph: IconName
		title: string
		/** Beside the title: the agents' glyphs, an investigation's status. */
		titleAside?: Html
		note: Html | string
		actions: ReadonlyArray<Html>
	}>,
): Html =>
	hstack(
		h,
		{ gap: "4", align: "center", justify: "between", wrap: true, className: stripClass("row", "py-3") },
		[
			hstack(h, { gap: "3", align: "center", shrink: true, className: "min-w-0 flex-1 basis-72" }, [
				markTile(h, options.glyph),
				vstack(h, { gap: "0.5", shrink: true, className: "min-w-0" }, [
					hstack(h, { gap: "2", align: "center", wrap: true }, [
						typography(h, { size: "sm", tone: "foreground", weight: "medium" }, [options.title]),
						...(options.titleAside === undefined ? [] : [options.titleAside]),
					]),
					typography(h, { size: "xs", tone: "muted", as: "p", truncate: true }, [options.note]),
				]),
			]),
			hstack(h, { gap: "1", align: "center", className: "shrink-0" }, options.actions),
		],
	)

const agentLane = (h: H, model: Model, prompt: string): Html =>
	lane(h, {
		glyph: "SquareTerminalIcon",
		title: "Hand it to your coding agent",
		titleAside: agentGlyphs(h),
		note: "Works it over the Maple MCP server and links the fix here.",
		actions: [
			CopyButton.view(h, {
				model: model.promptCopy,
				value: prompt,
				label: "agent prompt",
				idleLabel: "Copy prompt",
				copiedLabel: "Copied",
				variant: "default",
				size: "sm",
				keepsFillInk: true,
				toParentMessage: (message) => Message.GotPromptCopyMessage({ message }),
			}),
			linkButton(
				h,
				{
					size: "sm",
					variant: "ghost",
					href: docsUrl("mcp"),
					attributes: [h.Target("_blank"), h.Rel("noopener noreferrer")],
				},
				[icon(h, "PlugIcon"), "Set up MCP"],
			),
		],
	})

const sentenceCase = (text: string): string => Str.toUpperCase(Str.slice(0, 1)(text)) + Str.slice(1)(text)

const investigationSummary = (investigation: V2Investigation): string =>
	investigation.report?.suspectedCause ??
	(investigation.status === "investigating"
		? "Gathering evidence from traces, logs and recent deploys."
		: (investigation.error ?? "Finished without a diagnosis."))

const investigationLane = (
	h: H,
	investigation: V2Investigation | null,
	isStarting: boolean,
	aiCardGate: AiCardGate | undefined,
): Html =>
	investigation === null
		? lane(h, {
				glyph: "PulseIcon",
				title: "Let Maple find the root cause",
				note: "Reads traces, logs and deploys, and writes up a diagnosis.",
				actions: [
					aiCardGate === undefined
						? button(
								h,
								{
									size: "sm",
									variant: "outline",
									isDisabled: isStarting,
									attributes: [h.OnClick(Message.ClickedInvestigate())],
								},
								[icon(h, "PulseIcon"), isStarting ? "Starting…" : "Start investigation"],
							)
						: aiCardAction(h, aiCardGate),
				],
			})
		: lane(h, {
				glyph: "PulseIcon",
				title: "Maple investigation",
				titleAside: badge(h, { variant: "outline" }, [
					sentenceCase(investigation.status),
					...(investigation.confidence ? [` · ${investigation.confidence} confidence`] : []),
				]),
				note: investigationSummary(investigation),
				actions: [
					linkButton(
						h,
						{
							size: "sm",
							variant: "outline",
							href: hrefOf(AppRoute.Investigation({ id: investigation.id, search: {} })),
						},
						[icon(h, "PulseIcon"), "Open investigation"],
					),
				],
			})

/** The prompt exactly as it copies, behind a disclosure. */
const promptPreview = (h: H, prompt: string): Html =>
	disclosureStrip(h, { label: "Preview the prompt", text: prompt })

export const getItFixedPanel = (
	h: H,
	model: Model,
	issue: ErrorIssueDocument,
	investigation: V2Investigation | null,
	aiCardGate: AiCardGate | undefined,
): Html => {
	const maple = investigationLane(h, investigation, model.isStartingInvestigation, aiCardGate)
	// The prompt drives the error tools, so alert issues get Maple's lane alone. So does a viewer
	// who cannot run one: the prompt tells an agent to claim and fix the issue.
	if (issue.kind !== "error" || !canRunInvestigations(model))
		return panel(
			h,
			{ className: "shrink-0 overflow-hidden", attributes: [h.AriaLabel("Get it fixed")] },
			[h.div([], [maple])],
		)
	const prompt = agentPromptFromIssue(issue)
	// Two rows, no header: the headlines say what each path does, so the panel stays short.
	return panel(h, { className: "shrink-0 overflow-hidden", attributes: [h.AriaLabel("Get it fixed")] }, [
		h.div([], [agentLane(h, model, prompt), maple]),
		promptPreview(h, prompt),
	])
}

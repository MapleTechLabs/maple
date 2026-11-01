import type { ErrorIssueDocument } from "@maple/domain/http"
import type { V2Investigation } from "@maple/domain/http/v2"
import type { Html, HtmlBuilder } from "foldkit/html"
import { agentPromptFromIssue } from "../../../components/errors/agent-debug-prompt"
import { docsUrl } from "../../../lib/docs"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "../../../ui/button"
import * as CopyButton from "../../../ui/copy-button"
import { badge } from "../../../ui/display"
import { eyebrow } from "../../../ui/eyebrow"
import { icon, type IconName } from "../../../ui/icon"
import { panel, panelHeader } from "../../../ui/panel"
import { Message } from "./message"
import type { Model } from "./model"

// `GetItFixed`: the two ways to a fix, the user's own coding agent and Maple's investigation.

type H = HtmlBuilder<Message>

const AGENTS: ReadonlyArray<readonly [string, IconName]> = [
	["Claude Code", "ClaudeIcon"],
	["Cursor", "CursorIcon"],
	["Codex", "OpenAiIcon"],
]

/** The agents the prompt is written for, as overlapping glyph tiles. */
const agentGlyphs = (h: H): Html =>
	h.div(
		[h.Class("flex shrink-0 -space-x-1"), h.AriaHidden(true)],
		AGENTS.map(([name, glyph]) =>
			h.span(
				[
					h.Key(name),
					h.Class(
						"flex size-6 items-center justify-center rounded-md border bg-surface-sunken text-foreground ring-2 ring-card",
					),
				],
				[icon(h, glyph, { size: 13 })],
			),
		),
	)

/** One way to a fix: its label and glyphs, what it does, then its actions. */
const lane = (
	h: H,
	options: Readonly<{
		label: string
		adornment?: Html
		body: ReadonlyArray<Html>
		actions: ReadonlyArray<Html>
	}>,
): Html =>
	h.div(
		[h.Class("flex min-w-0 flex-col gap-3 p-4")],
		[
			h.div(
				[h.Class("flex h-6 items-center justify-between gap-3")],
				[
					eyebrow(h, { as: "div" }, [options.label]),
					...(options.adornment ? [options.adornment] : []),
				],
			),
			h.div([h.Class("flex flex-1 flex-col gap-1")], options.body),
			h.div([h.Class("flex flex-wrap items-center gap-2")], options.actions),
		],
	)

const lead = (h: H, text: string): Html => h.p([h.Class("text-sm font-medium text-foreground")], [text])
const note = (h: H, children: ReadonlyArray<Html | string>): Html =>
	h.p([h.Class("max-w-[60ch] text-xs leading-5 text-muted-foreground")], children)

const agentLane = (h: H, model: Model, prompt: string): Html =>
	lane(h, {
		label: "Your coding agent",
		adornment: agentGlyphs(h),
		body: [
			lead(h, "Hand this issue to Claude Code, Cursor or Codex"),
			note(h, [
				"The prompt has the agent claim the issue, read its traces and logs through the Maple MCP server, and link its fix here.",
			]),
		],
		actions: [
			CopyButton.view(h, {
				model: model.promptCopy,
				value: prompt,
				label: "agent prompt",
				idleLabel: "Copy prompt",
				copiedLabel: "Copied",
				variant: "default",
				size: "sm",
				// The copy button's own muted ink is for ghost buttons; keep the fill's.
				className:
					"text-primary-foreground hover:text-primary-foreground active:text-primary-foreground",
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

const sentenceCase = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

const investigationSummary = (investigation: V2Investigation): string =>
	investigation.report?.suspectedCause ??
	(investigation.status === "investigating"
		? "Gathering evidence from traces, logs and recent deploys."
		: (investigation.error ?? "Finished without a diagnosis."))

const investigationLane = (h: H, investigation: V2Investigation | null, isStarting: boolean): Html =>
	investigation === null
		? lane(h, {
				label: "Maple investigation",
				body: [
					lead(h, "Let Maple find the root cause"),
					note(h, [
						"Maple works through this issue's traces, logs and deploys, and writes up a diagnosis you can check.",
					]),
				],
				actions: [
					button(
						h,
						{
							size: "sm",
							variant: "outline",
							isDisabled: isStarting,
							attributes: [h.OnClick(Message.ClickedInvestigate())],
						},
						[icon(h, "PulseIcon"), isStarting ? "Starting…" : "Start investigation"],
					),
				],
			})
		: lane(h, {
				label: "Maple investigation",
				adornment: badge(h, { variant: "outline" }, [
					sentenceCase(investigation.status),
					...(investigation.confidence ? [` · ${investigation.confidence} confidence`] : []),
				]),
				body: [
					h.p(
						[h.Class("line-clamp-3 text-sm text-foreground")],
						[investigationSummary(investigation)],
					),
				],
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
	h.details(
		[h.Class("group/prompt border-t")],
		[
			h.summary(
				[
					h.Class(
						"flex cursor-pointer list-none items-center gap-1.5 px-4 py-2.5 text-xs text-muted-foreground select-none hover:text-foreground active:text-foreground [&::-webkit-details-marker]:hidden",
					),
				],
				[
					icon(h, "ChevronRightIcon", { size: 12, className: "group-open/prompt:rotate-90" }),
					"Preview the prompt",
				],
			),
			h.pre(
				[
					h.Class(
						"max-h-72 overflow-auto border-t bg-surface-sunken px-4 pt-3 pb-8 [mask-image:linear-gradient(to_bottom,black_80%,transparent)] font-mono text-xs leading-5 whitespace-pre-wrap break-words text-foreground-soft",
					),
				],
				[prompt],
			),
		],
	)

/** `GetItFixed`: both ways to a fix side by side, the prompt preview under them. */
export const getItFixedPanel = (
	h: H,
	model: Model,
	issue: ErrorIssueDocument,
	investigation: V2Investigation | null,
): Html => {
	const maple = investigationLane(h, investigation, model.isStartingInvestigation)
	// The prompt drives the error tools, so alert issues get Maple's lane alone.
	if (issue.kind !== "error")
		return panel(h, { className: "shrink-0 overflow-hidden" }, [
			panelHeader(h, { title: "Get it fixed" }),
			maple,
		])
	const prompt = agentPromptFromIssue(issue)
	return panel(h, { className: "shrink-0 overflow-hidden" }, [
		panelHeader(h, { title: "Get it fixed" }),
		h.div(
			[h.Class("grid divide-y xl:grid-cols-2 xl:divide-x xl:divide-y-0")],
			[agentLane(h, model, prompt), maple],
		),
		promptPreview(h, prompt),
	])
}

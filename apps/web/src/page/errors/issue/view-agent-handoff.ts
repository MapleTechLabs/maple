import type { ErrorIssueDocument } from "@maple/domain/http"
import type { Html, HtmlBuilder } from "foldkit/html"
import { docsUrl } from "../../../lib/docs"
import { agentPromptFromIssue } from "../../../components/errors/agent-debug-prompt"
import { linkButton } from "../../../ui/button"
import * as CopyButton from "../../../ui/copy-button"
import { icon, type IconName } from "../../../ui/icon"
import { Message } from "./message"
import type { Model } from "./model"

// The agent handoff: the debug prompt for the user's own coding agent, one click from the overview.

type H = HtmlBuilder<Message>

const AGENTS: ReadonlyArray<readonly [string, IconName]> = [
	["Claude Code", "ClaudeIcon"],
	["Cursor", "CursorIcon"],
	["Codex", "OpenAiIcon"],
]

/** The agents the prompt is written for, as overlapping glyph tiles. */
const agentGlyphs = (h: H): Html =>
	h.div(
		[h.Class("flex shrink-0 -space-x-1.5"), h.AriaHidden(true)],
		AGENTS.map(([name, glyph]) =>
			h.span(
				[
					h.Key(name),
					h.Title(name),
					h.Class(
						"flex size-8 items-center justify-center rounded-lg border border-primary-a3 bg-card text-foreground shadow-raised",
					),
				],
				[icon(h, glyph, { size: 16 })],
			),
		),
	)

/** `Fix it with your agent`: copy the prompt, or open the MCP setup it depends on. */
export const agentHandoffPanel = (h: H, model: Model, issue: ErrorIssueDocument): Html => {
	const prompt = agentPromptFromIssue(issue)
	return h.section(
		[
			h.Class("shrink-0 overflow-hidden rounded-xl border border-primary-a3 bg-primary-a1"),
			h.AriaLabel("Fix it with your coding agent"),
		],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4")],
				[
					agentGlyphs(h),
					h.div(
						[h.Class("flex min-w-[14rem] flex-1 flex-col gap-0.5")],
						[
							h.h3(
								[h.Class("text-sm font-medium text-foreground")],
								["Fix it with your coding agent"],
							),
							h.p(
								[h.Class("text-xs text-muted-foreground")],
								[
									"Paste this prompt into Claude Code, Cursor or Codex. With the Maple MCP server connected, the agent claims the issue, reads its traces and logs, and records the fix here.",
								],
							),
						],
					),
					h.div(
						[h.Class("flex shrink-0 items-center gap-2")],
						[
							linkButton(
								h,
								{
									size: "sm",
									variant: "ghost",
									href: docsUrl("mcp"),
									attributes: [h.Target("_blank"), h.Rel("noopener noreferrer")],
								},
								[icon(h, "PlugIcon"), "Connect MCP"],
							),
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
						],
					),
				],
			),
			h.details(
				[h.Class("group/prompt border-t border-primary-a3")],
				[
					h.summary(
						[
							h.Class(
								"flex cursor-pointer list-none items-center gap-1.5 px-5 py-2 text-xs text-muted-foreground select-none hover:text-foreground active:text-foreground [&::-webkit-details-marker]:hidden",
							),
						],
						[
							icon(h, "ChevronRightIcon", {
								size: 12,
								className: "transition-transform group-open/prompt:rotate-90",
							}),
							"Preview prompt",
						],
					),
					h.pre(
						[
							h.Class(
								"max-h-64 overflow-auto border-t border-primary-a3 bg-card px-5 py-3 font-mono text-2xs leading-5 whitespace-pre-wrap break-words text-foreground-soft",
							),
						],
						[prompt],
					),
				],
			),
		],
	)
}

import type { V2OnboardingAgentRun, V2OnboardingAgentStage } from "@maple/domain/http/v2"
import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as CopyButton from "@maple/views/ui/copy-button"
import { vstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { textarea } from "@maple/views/ui/textarea"
import { typography } from "@maple/views/ui/typography"
import { ingestUrl } from "../../platform/ingest-url"
import { AppRoute, hrefOf } from "../../route"
import { Message, type Model } from "./agent-handoff"
import { codeBlock } from "./code-block"
import { type CheckState, liveChecklist } from "./connect-flow"
import { agentSetupPrompt, HANDOFF_LINE_LABEL, MASKED_HANDOFF_CODE } from "./onboard-skill"
import { REPLAY_BLOCK_CLASS } from "./replay-privacy"

/**
 * The coding-agent prompt with its handoff code masked, a Copy prompt that mints the code, and the
 * agent's progress once a run exists.
 */

export type AgentPromptOptions<M> = Readonly<{
	model: Model
	/** The org's public key, or "" when it could not be read (the guide then uses a placeholder). */
	publicKey: string
	toMessage: (message: Message) => M
	/** The connect step shows the run's stages; the Connect popover only copies. */
	showsProgress: boolean
}>

const STAGE_LABELS = {
	connect_agent: "Connect agent",
	analyze_project: "Analyze project",
	instrument_app: "Instrument app",
	send_verification: "Send verification trace",
	receive_verification: "Receive verification trace",
	prepare_production: "Prepare production",
} as const satisfies Record<V2OnboardingAgentStage["id"], string>

const STAGE_STATES = {
	pending: "pending",
	active: "active",
	waiting: "waiting",
	completed: "done",
	skipped: "skipped",
	failed: "failed",
} as const satisfies Record<V2OnboardingAgentStage["status"], CheckState>

const STATUS_LINES = {
	waiting_for_agent:
		"Waiting for your agent to sign in. If it can't run the Maple CLI, setup still works, but progress won't show here.",
	in_progress: "Your agent is setting up Maple.",
	completed: "Setup complete.",
	failed: "Your agent stopped before setup finished. Copy the prompt again to start over.",
	expired: "This run ran out of time before your agent finished. Copy the prompt again to start over.",
} as const satisfies Record<V2OnboardingAgentRun["status"], string>

const completedSummary = <M>(h: HtmlBuilder<M>, run: V2OnboardingAgentRun): ReadonlyArray<Html | string> => [
	run.service_names.length === 0
		? STATUS_LINES.completed
		: `Setup complete for ${Arr.join(run.service_names, ", ")}.`,
	...(run.trace_id === null
		? []
		: [
				" ",
				textLink(h, { href: hrefOf(AppRoute.Trace({ traceId: run.trace_id, search: {} })) }, [
					"Open the verification trace",
				]),
			]),
]

/** An expired run no agent ever signed in to: the code lapsed, not the setup. */
const UNCLAIMED_LINE =
	"No agent signed in with this code within the hour. Copy the prompt again for a new one."

const statusLine = (run: V2OnboardingAgentRun): string =>
	run.status === "expired" && Arr.every(run.stages, (stage) => stage.status === "pending")
		? UNCLAIMED_LINE
		: STATUS_LINES[run.status]

/** The run's stages, one row each, under a line on where the run stands. */
export const agentProgress = <M>(h: HtmlBuilder<M>, run: V2OnboardingAgentRun): Html =>
	liveChecklist(h, {
		title: "Agent progress",
		summary: run.status === "completed" ? h.span([], completedSummary(h, run)) : statusLine(run),
		rows: Arr.map(run.stages, (stage) => ({
			state: STAGE_STATES[stage.status],
			title: STAGE_LABELS[stage.id],
			detail: stage.note,
		})),
	})

/** When the clipboard refused the write: the copied prompt, revealed on request, to copy by hand. */
const copyFallback = <M>(h: HtmlBuilder<M>, options: AgentPromptOptions<M>): ReadonlyArray<Html> => {
	const { model } = options
	if (!model.isCopyFailed || model.copiedPrompt === null) return []
	return [
		typography(h, { size: "xs", tone: "muted", as: "p" }, [
			"Your browser blocked the clipboard. ",
			textLink(h, { onClick: options.toMessage(Message.ClickedShowPrompt()) }, [
				model.isPromptShown ? "Hide prompt" : "Show prompt",
			]),
		]),
		...(model.isPromptShown
			? [
					textarea(h, {
						id: `agent-prompt-${model.surface}`,
						defaultValue: model.copiedPrompt,
						className: REPLAY_BLOCK_CLASS,
						controlClassName: "font-mono text-xs",
						attributes: [h.Readonly(true), h.Rows(5), h.AriaLabel("Setup prompt")],
					}),
				]
			: []),
	]
}

/** The prompt block, its Copy prompt, the notes a copy leaves, and the run's progress. */
export const agentPrompt = <M>(h: HtmlBuilder<M>, options: AgentPromptOptions<M>): Html => {
	const { model } = options
	const prompt = {
		code: agentSetupPrompt(ingestUrl, options.publicKey),
		isPlain: true,
		className: REPLAY_BLOCK_CLASS,
	}
	return vstack(h, { gap: "2" }, [
		// A `control` org's copy carries no code, so the page shows no code line either.
		codeBlock(
			h,
			model.arm === "control"
				? prompt
				: { ...prompt, maskedLine: `${HANDOFF_LINE_LABEL} ${MASKED_HANDOFF_CODE}` },
		),
		CopyButton.copyButton(h, {
			status: model.copy.status,
			label: "prompt",
			onClick: options.toMessage(Message.ClickedCopyPrompt({ publicKey: options.publicKey })),
			idleLabel: "Copy prompt",
			copiedLabel: "Prompt copied",
			variant: "default",
			size: "default",
			keepsFillInk: true,
			className: "w-full",
			attributes: model.isMinting ? [h.AriaBusy(true), h.Disabled(true)] : [],
		}),
		...(model.isTrackingUnavailable
			? [
					typography(h, { size: "xs", tone: "muted", as: "p" }, [
						"Copied without a handoff code, so progress tracking is unavailable. Your agent can still set up Maple.",
					]),
				]
			: []),
		...copyFallback(h, options),
		...(options.showsProgress && model.run !== null ? [agentProgress(h, model.run)] : []),
	])
}

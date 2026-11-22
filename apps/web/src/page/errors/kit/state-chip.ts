import type { V2Investigation } from "@maple/domain/http/v2"
import type { InvestigationSummary, SignalState } from "./error-signal"
import { tooltipTrigger } from "@maple/views/ui/tooltip-host"
import type { IconName } from "@maple/views/ui/icon"
import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { statusDot } from "@maple/views/ui/status-dot"
import { textLink } from "@maple/views/ui/text-link"
import { WORKFLOW_LABEL, workflowRingIcon } from "../../kit/issue-workflow"
import { typography } from "@maple/views/ui/typography"

const INVESTIGATION_LABEL = {
	investigating: "Investigating",
	diagnosed: "Diagnosed",
	inconclusive: "Inconclusive",
	failed: "Pass failed",
	resolved: "Resolved",
} satisfies Record<V2Investigation["status"], string>

/** Each investigation state's mark and status colour, shared by the chip's dot and its tooltip. */
const INVESTIGATION_LOOK = {
	investigating: { icon: "SparkleIcon", tone: "live" },
	diagnosed: { icon: "MagnifierCheckIcon", tone: "info" },
	inconclusive: { icon: "CircleQuestionIcon", tone: "warn" },
	failed: { icon: "CircleXmarkIcon", tone: "crit" },
	resolved: { icon: "CircleCheckIcon", tone: "done" },
} as const satisfies Record<V2Investigation["status"], { icon: IconName; tone: Tone }>

/** What each investigation state means, for the chip's tooltip. */
const INVESTIGATION_DESCRIPTION = {
	investigating: "Maple's agent is looking into this error now.",
	diagnosed: "Maple's agent found a likely root cause.",
	inconclusive: "Maple's agent looked into this error but couldn't pin down a cause.",
	failed: "The investigation stopped before it reached an answer.",
	resolved: "The investigation is closed.",
} satisfies Record<V2Investigation["status"], string>

/** "Investigating" / "Diagnosed". A button inside the row's link; it opens the investigation. */
export const investigationChip = <M>(
	h: HtmlBuilder<M>,
	investigation: InvestigationSummary,
	options: Readonly<{ withConfidence?: boolean; compact?: boolean; className?: string; onOpen: M }>,
): Html => {
	const label = INVESTIGATION_LABEL[investigation.status]
	const withConfidence = options.withConfidence ?? true
	return textLink(
		h,
		{
			tone: "muted",
			onClick: options.onOpen,
			clickOptions: { defaultAction: "Prevent", propagation: "Stop" },
			className: cn(
				"max-w-full gap-1.5 rounded-sm text-2xs font-medium whitespace-nowrap focus-visible:rounded-sm",
				options.className,
			),
			attributes: tooltipTrigger(
				h,
				`${INVESTIGATION_DESCRIPTION[investigation.status]} Click to open it.`,
				{
					title: investigation.confidence
						? `${label} · ${investigation.confidence} confidence`
						: label,
					...INVESTIGATION_LOOK[investigation.status],
				},
			),
		},
		[
			statusDot(h, { tone: INVESTIGATION_LOOK[investigation.status].tone }),
			h.span([h.Class(cn("truncate", options.compact === true && "hidden @5xl/page:inline"))], [label]),
			...(withConfidence && investigation.confidence && investigation.status === "diagnosed"
				? [typography(h, { tone: "subtle" }, ["· ", investigation.confidence])]
				: []),
		],
	)
}

/** The issue header's one status slot: open incident, then investigation, then workflow state. */
export const signalStateChip = <M>(
	h: HtmlBuilder<M>,
	state: SignalState,
	options: Readonly<{ withConfidence?: boolean; className?: string; onOpenInvestigation: M }>,
): Html => {
	if (state.kind === "incident") {
		return h.span(
			[
				h.Class(
					cn(
						"inline-flex max-w-full items-center gap-1.5 text-2xs font-medium whitespace-nowrap text-severity-error",
						options.className,
					),
				),
				h.Title("An incident is open for this error"),
			],
			[statusDot(h, { tone: "crit" }), typography(h, { truncate: true }, ["Open incident"])],
		)
	}
	if (state.kind === "investigation") {
		return investigationChip(
			h,
			{ id: state.investigationId, status: state.status, confidence: state.confidence },
			{
				withConfidence: options.withConfidence,
				className: options.className,
				onOpen: options.onOpenInvestigation,
			},
		)
	}
	return h.span(
		[
			h.Class(
				cn(
					"inline-flex max-w-full items-center gap-1.5 text-2xs whitespace-nowrap text-muted-foreground",
					options.className,
				),
			),
			h.Title(`Workflow state: ${WORKFLOW_LABEL[state.state]}`),
		],
		[
			workflowRingIcon(h, state.state, 12),
			typography(h, { truncate: true }, [WORKFLOW_LABEL[state.state]]),
		],
	)
}

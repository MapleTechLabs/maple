import type { V2Investigation } from "@maple/domain/http/v2"
import type { InvestigationSummary, SignalState } from "../../../lib/models/error-signal"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { statusDot } from "../../../ui/status-dot"
import { WORKFLOW_LABEL, workflowRingIcon } from "./workflow"

// The signal state and investigation chips.

const INVESTIGATION_LABEL = {
	investigating: "Investigating",
	diagnosed: "Diagnosed",
	inconclusive: "Inconclusive",
	failed: "Pass failed",
	resolved: "Resolved",
} satisfies Record<V2Investigation["status"], string>

/** "Investigating" / "Diagnosed". A button inside the row's link; it opens the investigation. */
export const investigationChip = <M>(
	h: HtmlBuilder<M>,
	investigation: InvestigationSummary,
	options: Readonly<{ withConfidence?: boolean; compact?: boolean; className?: string; onOpen: M }>,
): Html => {
	const label = INVESTIGATION_LABEL[investigation.status]
	const withConfidence = options.withConfidence ?? true
	return h.button(
		[
			h.Type("button"),
			h.OnClick(options.onOpen, { defaultAction: "Prevent", propagation: "Stop" }),
			h.Class(
				cn(
					"inline-flex max-w-full items-center gap-1.5 text-2xs font-medium whitespace-nowrap",
					"text-muted-foreground hover:text-foreground active:text-foreground hover:underline active:underline",
					"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm",
					options.className,
				),
			),
			h.Title(
				investigation.confidence
					? `Maple ${label.toLowerCase()} — ${investigation.confidence} confidence`
					: `Maple ${label.toLowerCase()}`,
			),
		],
		[
			statusDot(h, { tone: "custom", className: "bg-current" }),
			h.span([h.Class(cn("truncate", options.compact === true && "hidden @xl/page:inline"))], [label]),
			...(withConfidence && investigation.confidence && investigation.status === "diagnosed"
				? [h.span([h.Class("text-foreground-subtle")], ["· ", investigation.confidence])]
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
			[statusDot(h, { tone: "crit" }), h.span([h.Class("truncate")], ["Open incident"])],
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
		[workflowRingIcon(h, state.state, 12), h.span([h.Class("truncate")], [WORKFLOW_LABEL[state.state]])],
	)
}

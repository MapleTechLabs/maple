import { useMemo } from "react"

import { Badge } from "@maple/ui/components/ui/badge"
import { cn } from "@maple/ui/lib/utils"
import { useMediaQuery } from "@maple/ui/hooks/use-media-query"

import { ChatConversation } from "@/components/chat/chat-conversation"
import { FlueClientProvider } from "@/components/chat/flue-client-provider"
import { investigationTabId, type InvestigationContext } from "@/components/chat/investigation-context"
import { useAiTriageRun } from "@/components/ai-triage/use-ai-triage-run"
import { ChatBubbleSparkleIcon } from "@/components/icons"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { InvestigationReport } from "./investigation-report"
import { InvestigationSidebar } from "./investigation-sidebar"
import type { InvestigationSubject } from "./subject"

const KIND_CRUMBS: Record<InvestigationSubject["kind"], { label: string; href?: string }[]> = {
	alert: [{ label: "Alerts", href: "/alerts" }],
	anomaly: [{ label: "Anomalies", href: "/anomalies" }],
	error: [
		{ label: "Errors", href: "/errors" },
		{ label: "Issues", href: "/errors/issues" },
	],
}

/**
 * The shared three-zone investigation surface: a scorecard meta rail, the AI
 * report body, and a docked chat — rendered identically for alerts, anomalies,
 * and errors. The only kind-specific input is the `subject` descriptor.
 */
export function InvestigationView({ subject }: { subject: InvestigationSubject }) {
	const triageReal = useAiTriageRun(subject.triage)
	// TEMP LOCAL PREVIEW MOCK — revert before commit.
	const triage = { ...triageReal, runsLoading: false, runsFailed: false, runActive: false, canRun: true, run: MOCK_RUN, result: MOCK_RESULT }
	const isWide = useMediaQuery("lg")

	// Arriving here IS the intent to diagnose: once the runs query resolves to
	// none, mounting the trigger fires a run (mount-effect escape hatch). Only when
	// a run can actually be started — otherwise the report shows a terminal state.
	const showAutoRun = !triage.runsLoading && !triage.runsFailed && triage.run === null && triage.canRun

	// Fold the AI's findings into the chat preamble once a run completes.
	const chatContext: InvestigationContext = useMemo(
		() => ({
			...subject.chat,
			...(triage.result
				? { aiSummary: triage.result.summary, aiSuspectedCause: triage.result.suspectedCause }
				: {}),
		}),
		[subject.chat, triage.result],
	)

	const breadcrumbs = [...KIND_CRUMBS[subject.kind], { label: subject.title }, { label: "Investigation" }]

	const chat = (
		<div
			className={cn(
				"flex flex-col overflow-hidden bg-card/30",
				isWide ? "h-full w-96 border-l" : "mt-8 h-[70vh] min-h-[460px] rounded-xl border",
			)}
		>
			<div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
				<ChatBubbleSparkleIcon className="size-4 text-muted-foreground" />
				<span className="text-sm font-medium">Ask Maple AI</span>
			</div>
			<FlueClientProvider>
				<ChatConversation
					tabId={investigationTabId(chatContext)}
					isActive
					mode="investigation"
					investigationContext={chatContext}
				/>
			</FlueClientProvider>
		</div>
	)

	return (
		<DashboardLayout
			breadcrumbs={breadcrumbs}
			title={subject.title}
			description={subject.subtitle}
			headerActions={
				<div className="flex items-center gap-2">
					{subject.severity ? (
						<Badge variant="outline" className={cn("capitalize", subject.severity.tone)}>
							{subject.severity.label}
						</Badge>
					) : null}
					<Badge variant="outline" className={subject.status.tone}>
						{subject.status.label}
					</Badge>
				</div>
			}
			filterSidebar={
				<InvestigationSidebar
					subject={subject}
					result={triage.result}
					run={triage.run}
					onRerun={triage.startRun}
					rerunning={triage.isStarting}
					canRun={triage.canRun}
				/>
			}
			rightSidebar={isWide ? chat : undefined}
		>
			{showAutoRun ? <AutoRunTrigger onFire={triage.startRun} /> : null}
			<InvestigationReport triage={triage} />
			{!isWide ? chat : null}
		</DashboardLayout>
	)
}

// TEMP LOCAL PREVIEW MOCK — revert before commit.
const MOCK_RESULT = {
	suspectedCause:
		"A poison-pill record is forcing the consumer group into a tight crash-restart loop — every poll past offset 4,418,902 fails to deserialize, so healthy traffic is starved while the group rebalances.",
	summary:
		"The signal jumped well past its baseline over the last 10 minutes, isolated to a single service/group. 94% of the failures share one Avro DeserializationException thrown from the decoder; the rest are rebalance timeouts cascading from the repeated restarts.",
	severityAssessment: "critical",
	affectedScope: "1 consumer group across 3 pods. No upstream producers affected; downstream sees 401/timeouts.",
	confidence: "high",
	evidence: [
		{
			note: "94% of errors share the same Avro decode failure at the same offset.",
			traceIds: ["a1b2c3d4e5f600112233", "bb19f0aa77cc1122ee44"],
			logPatterns: ["Avro deserialize failed: unknown union branch 7"],
			relatedServices: ["kafka-consumers", "app-store-connect"],
		},
		{
			note: "Rebalances spiked 12× as the group repeatedly left and rejoined.",
			traceIds: [],
			logPatterns: ["Rebalance triggered: member left group"],
			relatedServices: ["kafka-consumers"],
		},
	],
	suggestedActions: [
		"Pause the consumer group and skip past offset 4,418,902 to break the crash loop.",
		"Check the producer that wrote around 14:02 UTC for a schema-registry bump that added the new union branch.",
		"Add a dead-letter-queue fallback to the decode path so one malformed record can't halt the group.",
	],
} as unknown as import("@maple/domain/http").AiTriageResult
// TEMP LOCAL PREVIEW MOCK — revert before commit.
const MOCK_RUN = {
	status: "completed",
	createdAt: new Date(Date.now() - 90_000).toISOString(),
	completedAt: new Date(Date.now() - 60_000).toISOString(),
	model: "kimi-k2.6",
	error: null,
	result: MOCK_RESULT,
} as unknown as import("@maple/domain/http").AiTriageRunDocument

/** Zero-DOM trigger: firing once on mount is how "resolved to no runs" kicks off a diagnosis. */
function AutoRunTrigger({ onFire }: { onFire: () => void }) {
	useMountEffect(() => {
		onFire()
	})
	return null
}

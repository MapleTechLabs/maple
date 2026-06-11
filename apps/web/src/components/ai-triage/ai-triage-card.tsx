import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { Link } from "@tanstack/react-router"
import { Exit } from "effect"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { cn } from "@maple/ui/lib/utils"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { formatRelativeTime } from "@/lib/format"
import {
	AiTriageRunCreateRequest,
	type AiTriageIncidentKind,
	type AiTriageRunDocument,
	type ErrorIssueId,
} from "@maple/domain/http"

const SEVERITY_TONE: Record<string, string> = {
	critical: "bg-destructive/10 text-destructive",
	high: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
	medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
	low: "bg-muted text-muted-foreground",
}

const CONFIDENCE_TONE: Record<string, string> = {
	high: "bg-success/10 text-success",
	medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
	low: "bg-muted text-muted-foreground",
}

const FAILURE_HINTS: Record<string, string> = {
	no_openrouter_key: "No OpenRouter API key is configured for this organization.",
	no_structured_result: "The agent did not produce a structured result within its budget.",
	workflow_binding_unavailable: "The triage workflow is not available in this environment.",
}

export interface AiTriageCardProps {
	incidentKind: AiTriageIncidentKind
	/** Incident to (re-)run triage against; null disables the run button. */
	incidentId: string | null
	issueId?: ErrorIssueId
}

export function AiTriageCard({ incidentKind, incidentId, issueId }: AiTriageCardProps) {
	const runsQueryAtom = MapleApiAtomClient.query("aiTriage", "listRuns", {
		query: issueId !== undefined ? { issueId, limit: 1 } : { incidentKind, incidentId: incidentId ?? "", limit: 1 },
		reactivityKeys: ["aiTriageRuns", `aiTriage:${incidentKind}:${incidentId ?? issueId ?? ""}`],
	})
	const runsResult = useAtomValue(runsQueryAtom)
	const refreshRuns = useAtomRefresh(runsQueryAtom)

	const createRun = useAtomSet(MapleApiAtomClient.mutation("aiTriage", "createRun"), {
		mode: "promiseExit",
	})
	const [isStarting, setIsStarting] = useState(false)

	const run: AiTriageRunDocument | null = Result.builder(runsResult)
		.onSuccess((value) => value.runs[0] ?? null)
		.orElse(() => null)

	const runActive = run?.status === "queued" || run?.status === "running"

	// Poll the background run while it's active (same pattern as the
	// ClickHouse schema-apply section).
	useEffect(() => {
		if (!runActive) return
		const id = setInterval(() => refreshRuns(), 3000)
		return () => clearInterval(id)
	}, [runActive, refreshRuns])

	const startRun = async () => {
		if (incidentId === null) return
		setIsStarting(true)
		const result = await createRun({
			payload: new AiTriageRunCreateRequest({
				incidentKind,
				incidentId,
				...(issueId !== undefined ? { issueId } : {}),
			}),
		})
		setIsStarting(false)
		if (Exit.isSuccess(result)) {
			refreshRuns()
			toast.success("AI triage started")
		} else {
			toast.error("Failed to start AI triage")
		}
	}

	return (
		<Card>
			<CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
				<div className="space-y-1">
					<CardTitle className="flex items-center gap-2 text-sm">
						AI triage
						{runActive ? <Spinner className="size-3.5" /> : null}
						{run?.status === "completed" && run.result ? (
							<>
								<Badge
									variant="outline"
									className={cn(SEVERITY_TONE[run.result.severityAssessment])}
								>
									{run.result.severityAssessment}
								</Badge>
								<Badge variant="outline" className={cn(CONFIDENCE_TONE[run.result.confidence])}>
									{run.result.confidence} confidence
								</Badge>
							</>
						) : null}
					</CardTitle>
					<CardDescription>
						{run === null
							? "No investigation has run for this incident yet."
							: runActive
								? "The agent is investigating this incident…"
								: run.status === "failed"
									? (FAILURE_HINTS[run.error ?? ""] ?? `Triage failed: ${run.error ?? "unknown error"}`)
									: `Investigated ${formatRelativeTime(run.completedAt ?? run.createdAt)}${run.model ? ` · ${run.model}` : ""}`}
					</CardDescription>
				</div>
				<Button
					size="sm"
					variant="outline"
					onClick={startRun}
					disabled={incidentId === null || runActive || isStarting}
				>
					{run === null ? "Run triage" : "Re-run"}
				</Button>
			</CardHeader>
			{run?.status === "completed" && run.result ? (
				<CardContent className="space-y-4 text-sm">
					<p className="text-foreground">{run.result.summary}</p>

					<div className="space-y-1">
						<div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
							Suspected cause
						</div>
						<p className="text-muted-foreground">{run.result.suspectedCause}</p>
					</div>

					<div className="space-y-1">
						<div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
							Affected scope
						</div>
						<p className="text-muted-foreground">{run.result.affectedScope}</p>
					</div>

					{run.result.evidence.length > 0 ? (
						<div className="space-y-2">
							<div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
								Evidence
							</div>
							{run.result.evidence.map((item, index) => (
								<div key={index} className="rounded-md border border-border/60 p-3">
									{item.note ? <p className="mb-2 text-muted-foreground">{item.note}</p> : null}
									<div className="flex flex-wrap gap-1.5">
										{item.traceIds.map((traceId) => (
											<Link
												key={traceId}
												to="/traces/$traceId"
												params={{ traceId }}
												className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground hover:bg-muted/70"
											>
												{traceId.slice(0, 16)}…
											</Link>
										))}
										{item.logPatterns.map((pattern) => (
											<span
												key={pattern}
												className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
											>
												{pattern}
											</span>
										))}
										{item.relatedServices.map((service) => (
											<Badge key={service} variant="outline" className="text-[11px]">
												{service}
											</Badge>
										))}
									</div>
								</div>
							))}
						</div>
					) : null}

					{run.result.suggestedActions.length > 0 ? (
						<div className="space-y-1">
							<div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
								Suggested actions
							</div>
							<ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
								{run.result.suggestedActions.map((action) => (
									<li key={action}>{action}</li>
								))}
							</ol>
						</div>
					) : null}
				</CardContent>
			) : null}
		</Card>
	)
}

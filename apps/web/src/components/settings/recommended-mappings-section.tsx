import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import type { V2Recommendation } from "@maple/domain/http/v2"
import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { ArrowRotateAnticlockwiseIcon, CheckIcon, CodeIcon } from "@/components/icons"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import {
	ingestAttributeMappingsListAtom,
	recommendationIssuesListAtom,
} from "@/lib/services/atoms/ingestion-atoms"
import { formatNumber } from "@maple/ui/lib/format"
import { DocsLink } from "@/components/common/docs-link"
import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { SettingsSection } from "@/components/settings/settings-section"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { useKeyedAsyncAction } from "@/hooks/use-mutation-action"
import { toastExit } from "@/lib/error-toast"
import { SegmentedSelect } from "@/components/common/segmented-select"

type IssueKind = V2Recommendation["kind"]
type IssueStatus = V2Recommendation["status"]

// Mono uppercase kind tags in the row's leading lane (Paper ingestion redesign).
const KIND_TAG: Record<IssueKind, { label: string; className: string }> = {
	rename: { label: "Rename", className: TONE_TEXT.info },
	"double-emission": { label: "Duplicate", className: TONE_TEXT.warn },
	naming: { label: "Naming", className: TONE_TEXT.warn },
} satisfies Record<IssueKind, { label: string; className: string }>

const STATUS_BADGE: Record<IssueStatus, { label: string; variant: "ok" | "done" | "secondary" }> = {
	open: { label: "Open", variant: "secondary" },
	dismissed: { label: "Dismissed", variant: "secondary" },
	applied: { label: "Applied", variant: "ok" },
	resolved: { label: "Resolved", variant: "done" },
} satisfies Record<IssueStatus, { label: string; variant: "ok" | "done" | "secondary" }>

function recSentence(issue: V2Recommendation) {
	if (issue.kind === "double-emission") {
		return (
			<>
				<span className="text-foreground font-medium">Standardize on</span>{" "}
				<InlineCode variant="plain">{issue.canonical_key}</InlineCode>
				<span className="text-muted-foreground">; spans also emit </span>
				<InlineCode variant="plain">{issue.source_key}</InlineCode>
			</>
		)
	}
	if (issue.kind === "naming") {
		return (
			<>
				<span className="text-foreground font-medium">Rename non-conforming key</span>{" "}
				<InlineCode variant="plain">{issue.source_key}</InlineCode>
			</>
		)
	}
	return (
		<>
			<span className="text-foreground font-medium">Rename</span>{" "}
			<InlineCode variant="plain">{issue.source_key}</InlineCode>{" "}
			<span className="text-muted-foreground">→</span>{" "}
			<InlineCode variant="plain">{issue.canonical_key}</InlineCode>
		</>
	)
}

export function RecommendedMappingsSection() {
	const isAdmin = useIsOrgAdmin()
	const [tab, setTab] = useState<"open" | "closed">("open")

	const listResult = useAtomValue(recommendationIssuesListAtom)
	const refreshIssues = useAtomRefresh(recommendationIssuesListAtom)
	// Applying a recommendation creates a mapping, so refresh the mappings list too.
	const refreshMappings = useAtomRefresh(ingestAttributeMappingsListAtom)

	const createMutation = useAtomSet(MapleApiV2AtomClient.mutation("attributeMappings", "create"), {
		mode: "promiseExit",
	})
	const dismissMutation = useAtomSet(
		MapleApiV2AtomClient.mutation("instrumentationRecommendations", "dismiss"),
		{
			mode: "promiseExit",
		},
	)
	const reopenMutation = useAtomSet(
		MapleApiV2AtomClient.mutation("instrumentationRecommendations", "reopen"),
		{
			mode: "promiseExit",
		},
	)

	const issues = Result.builder(listResult)
		.onSuccess((r) => [...r.data])
		.orElse(() => [] as V2Recommendation[])

	const openIssues = issues.filter((i) => i.status === "open")
	const closedIssues = issues.filter((i) => i.status !== "open")

	const apply = useKeyedAsyncAction(async (_id: string, issue: V2Recommendation) => {
		if (issue.kind !== "rename" || !issue.canonical_key) return
		const canonicalKey = issue.canonical_key
		const result = await createMutation({
			payload: {
				name: `Rename ${issue.source_key} → ${canonicalKey}`,
				source_context: "span",
				source_key: issue.source_key,
				target_key: canonicalKey,
				operation: "copy",
			},
		})
		if (
			toastExit(result, {
				success: `Mapping created: ${issue.source_key} → ${canonicalKey}`,
				error: "Failed to create mapping",
			})
		) {
			refreshIssues()
			refreshMappings()
		}
	})

	// Dismiss and reopen share one per-row pending flag: a row only ever shows one of them.
	const triage = useKeyedAsyncAction(async (id: V2Recommendation["id"], action: "dismiss" | "reopen") => {
		const result =
			action === "dismiss"
				? await dismissMutation({ params: { id } })
				: await reopenMutation({ params: { id } })
		const error =
			action === "dismiss" ? "Failed to dismiss recommendation" : "Failed to reopen recommendation"
		if (toastExit(result, { error })) refreshIssues()
	})

	// Opportunistic: only surface when there's something open or dismissed to act on.
	const hasRelevant = issues.some((i) => i.status === "open" || i.status === "dismissed")
	if (!Result.isSuccess(listResult) || !hasRelevant) {
		return null
	}

	const rows = tab === "open" ? openIssues : closedIssues

	return (
		<SettingsSection
			title="Recommendations"
			description="Deprecated or non-conforming attribute keys found on your spans in the last 24 hours."
			padded={false}
			actions={
				<SegmentedSelect
					size="sm"
					aria-label="Recommendation status"
					value={tab}
					onChange={setTab}
					options={[
						{ value: "open", label: `Open · ${openIssues.length}` },
						{ value: "closed", label: `Closed · ${closedIssues.length}` },
					]}
				/>
			}
		>
			{rows.length === 0 ? (
				<EmptyMessage className="flex flex-col items-center gap-2 text-sm">
					<p>
						{tab === "open"
							? "No open recommendations. Your span attributes look healthy."
							: "Applied and dismissed recommendations show up here."}
					</p>
					{tab === "open" && <DocsLink page="otelConventions" />}
				</EmptyMessage>
			) : (
				<div className="divide-y">
					{rows.map((issue) => {
						const kindTag = KIND_TAG[issue.kind]
						const status = STATUS_BADGE[issue.status]
						const isApplying = apply.isPending(issue.id)
						const isBusy = triage.isPending(issue.id)
						const fixedAtIngest = issue.kind === "rename"

						return (
							<div
								key={issue.id}
								className="hover:bg-muted/20 flex items-start gap-3 px-4 py-3 transition-colors"
							>
								<Eyebrow
									variant="mono"
									className={cn("w-20 shrink-0 pt-0.5", kindTag.className)}
								>
									{kindTag.label}
								</Eyebrow>
								<div className="min-w-0 flex-1 space-y-1">
									<Link
										to="/recommendations/$recommendationKey"
										params={{ recommendationKey: issue.id }}
										className="block text-sm break-words underline-offset-4 decoration-muted-foreground/40 hover:underline"
									>
										{recSentence(issue)}
									</Link>
									<p className="text-muted-foreground text-2xs">
										{formatNumber(issue.usage_count)} spans in 24h ·{" "}
										{fixedAtIngest
											? "fixed at ingest, no code change"
											: "needs a code change"}
									</p>
								</div>

								<div className="flex shrink-0 items-center gap-1.5">
									{issue.status === "open" ? (
										<>
											{fixedAtIngest ? (
												isAdmin ? (
													<Button
														size="sm"
														onClick={() => void apply.run(issue.id, issue)}
														loading={isApplying}
													>
														<CheckIcon />
														Apply fix
													</Button>
												) : null
											) : (
												<Button
													variant="outline"
													size="sm"
													render={
														<Link
															to="/recommendations/$recommendationKey"
															params={{ recommendationKey: issue.id }}
														/>
													}
												>
													<CodeIcon />
													How to fix
												</Button>
											)}
											<Button
												variant="ghost"
												size="sm"
												className="text-muted-foreground hover:text-foreground"
												onClick={() => void triage.run(issue.id, "dismiss")}
												loading={isBusy}
											>
												Dismiss
											</Button>
										</>
									) : issue.status === "dismissed" ? (
										<>
											<Badge variant={status.variant}>{status.label}</Badge>
											<Button
												variant="outline"
												size="sm"
												onClick={() => void triage.run(issue.id, "reopen")}
												loading={isBusy}
											>
												<ArrowRotateAnticlockwiseIcon />
												Reopen
											</Button>
										</>
									) : (
										<Badge variant={status.variant}>{status.label}</Badge>
									)}
								</div>
							</div>
						)
					})}
				</div>
			)}
		</SettingsSection>
	)
}

import { SectionHeading } from "@/components/common/section-heading"
import { ResourceNotFound } from "@/components/common/resource-not-found"
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { useMutationAction } from "@/hooks/use-mutation-action"
import { Exit } from "effect"
import { useMemo } from "react"
import { toastManager } from "@maple/ui/components/ui/toast"

import type { V2Recommendation } from "@maple/domain/http/v2"

import { ResultPage } from "@/components/layout/result-page"
import { DetailHeader } from "@/components/common/detail-header"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import {
	ingestAttributeMappingsListAtom,
	recommendationIssuesListAtom,
} from "@/lib/services/atoms/ingestion-atoms"
import { RelativeTime } from "@/components/common/relative-time"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Panel } from "@maple/ui/components/ui/panel"
import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import {
	ArrowRotateAnticlockwiseIcon,
	BoltIcon,
	CircleCheckIcon,
	CircleXmarkIcon,
	CodeIcon,
	PulseIcon,
	XmarkIcon,
} from "@/components/icons"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { DetailRail } from "@maple/ui/components/detail-rail"

/** This rail runs a narrower label column than the shared default. */
const Row = (props: Omit<React.ComponentProps<typeof DetailRail.Row>, "labelWidth">) => (
	<DetailRail.Row labelWidth="64px" {...props} />
)

export const Route = createFileRoute("/recommendations/$recommendationKey")({
	component: RecommendationDetailPage,
})

const INGESTION_HREF = "/settings?tab=ingestion"

type IssueKind = V2Recommendation["kind"]
type IssueStatus = V2Recommendation["status"]
type BusyAction = "apply" | "dismiss" | "reopen" | null

const KIND_BADGE: Record<IssueKind, { label: string; variant: "ok" | "warn" | "info" }> = {
	rename: { label: "Safe rename", variant: "ok" },
	"double-emission": { label: "Both emitted", variant: "warn" },
	naming: { label: "Naming", variant: "info" },
} satisfies Record<IssueKind, { label: string; variant: "ok" | "warn" | "info" }>

const STATUS_BADGE: Record<IssueStatus, { label: string; variant: "ok" | "secondary" | "outline" }> = {
	open: { label: "Open", variant: "outline" },
	dismissed: { label: "Dismissed", variant: "secondary" },
	applied: { label: "Applied", variant: "ok" },
	resolved: { label: "Resolved", variant: "ok" },
} satisfies Record<IssueStatus, { label: string; variant: "ok" | "secondary" | "outline" }>

const MODE = {
	auto: {
		label: "Auto-apply",
		icon: BoltIcon,
		className: "border-primary/30 text-primary",
		title: "Maple can apply this for you — Apply creates the ingest mapping.",
	},
	manual: {
		label: "Manual fix",
		icon: CodeIcon,
		className: "text-muted-foreground",
		title: "Fix this in your SDK — an ingest mapping can't resolve it.",
	},
} as const

/** The recommendation rendered as a sentence with mono-styled attribute keys. */
function recSentence(issue: V2Recommendation) {
	if (issue.kind === "double-emission") {
		return (
			<>
				<span className="text-foreground font-medium">Standardize on</span>{" "}
				<InlineCode variant="plain">{issue.canonical_key}</InlineCode>
				<span className="text-muted-foreground"> — spans also emit </span>
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

function RecommendationDetailPage() {
	const { recommendationKey } = Route.useParams()

	const listResult = useAtomValue(recommendationIssuesListAtom)
	const refreshIssues = useAtomRefresh(recommendationIssuesListAtom)
	// Applying a recommendation creates a mapping, so refresh the mappings list too.
	const refreshMappings = useAtomRefresh(ingestAttributeMappingsListAtom)

	const [create, applying] = useMutationAction(
		MapleApiV2AtomClient.mutation("attributeMappings", "create"),
		{
			error: "Failed to create mapping",
			onSuccess: () => {
				refreshIssues()
				refreshMappings()
			},
		},
	)
	const [dismiss, dismissing] = useMutationAction(
		MapleApiV2AtomClient.mutation("instrumentationRecommendations", "dismiss"),
		{ error: "Failed to dismiss recommendation", onSuccess: () => refreshIssues() },
	)
	const [reopen, reopening] = useMutationAction(
		MapleApiV2AtomClient.mutation("instrumentationRecommendations", "reopen"),
		{ error: "Failed to reopen recommendation", onSuccess: () => refreshIssues() },
	)
	const busy: BusyAction = applying ? "apply" : dismissing ? "dismiss" : reopening ? "reopen" : null

	const issue = useMemo(
		() =>
			Result.builder(listResult)
				.onSuccess((r) => r.data.find((i) => i.id === recommendationKey) ?? null)
				.orElse(() => null),
		[listResult, recommendationKey],
	)

	async function handleApply(target: V2Recommendation) {
		if (target.kind !== "rename" || !target.canonical_key) return
		const canonicalKey = target.canonical_key
		const result = await create({
			payload: {
				name: `Rename ${target.source_key} → ${canonicalKey}`,
				source_context: "span",
				source_key: target.source_key,
				target_key: canonicalKey,
				operation: "copy",
			},
		})
		if (Exit.isSuccess(result)) {
			toastManager.add({
				title: `Mapping created — ${target.source_key} → ${canonicalKey}`,
				type: "success",
			})
		}
	}

	return (
		<ResultPage
			breadcrumbs={[{ label: "Ingestion", href: INGESTION_HREF }]}
			result={listResult}
			select={() => issue}
			crumb={(issue) => `Recommendation #${issue.number}`}
			width="narrow"
			gap="lg"
			errorTitle="Couldn't load recommendation"
			onRetry={refreshIssues}
			loading={
				<>
					<Skeleton className="h-12 w-full" />
					<Skeleton className="h-28 w-full" />
					<Skeleton className="h-24 w-full" />
				</>
			}
			notFound={
				<ResourceNotFound
					icon={<PulseIcon className="text-muted-foreground" />}
					title="Recommendation not found"
					description="This recommendation isn't in your list anymore. It may have resolved on its own."
					backLink={<Link to="/settings" search={{ tab: "ingestion" }} />}
					backLabel="Back to recommendations"
				/>
			}
			header={(issue) => {
				const status = STATUS_BADGE[issue.status]
				return (
					<DetailHeader
						kind="Recommendation"
						title={recSentence(issue)}
						titleText={recTitleText(issue)}
						meta={
							<Badge variant={status.variant} size="lg">
								{status.label}
							</Badge>
						}
					/>
				)
			}}
			rightPanel={(issue) => (
				<DetailSidebar
					issue={issue}
					busy={busy}
					isApplyable={isApplyable(issue)}
					isLive={isLive(issue)}
					onApply={() => void handleApply(issue)}
					onDismiss={() => void dismiss({ params: { id: issue.id } })}
					onReopen={() => void reopen({ params: { id: issue.id } })}
				/>
			)}
		>
			{(issue) => (
				<>
					<Summary issue={issue} />
					<ChangeBreakdown issue={issue} />
					<CautionCallout issue={issue} isApplyable={isApplyable(issue)} />
					{isApplyable(issue) && issue.canonical_key ? (
						<MappingBlock issue={issue} isLive={isLive(issue)} />
					) : (
						<SdkFixBlock issue={issue} />
					)}
				</>
			)}
		</ResultPage>
	)
}

const isApplyable = (issue: V2Recommendation) => issue.kind === "rename" && Boolean(issue.canonical_key)
const isLive = (issue: V2Recommendation) => issue.status === "applied" || issue.status === "resolved"

/** `recSentence` as plain text, for the truncated title's tooltip. */
function recTitleText(issue: V2Recommendation): string {
	if (issue.kind === "double-emission") {
		return `Standardize on ${issue.canonical_key}, spans also emit ${issue.source_key}`
	}
	if (issue.kind === "naming") return `Rename non-conforming key ${issue.source_key}`
	return `Rename ${issue.source_key} → ${issue.canonical_key}`
}

/** Plain-language explanation of the recommendation, with mono-styled keys. */
function Summary({ issue }: { issue: V2Recommendation }) {
	let body: React.ReactNode
	if (issue.kind === "double-emission") {
		body = (
			<>
				Your spans emit both <InlineCode variant="plain">{issue.source_key}</InlineCode> and{" "}
				<InlineCode variant="plain">{issue.canonical_key}</InlineCode>. Standardize on{" "}
				<InlineCode variant="plain">{issue.canonical_key}</InlineCode> in your SDK — an ingest mapping
				can't merge them because the canonical key already exists on your spans.
			</>
		)
	} else if (issue.kind === "naming") {
		body = (
			<>
				<InlineCode variant="plain">{issue.source_key}</InlineCode> doesn't follow OpenTelemetry's
				lowercase <InlineCode variant="plain">dotted.snake_case</InlineCode> convention. Rename it
				where your spans are created so it conforms to the semantic conventions.
			</>
		)
	} else {
		body = (
			<>
				<InlineCode variant="plain">{issue.source_key}</InlineCode> is a deprecated or non-conforming
				OpenTelemetry attribute key. Maple can rewrite it to{" "}
				<InlineCode variant="plain">{issue.canonical_key}</InlineCode> at ingest time so newly
				ingested spans use the current semantic-convention name.
			</>
		)
	}
	return <p className="text-base leading-relaxed text-foreground/90">{body}</p>
}

/** Before → after card — the deprecated key today vs. the key Maple writes. */
function ChangeBreakdown({ issue }: { issue: V2Recommendation }) {
	const labels = {
		rename: { from: "Deprecated key on your spans today", to: "Canonical key Maple will write" },
		"double-emission": {
			from: "Deprecated key — still emitted",
			to: "Canonical key — already present",
		},
		naming: { from: "Non-conforming key", to: "" },
	}[issue.kind]

	const note =
		issue.kind === "double-emission"
			? "Both keys are already on your spans — an ingest mapping can't merge them. Standardize on the canonical key in your SDK."
			: issue.kind === "naming"
				? "No confident canonical target — rename this attribute at your SDK."
				: null

	return (
		<section>
			<SectionHeading variant="eyebrow" title="What changes" />
			<Panel>
				<div className="flex items-start gap-3 px-4 py-3">
					<CircleXmarkIcon size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
					<div className="min-w-0 flex-1">
						<p className="text-xs text-muted-foreground">{labels.from}</p>
						<code className="font-mono text-sm break-all text-foreground line-through decoration-muted-foreground/40">
							{issue.source_key}
						</code>
					</div>
					<span className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
						{formatNumber(issue.usage_count)} spans · 24h
					</span>
				</div>
				{issue.canonical_key ? (
					<div className="flex items-start gap-3 border-t border-border/60 px-4 py-3">
						<CircleCheckIcon size={16} className="mt-0.5 shrink-0 text-severity-info" />
						<div className="min-w-0 flex-1">
							<p className="text-xs text-muted-foreground">{labels.to}</p>
							<code className="font-mono text-sm break-all text-foreground">
								{issue.canonical_key}
							</code>
						</div>
					</div>
				) : null}
			</Panel>
			{note ? <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{note}</p> : null}
		</section>
	)
}

/** Orange "Please note" caution, mirroring the reference layout. */
function CautionCallout({ issue, isApplyable }: { issue: V2Recommendation; isApplyable: boolean }) {
	const text =
		isApplyable && issue.canonical_key ? (
			<>
				Applying creates an ingest mapping that copies{" "}
				<InlineCode variant="plain">{issue.source_key}</InlineCode> →{" "}
				<InlineCode variant="plain">{issue.canonical_key}</InlineCode> on newly ingested spans.
				Existing spans aren't rewritten, and the mapping never overwrites a target that already
				exists.
			</>
		) : (
			<>
				Maple can't resolve this with an ingest mapping. The fix is to rename the attribute at your
				SDK / instrumentation so spans emit the conforming key.
			</>
		)
	return (
		<div className="rounded-r-md border-l-2 border-severity-warn bg-severity-warn/8 px-4 py-3">
			<p className="text-sm leading-relaxed text-foreground/90">
				<span className="font-medium text-severity-warn">Please note:</span> {text}
			</p>
		</div>
	)
}

/** The exact ingest mapping Apply creates — the analog of the reference page's SQL block. */
function MappingBlock({ issue, isLive }: { issue: V2Recommendation; isLive: boolean }) {
	const snippet = `WHEN span attribute \`${issue.source_key}\` is present\nCOPY → \`${issue.canonical_key}\``

	return (
		<section>
			<SectionHeading variant="eyebrow" title={isLive ? "Active ingest mapping" : "What Apply does"} />
			<Panel tone="muted">
				<div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
					<span className="text-xs text-muted-foreground">
						{isLive ? "This mapping is live" : "Ingest attribute mapping"}
					</span>
					<CopyButton value={snippet} label="Mapping" size="icon-sm" tooltip />
				</div>
				<div className="space-y-1.5 px-4 py-3 font-mono text-xs leading-relaxed">
					<div className="flex items-baseline gap-3">
						<span className="w-12 shrink-0 text-muted-foreground">when</span>
						<span className="break-all">
							span attribute <span className="text-foreground">{issue.source_key}</span> is
							present
						</span>
					</div>
					<div className="flex items-baseline gap-3">
						<span className="w-12 shrink-0 text-muted-foreground">copy</span>
						<span className="break-all">
							<span className="text-muted-foreground">→</span>{" "}
							<span className="text-severity-info">{issue.canonical_key}</span>
						</span>
					</div>
				</div>
			</Panel>
		</section>
	)
}

function SdkFixBlock({ issue }: { issue: V2Recommendation }) {
	return (
		<section>
			<SectionHeading variant="eyebrow" title="How to fix" />
			<Panel tone="muted" className="px-4 py-3">
				<p className="text-sm leading-relaxed text-muted-foreground">
					Rename <InlineCode variant="plain">{issue.source_key}</InlineCode>
					{issue.canonical_key ? (
						<>
							{" "}
							to <InlineCode variant="plain">{issue.canonical_key}</InlineCode>
						</>
					) : (
						<> to a lowercase, dotted semantic-convention key</>
					)}{" "}
					where your spans are created (the instrumentation / SDK). Once the conforming key appears
					on incoming spans, this recommendation resolves automatically.
				</p>
			</Panel>
		</section>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Right sidebar
 * -------------------------------------------------------------------------------------------------*/

function DetailSidebar({
	issue,
	busy,
	isApplyable,
	isLive,
	onApply,
	onDismiss,
	onReopen,
}: {
	issue: V2Recommendation
	busy: BusyAction
	isApplyable: boolean
	isLive: boolean
	onApply: () => void
	onDismiss: () => void
	onReopen: () => void
}) {
	const kindBadge = KIND_BADGE[issue.kind]
	const mode = issue.kind === "rename" ? MODE.auto : MODE.manual
	const ModeIcon = mode.icon
	const status = STATUS_BADGE[issue.status]

	return (
		<div className="flex h-full w-80 shrink-0 flex-col overflow-y-auto border-l bg-card/30">
			<DetailRail.Group label="Details">
				<Row label="Status">
					<Badge variant={status.variant}>{status.label}</Badge>
				</Row>
				<Row label="Type">
					<Badge variant={kindBadge.variant}>{kindBadge.label}</Badge>
				</Row>
				<Row label="Fix">
					<Badge variant="outline" className={cn("gap-1", mode.className)} title={mode.title}>
						<ModeIcon size={11} />
						{mode.label}
					</Badge>
				</Row>
				<Row label="Spans">
					<span className="tabular-nums text-foreground">{formatNumber(issue.usage_count)}</span>
				</Row>
				<Row label="Opened">
					<RelativeTime
						value={issue.opened_at}
						tooltip="title"
						className="tabular-nums text-muted-foreground"
					/>
				</Row>
				<Row label="Key" title={issue.source_key}>
					<code className="truncate font-mono text-xs text-muted-foreground">
						{issue.source_key}
					</code>
				</Row>
			</DetailRail.Group>

			<DetailRail.Group label="How this resolves">
				<ul className="flex flex-col gap-1.5 text-xs leading-relaxed text-muted-foreground">
					{[
						"the deprecated key stops appearing on your spans",
						"an ingest mapping covers the key",
						"you apply the rename",
					].map((line) => (
						<li key={line} className="flex gap-2">
							<span aria-hidden className="select-none text-muted-foreground/50">
								·
							</span>
							<span>{line}</span>
						</li>
					))}
				</ul>
			</DetailRail.Group>

			<DetailRail.Group label="Action">
				{isLive ? (
					<div className="flex flex-col gap-3">
						<p className="flex items-center gap-2 text-sm text-severity-info">
							<CircleCheckIcon size={15} />
							{issue.status === "resolved" ? "Resolved" : "Mapping is active"}
						</p>
						<Button
							variant="outline"
							size="sm"
							className="w-full"
							render={<Link to="/settings" search={{ tab: "ingestion" }} />}
						>
							Manage mappings
						</Button>
					</div>
				) : issue.status === "dismissed" ? (
					<div className="flex flex-col gap-2">
						<Button
							variant="outline"
							size="sm"
							className="w-full"
							onClick={onReopen}
							loading={busy === "reopen"}
						>
							<ArrowRotateAnticlockwiseIcon size={15} />
							Reopen recommendation
						</Button>
						<p className="text-xs leading-relaxed text-muted-foreground">
							Dismissed recommendations come back if the key is still emitted.
						</p>
					</div>
				) : (
					<div className="flex flex-col gap-2">
						{isApplyable ? (
							<Button className="w-full" onClick={onApply} loading={busy === "apply"}>
								<BoltIcon size={15} />
								Apply mapping
							</Button>
						) : (
							<p className="text-xs leading-relaxed text-muted-foreground">
								This one is a manual fix — rename the attribute at your SDK. Maple can't apply
								it for you.
							</p>
						)}
						<Button className="w-full" onClick={onDismiss} loading={busy === "dismiss"}>
							<XmarkIcon size={15} />
							Dismiss recommendation
						</Button>
					</div>
				)}
			</DetailRail.Group>
		</div>
	)
}

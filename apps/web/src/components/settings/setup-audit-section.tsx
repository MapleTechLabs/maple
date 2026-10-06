import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { countLabel } from "@maple/ui/lib/format"
import { Card, CardAction, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import type { V2SetupAudit, V2SetupAuditCheck } from "@maple/domain/http/v2"

import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { Alert, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Badge } from "@maple/ui/components/ui/badge"
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { Button, buttonVariants } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import {
	ArrowRotateAnticlockwiseIcon,
	CircleCheckIcon,
	CircleInfoIcon,
	CircleWarningIcon,
	ServerIcon,
	type IconComponent,
} from "@/components/icons"
import { setupAuditAtom } from "@/lib/services/atoms/audit-atoms"
import { DocsLink, EmptyActions } from "@/components/common/docs-link"
import type { SettingsTab } from "@/components/settings/settings-nav"
import { RelativeTime } from "@/components/common/relative-time"
import { ErrorState } from "@/components/common/error-state"

type Severity = V2SetupAuditCheck["severity"]
type Category = V2SetupAuditCheck["category"]

const SEVERITY: Record<Severity, { label: string; icon: IconComponent; className: string }> = {
	critical: { label: "Critical", icon: CircleWarningIcon, className: TONE_TEXT.crit },
	warn: { label: "Warning", icon: CircleWarningIcon, className: TONE_TEXT.warn },
	info: { label: "Info", icon: CircleInfoIcon, className: TONE_TEXT.info },
} satisfies Record<Severity, { label: string; icon: IconComponent; className: string }>

const SEVERITY_ORDER: ReadonlyArray<Severity> = ["critical", "warn", "info"]

/**
 * Each category's owning surface, so a finding is one click from where it gets fixed. `tab` targets a
 * sibling settings tab; `to` targets a standalone route. Kept as separate fields because TanStack
 * Router types `search` per route — a widened `object` does not typecheck.
 */
type CategoryTarget =
	| { label: string; fixLabel: string; tab: SettingsTab }
	| { label: string; fixLabel: string; to: "/alerts" | "/traces" | "/integrations" }

const CATEGORY: Record<Category, CategoryTarget> = {
	alerting: { label: "Alerting", fixLabel: "Open alerts", to: "/alerts" },
	notifications: { label: "Notifications", fixLabel: "Open notifications", tab: "notifications" },
	ingestion: { label: "Ingestion", fixLabel: "Open ingestion", tab: "ingestion" },
	attributes: { label: "Attributes", fixLabel: "Open ingestion", tab: "ingestion" },
	traces: { label: "Traces", fixLabel: "Open traces", to: "/traces" },
	integrations: { label: "Integrations", fixLabel: "Open integrations", to: "/integrations" },
	data_platform: { label: "Data platform", fixLabel: "Open data platform", tab: "data-platform" },
} satisfies Record<Category, CategoryTarget>

function CategoryLink({
	target,
	label,
	className,
}: {
	target: CategoryTarget
	label: string
	className: string
}) {
	return "tab" in target ? (
		<Link to="/settings" search={{ tab: target.tab }} className={className}>
			{label}
		</Link>
	) : (
		<Link to={target.to} className={className}>
			{label}
		</Link>
	)
}

const CATEGORY_ORDER: ReadonlyArray<Category> = [
	"alerting",
	"notifications",
	"ingestion",
	"attributes",
	"traces",
	"integrations",
	"data_platform",
]

function SummaryPill({ count, label, className }: { count: number; label: string; className: string }) {
	return (
		<span className={cn("font-mono text-[11px] leading-3.5", count === 0 && "text-muted-foreground")}>
			<span className={cn("font-medium", count > 0 && className)}>{count}</span> {label}
		</span>
	)
}

function CheckRow({ check }: { check: V2SetupAuditCheck }) {
	const severity = SEVERITY[check.severity]
	const category = CATEGORY[check.category]
	const isFinding = check.status === "fail"
	const Icon = isFinding ? severity.icon : check.status === "pass" ? CircleCheckIcon : CircleInfoIcon

	return (
		<div className="flex items-start gap-3 border-t px-4 py-3">
			<Icon
				size={16}
				className={cn("mt-0.5 shrink-0", isFinding ? severity.className : "text-muted-foreground/60")}
			/>
			<div className="flex min-w-0 flex-col gap-1.5">
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-sm font-medium">{check.title}</span>
					<InlineCode variant="plain" className="text-[11px]">
						{check.id}
					</InlineCode>
					{check.status === "skip" && (
						<Badge variant="secondary" size="xs">
							Skipped
						</Badge>
					)}
				</div>
				{check.detail !== null && (
					<p className="text-muted-foreground text-xs leading-relaxed">{check.detail}</p>
				)}
				{check.affected.length > 0 && (
					<div className="flex flex-wrap items-center gap-1.5 pt-0.5">
						{check.affected.map((entity) => (
							<InlineCode
								key={`${entity.kind}:${entity.name}`}
								title={entity.note ?? undefined}
								className="text-muted-foreground text-[11px] leading-4"
							>
								{entity.name}
							</InlineCode>
						))}
						{check.affected_count > check.affected.length && (
							<span className="text-muted-foreground/70 text-[11px]">
								+{check.affected_count - check.affected.length} more
							</span>
						)}
					</div>
				)}
				{isFinding && (
					<p className="text-muted-foreground/80 pt-0.5 text-xs leading-relaxed">
						{check.fix_hint}
					</p>
				)}
			</div>
			<div className="grow" />
			{isFinding && (
				<CategoryLink
					target={category}
					label="Fix"
					className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "shrink-0")}
				/>
			)}
		</div>
	)
}

function CategoryCard({
	category,
	checks,
}: {
	category: Category
	checks: ReadonlyArray<V2SetupAuditCheck>
}) {
	const meta = CATEGORY[category]
	const findings = checks.filter((check) => check.status === "fail").length
	return (
		<Card className="overflow-hidden">
			<CardHeader className="items-center px-4 pt-4 pb-3">
				<CardTitle render={<h3 />} className="flex items-center gap-3 text-sm font-medium">
					{meta.label}
					<span className="text-muted-foreground font-mono text-[11px] font-normal">
						{findings > 0 ? countLabel(findings, "finding") : "clear"}
					</span>
				</CardTitle>
				<CardAction className="self-center">
					<CategoryLink
						target={meta}
						label={meta.fixLabel}
						className={buttonVariants({ variant: "ghost", size: "sm" })}
					/>
				</CardAction>
			</CardHeader>
			{checks.map((check) => (
				<CheckRow key={check.id} check={check} />
			))}
		</Card>
	)
}

function Report({ audit }: { audit: V2SetupAudit }) {
	const [showPassing, setShowPassing] = useState(false)
	const refresh = useAtomRefresh(setupAuditAtom)

	const grouped = useMemo(() => {
		const visible = audit.checks.filter((check) => showPassing || check.status === "fail")
		const bySeverity = (a: V2SetupAuditCheck, b: V2SetupAuditCheck) =>
			SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
			a.id.localeCompare(b.id)
		return CATEGORY_ORDER.map((category) => ({
			category,
			checks: visible.filter((check) => check.category === category).sort(bySeverity),
		})).filter((group) => group.checks.length > 0)
	}, [audit.checks, showPassing])

	const { summary } = audit
	const findingCount = summary.critical + summary.warn + summary.info

	if (audit.data_status === "no_data") {
		return (
			<Empty className="rounded-lg border bg-card py-10">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<ServerIcon size={16} />
					</EmptyMedia>
					<EmptyTitle>No telemetry yet</EmptyTitle>
					<EmptyDescription>
						The audit runs once your first service reports in. Connect one from the Ingestion tab
						and come back.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyActions>
					<Link
						to="/settings"
						search={{ tab: "ingestion" }}
						className={buttonVariants({ variant: "outline", size: "sm" })}
					>
						Go to Ingestion
					</Link>
					<DocsLink page="quickstart" />
				</EmptyActions>
			</Empty>
		)
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="bg-card flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-4 py-3">
				<SummaryPill count={summary.critical} label="critical" className={TONE_TEXT.crit} />
				<SummaryPill count={summary.warn} label="warning" className={TONE_TEXT.warn} />
				<SummaryPill count={summary.info} label="info" className={TONE_TEXT.info} />
				<span className="text-muted-foreground/40">·</span>
				<SummaryPill count={summary.pass} label="passing" className="text-severity-info" />
				{summary.skip > 0 && (
					<SummaryPill count={summary.skip} label="skipped" className="text-muted-foreground" />
				)}
				<div className="grow" />
				<RelativeTime value={audit.generated_at} className="text-muted-foreground/70 text-[11px]" />
				<Button variant="ghost" size="sm" onClick={() => refresh()}>
					<ArrowRotateAnticlockwiseIcon size={14} />
					Re-run
				</Button>
			</div>

			{!audit.telemetry_checks_available && (
				<Alert variant="warn" className="rounded-lg px-4 text-xs leading-relaxed">
					<CircleWarningIcon />
					<AlertTitle>Telemetry checks skipped.</AlertTitle>
					<AlertDescription>
						Your warehouse could not be queried, so only configuration was audited. The findings
						below still apply.
					</AlertDescription>
				</Alert>
			)}

			{findingCount === 0 && !showPassing ? (
				<div className="bg-card flex flex-col items-center gap-2 rounded-lg border px-4 py-10 text-center">
					<CircleCheckIcon size={20} className="text-severity-info" />
					<p className="text-sm font-medium">Everything checks out</p>
					<p className="text-muted-foreground text-xs">
						All {summary.pass} checks passed. Alerts can deliver, and your telemetry follows the
						conventions Maple reads.
					</p>
				</div>
			) : (
				grouped.map((group) => (
					<CategoryCard key={group.category} category={group.category} checks={group.checks} />
				))
			)}

			<button
				type="button"
				onClick={() => setShowPassing((value) => !value)}
				className="text-muted-foreground hover:text-foreground self-start text-xs transition-colors"
			>
				{showPassing
					? "Hide passing checks"
					: `Show ${summary.pass + summary.skip} passing and skipped checks`}
			</button>
		</div>
	)
}

export function SetupAuditSection() {
	const result = useAtomValue(setupAuditAtom)

	if (Result.isFailure(result)) {
		return <ErrorState error={result.cause} title="Could not run the audit" />
	}

	if (!Result.isSuccess(result)) {
		return (
			<div className="flex flex-col gap-4">
				<Skeleton className="h-12 w-full rounded-lg" />
				<Skeleton className="h-48 w-full rounded-lg" />
			</div>
		)
	}

	return <Report audit={result.value} />
}

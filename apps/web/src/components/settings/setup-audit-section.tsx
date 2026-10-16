import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { countLabel } from "@maple/ui/lib/format"
import { Panel } from "@maple/ui/components/ui/panel"
import { RefreshButton } from "@maple/ui/components/ui/refresh-button"
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
import { SettingsSection } from "@/components/settings/settings-section"

type Severity = V2SetupAuditCheck["severity"]
type Category = V2SetupAuditCheck["category"]

const SEVERITY: Record<Severity, { label: string; icon: IconComponent; className: string }> = {
	critical: { label: "Critical", icon: CircleWarningIcon, className: TONE_TEXT.crit },
	warn: { label: "Warning", icon: CircleWarningIcon, className: TONE_TEXT.warn },
	info: { label: "Info", icon: CircleInfoIcon, className: TONE_TEXT.info },
} satisfies Record<Severity, { label: string; icon: IconComponent; className: string }>

const SEVERITY_ORDER: ReadonlyArray<Severity> = ["critical", "warn", "info"]

/**
 * Where a finding gets fixed, so it is one click away. Kept as separate shapes because TanStack
 * Router types `search` per route; a widened `object` does not typecheck.
 */
type FixTarget =
	| { tab: SettingsTab }
	| { alertsTab: "rules" | "routing" }
	| { to: "/alerts" | "/traces" | "/integrations" | "/dashboards" }

type CategoryOpen = { label: string; target: FixTarget }

/** `open: null` means the category has no single screen that fixes its findings. */
const CATEGORY = {
	alerting: { label: "Alerting", open: { label: "Open alerts", target: { to: "/alerts" } } },
	notifications: { label: "Notifications", open: null },
	ingestion: { label: "Ingestion", open: { label: "Open ingestion", target: { tab: "ingestion" } } },
	attributes: { label: "Attributes", open: { label: "Open ingestion", target: { tab: "ingestion" } } },
	traces: { label: "Traces", open: { label: "Open traces", target: { to: "/traces" } } },
	integrations: {
		label: "Integrations",
		open: { label: "Open integrations", target: { to: "/integrations" } },
	},
	data_platform: {
		label: "Data platform",
		open: { label: "Open data platform", target: { tab: "data-platform" } },
	},
} satisfies Record<Category, { label: string; open: CategoryOpen | null }>

/**
 * Per-check overrides of the category target. `null` hides the Fix link: the fix has no UI yet and
 * the hint names where it lives (MCP tool or API).
 */
const CHECK_TARGET = new Map<string, FixTarget | null>([
	["CFG-ALERT-01", { alertsTab: "routing" }],
	["CFG-ALERT-02", { alertsTab: "rules" }],
	["CFG-ALERT-03", { alertsTab: "rules" }],
	["CFG-ALERT-04", { alertsTab: "routing" }],
	["CFG-NOTIF-01", null],
	["CFG-ANOM-01", null],
	["CFG-DASH-01", { to: "/dashboards" }],
])

const fixTargetFor = (check: V2SetupAuditCheck): FixTarget | null =>
	CHECK_TARGET.has(check.id)
		? (CHECK_TARGET.get(check.id) ?? null)
		: (CATEGORY[check.category].open?.target ?? null)

function FixLink({ target, label, className }: { target: FixTarget; label: string; className: string }) {
	if ("tab" in target) {
		return (
			<Link to="/settings" search={{ tab: target.tab }} className={className}>
				{label}
			</Link>
		)
	}
	if ("alertsTab" in target) {
		return (
			<Link to="/alerts" search={{ tab: target.alertsTab }} className={className}>
				{label}
			</Link>
		)
	}
	return (
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
		<span className={cn("font-mono text-2xs leading-3.5", count === 0 && "text-muted-foreground")}>
			<span className={cn("font-medium", count > 0 && className)}>{count}</span> {label}
		</span>
	)
}

function CheckRow({ check }: { check: V2SetupAuditCheck }) {
	const severity = SEVERITY[check.severity]
	const fixTarget = fixTargetFor(check)
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
					<InlineCode variant="plain" className="text-2xs">
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
								className="text-muted-foreground text-2xs leading-4"
							>
								{entity.name}
							</InlineCode>
						))}
						{check.affected_count > check.affected.length && (
							<span className="text-muted-foreground/70 text-2xs">
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
			{isFinding && fixTarget !== null && (
				<FixLink
					target={fixTarget}
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
		<Panel>
			<div className="flex items-center justify-between gap-3 px-4 pt-3 pb-2">
				<h3 className="flex items-center gap-3 text-sm font-medium">
					{meta.label}
					<span className="text-muted-foreground font-mono text-2xs font-normal">
						{findings > 0 ? countLabel(findings, "finding") : "clear"}
					</span>
				</h3>
				{meta.open !== null && (
					<FixLink
						target={meta.open.target}
						label={meta.open.label}
						className={buttonVariants({ variant: "ghost", size: "sm" })}
					/>
				)}
			</div>
			{checks.map((check) => (
				<CheckRow key={check.id} check={check} />
			))}
		</Panel>
	)
}

function Report({ audit, refreshing }: { audit: V2SetupAudit; refreshing: boolean }) {
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
			<Panel>
				<Empty className="py-10">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<ServerIcon size={16} />
						</EmptyMedia>
						<EmptyTitle>No telemetry yet</EmptyTitle>
						<EmptyDescription>
							The audit runs once your first service reports in. Connect one from the Ingestion
							tab and come back.
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
			</Panel>
		)
	}

	return (
		<div className="flex flex-col gap-4">
			<Panel className="flex-row flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
				<SummaryPill count={summary.critical} label="critical" className={TONE_TEXT.crit} />
				<SummaryPill count={summary.warn} label="warning" className={TONE_TEXT.warn} />
				<SummaryPill count={summary.info} label="info" className={TONE_TEXT.info} />
				<span className="text-muted-foreground/40">·</span>
				<SummaryPill count={summary.pass} label="passing" className="text-severity-info" />
				{summary.skip > 0 && (
					<SummaryPill count={summary.skip} label="skipped" className="text-muted-foreground" />
				)}
				<div className="grow" />
				<RelativeTime value={audit.generated_at} className="text-muted-foreground/70 text-2xs" />
				<RefreshButton
					variant="ghost"
					label="Re-run"
					pending={refreshing}
					onRefresh={() => refresh()}
				/>
			</Panel>

			{!audit.telemetry_checks_available && (
				<Alert variant="warn" className="px-4 text-xs leading-relaxed">
					<CircleWarningIcon />
					<AlertTitle>Telemetry checks skipped.</AlertTitle>
					<AlertDescription>
						Your warehouse could not be queried, so only configuration was audited. The findings
						below still apply.
					</AlertDescription>
				</Alert>
			)}

			{findingCount === 0 && !showPassing ? (
				<Panel className="items-center gap-2 px-4 py-10 text-center">
					<CircleCheckIcon size={20} className="text-severity-info" />
					<p className="text-sm font-medium">Everything checks out</p>
					<p className="text-muted-foreground text-xs">
						All {countLabel(summary.pass, "check")} passed. Alerts can deliver, and your telemetry
						follows the conventions Maple reads.
					</p>
				</Panel>
			) : (
				grouped.map((group) => (
					<CategoryCard key={group.category} category={group.category} checks={group.checks} />
				))
			)}

			<Button
				variant="link"
				size="xs"
				onClick={() => setShowPassing((value) => !value)}
				className="h-auto self-start p-0 text-muted-foreground hover:text-foreground"
			>
				{showPassing
					? "Hide passing checks"
					: `Show ${summary.pass + summary.skip} passing and skipped checks`}
			</Button>
		</div>
	)
}

export function SetupAuditSection() {
	const result = useAtomValue(setupAuditAtom)
	const refresh = useAtomRefresh(setupAuditAtom)

	return (
		<SettingsSection title="Setup audit" framed={false}>
			{Result.isFailure(result) ? (
				<ErrorState error={result.cause} title="Could not run the audit" onRetry={refresh} />
			) : !Result.isSuccess(result) ? (
				<div className="flex flex-col gap-4">
					<Skeleton className="h-12 w-full rounded-md" />
					<Skeleton className="h-48 w-full rounded-md" />
				</div>
			) : (
				<Report audit={result.value} refreshing={result.waiting} />
			)}
		</SettingsSection>
	)
}

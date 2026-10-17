import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { countLabel } from "@maple/ui/lib/format"
import { Panel } from "@maple/ui/components/ui/panel"
import { RefreshButton } from "@maple/ui/components/ui/refresh-button"
import { Link } from "@tanstack/react-router"
import type { V2SetupAudit, V2SetupAuditCheck } from "@maple/domain/http/v2"

import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { Alert, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Badge } from "@maple/ui/components/ui/badge"
import { buttonVariants } from "@maple/ui/components/ui/button"
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@maple/ui/components/ui/collapsible"
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"
import { TONE_FILL, TONE_TEXT } from "@maple/ui/lib/tone"
import {
	ArrowRightIcon,
	ChevronRightIcon,
	CircleCheckIcon,
	CircleInfoIcon,
	CircleWarningIcon,
	ExternalLinkIcon,
	ServerIcon,
	type IconComponent,
} from "@/components/icons"
import { setupAuditAtom } from "@/lib/services/atoms/audit-atoms"
import { DocsLink, EmptyActions } from "@/components/common/docs-link"
import { RelativeTime } from "@/components/common/relative-time"
import { ErrorState } from "@/components/common/error-state"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"

import {
	type HealthSegment,
	healthSegments,
	orderFindings,
	resolvedChecks,
	type SetupHealthAction,
	setupHealthAction,
} from "./setup-health"

type Severity = V2SetupAuditCheck["severity"]
type Category = V2SetupAuditCheck["category"]

// Info is the quiet blue; green stays reserved for passing.
const SEVERITY = {
	critical: { label: "Critical", icon: CircleWarningIcon, text: TONE_TEXT.crit },
	warn: { label: "Warning", icon: CircleWarningIcon, text: TONE_TEXT.warn },
	info: { label: "Info", icon: CircleInfoIcon, text: TONE_TEXT.done },
} satisfies Record<Severity, { label: string; icon: IconComponent; text: string }>

const SEGMENT = {
	critical: { fill: TONE_FILL.crit, legend: (n: number) => `${n} critical` },
	warn: { fill: TONE_FILL.warn, legend: (n: number) => countLabel(n, "warning") },
	info: { fill: TONE_FILL.done, legend: (n: number) => `${n} info` },
	pass: { fill: TONE_FILL.ok, legend: (n: number) => `${n} passing` },
	skip: { fill: TONE_FILL.neutral, legend: (n: number) => `${n} skipped` },
} satisfies Record<HealthSegment, { fill: string; legend: (count: number) => string }>

const CATEGORY_LABEL = {
	alerting: "Alerting",
	notifications: "Notifications",
	ingestion: "Ingestion",
	attributes: "Attributes",
	traces: "Traces",
	integrations: "Integrations",
	data_platform: "Data platform",
} satisfies Record<Category, string>

const actionClassName = cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0 gap-1.5")

function ActionButton({ action }: { action: SetupHealthAction }) {
	if (action.kind === "docs") {
		return (
			<a href={action.href} target="_blank" rel="noopener noreferrer" className={actionClassName}>
				{action.label}
				<ExternalLinkIcon size={14} />
			</a>
		)
	}
	return (
		<Link {...action.link} className={actionClassName}>
			{action.label}
			<ArrowRightIcon size={14} />
		</Link>
	)
}

const chipClassName = "text-2xs leading-4"
const linkedChipClassName = cn(
	chipClassName,
	"text-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground",
)

function AffectedChip({ entity }: { entity: V2SetupAuditCheck["affected"][number] }) {
	const title = entity.note ?? undefined
	if (entity.kind === "service") {
		return (
			<Link to="/services/$serviceName" params={{ serviceName: entity.name }} title={title}>
				<InlineCode className={linkedChipClassName}>{entity.name}</InlineCode>
			</Link>
		)
	}
	return (
		<InlineCode title={title} className={cn(chipClassName, "text-muted-foreground")}>
			{entity.name}
		</InlineCode>
	)
}

function FindingRow({ check }: { check: V2SetupAuditCheck }) {
	const severity = SEVERITY[check.severity]
	const action = setupHealthAction(check)
	const Icon = severity.icon

	return (
		<li className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start">
			<div className="flex min-w-0 flex-1 items-start gap-3">
				<Icon
					size={16}
					aria-label={severity.label}
					className={cn("mt-0.5 shrink-0", severity.text)}
				/>
				<div className="flex min-w-0 flex-col gap-1.5">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
						<span className="text-sm font-medium">{check.title}</span>
						<span className="text-muted-foreground/70 text-2xs">
							{CATEGORY_LABEL[check.category]}
						</span>
					</div>
					{check.detail !== null && (
						<p className="text-muted-foreground text-xs leading-relaxed">{check.detail}</p>
					)}
					<p className="text-muted-foreground/80 text-xs leading-relaxed">{check.fix_hint}</p>
					{check.affected.length > 0 && (
						<div className="flex flex-wrap items-center gap-1.5 pt-0.5">
							{check.affected.map((entity, index) => (
								// Names repeat (two rules can share one), so key by id, else position.
								<AffectedChip
									key={
										entity.id === null
											? `index:${index}`
											: `id:${entity.kind}:${entity.id}`
									}
									entity={entity}
								/>
							))}
							{check.affected_count > check.affected.length && (
								<span className="text-muted-foreground/70 text-2xs">
									+{check.affected_count - check.affected.length} more
								</span>
							)}
						</div>
					)}
				</div>
			</div>
			{action !== null && (
				<div className="pl-7 sm:pl-0">
					<ActionButton action={action} />
				</div>
			)}
		</li>
	)
}

function SummaryPanel({ audit, refreshing }: { audit: V2SetupAudit; refreshing: boolean }) {
	const refresh = useAtomRefresh(setupAuditAtom)
	const { summary } = audit
	const segments = healthSegments(summary)

	return (
		<Panel className="gap-3 p-4">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<p className="text-title font-medium">
					{summary.pass} of {countLabel(audit.checks.length, "check")} passing
				</p>
				<div className="grow" />
				<span className="text-muted-foreground/70 text-2xs">
					Last run <RelativeTime value={audit.generated_at} />
				</span>
				<RefreshButton
					variant="ghost"
					label="Re-run"
					pending={refreshing}
					onRefresh={() => refresh()}
				/>
			</div>
			<div className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
				{segments.map(({ segment, count }) => (
					<div
						key={segment}
						className={cn("h-full", SEGMENT[segment].fill)}
						style={{ flexGrow: count }}
					/>
				))}
			</div>
			<ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
				{segments.map(({ segment, count }) => (
					<li key={segment} className="flex items-center gap-1.5 text-2xs">
						<span className={cn("size-2 rounded-full", SEGMENT[segment].fill)} />
						{SEGMENT[segment].legend(count)}
					</li>
				))}
			</ul>
		</Panel>
	)
}

function PassingDisclosure({ checks }: { checks: ReadonlyArray<V2SetupAuditCheck> }) {
	const { checks: passing, label } = resolvedChecks(checks)
	if (passing.length === 0) return null
	return (
		<Collapsible>
			<Panel className="overflow-hidden">
				<CollapsibleTrigger className="group hover:bg-muted/20 flex w-full items-center gap-3 px-4 py-3 text-left transition-colors">
					<ChevronRightIcon
						size={14}
						className="text-muted-foreground shrink-0 transition-transform group-data-panel-open:rotate-90"
					/>
					<CircleCheckIcon size={16} className={cn("shrink-0", TONE_TEXT.info)} />
					<span className="text-sm font-medium">{label}</span>
					<span className="text-muted-foreground min-w-0 flex-1 text-xs">
						Checks are skipped only when telemetry could not be read
					</span>
				</CollapsibleTrigger>
				<CollapsiblePanel>
					<ul className="divide-border divide-y border-t">
						{passing.map((check) => (
							<li key={check.id} className="flex items-center gap-3 px-4 py-2.5">
								{check.status === "pass" ? (
									<CircleCheckIcon size={14} className={cn("shrink-0", TONE_TEXT.info)} />
								) : (
									<CircleInfoIcon size={14} className="text-muted-foreground/60 shrink-0" />
								)}
								<span className="min-w-0 flex-1 text-xs">{check.title}</span>
								{check.status === "skip" && (
									<Badge variant="secondary" size="xs">
										Skipped
									</Badge>
								)}
								<span className="text-muted-foreground/70 text-2xs">
									{CATEGORY_LABEL[check.category]}
								</span>
							</li>
						))}
					</ul>
				</CollapsiblePanel>
			</Panel>
		</Collapsible>
	)
}

function NoTelemetry() {
	return (
		<Panel>
			<Empty className="py-10">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<ServerIcon size={16} />
					</EmptyMedia>
					<EmptyTitle>No telemetry yet</EmptyTitle>
					<EmptyDescription>
						Setup health runs once your first service reports in. Connect one from the Ingestion
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

function Report({ audit, refreshing }: { audit: V2SetupAudit; refreshing: boolean }) {
	return (
		<>
			<SummaryPanel audit={audit} refreshing={refreshing} />
			{!audit.telemetry_checks_available && (
				<Alert variant="warn" className="px-4 text-xs leading-relaxed">
					<CircleWarningIcon />
					<AlertTitle>Telemetry checks skipped.</AlertTitle>
					<AlertDescription>
						Your warehouse could not be queried, so only configuration was checked. The findings
						below still apply.
					</AlertDescription>
				</Alert>
			)}
		</>
	)
}

function Findings({ audit }: { audit: V2SetupAudit }) {
	const findings = orderFindings(audit.checks)
	return (
		<SettingsSection
			title="Needs attention"
			description="Most severe first. Each fix opens the exact place to change."
			padded={false}
		>
			{findings.length === 0 ? (
				<div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
					<CircleCheckIcon size={20} className={TONE_TEXT.info} />
					<p className="text-sm font-medium">Everything checks out</p>
					<p className="text-muted-foreground text-xs">
						Alerts can deliver, and your telemetry follows the conventions Maple reads.
					</p>
				</div>
			) : (
				<ul className="divide-border divide-y">
					{findings.map((check) => (
						<FindingRow key={check.id} check={check} />
					))}
				</ul>
			)}
		</SettingsSection>
	)
}

export function SetupAuditSection() {
	const result = useAtomValue(setupAuditAtom)
	const refresh = useAtomRefresh(setupAuditAtom)
	const audit = Result.isSuccess(result) ? result.value : null

	return (
		<SettingsSections>
			<SettingsSection
				title="Setup health"
				description="Checks your instrumentation and workspace setup against what Maple needs."
				framed={false}
			>
				{Result.isFailure(result) ? (
					<ErrorState error={result.cause} title="Could not check setup health" onRetry={refresh} />
				) : audit === null ? (
					<div className="flex flex-col gap-4">
						<Skeleton className="h-24 w-full rounded-md" />
						<Skeleton className="h-48 w-full rounded-md" />
					</div>
				) : audit.data_status === "no_data" ? (
					<NoTelemetry />
				) : (
					<Report audit={audit} refreshing={Result.isSuccess(result) && result.waiting} />
				)}
			</SettingsSection>
			{audit !== null && audit.data_status === "ok" && (
				<>
					<Findings audit={audit} />
					<PassingDisclosure checks={audit.checks} />
				</>
			)}
		</SettingsSections>
	)
}

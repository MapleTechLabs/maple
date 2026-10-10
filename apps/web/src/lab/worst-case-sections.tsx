import { useMemo, useState, type ReactNode } from "react"

import { AttributesTable } from "@maple/ui/components/attributes/attributes-table"
import { SeverityBadge } from "@maple/ui/components/logs/severity-badge"

import { Tool } from "@/components/ai-elements/tool"
import { IdentityAvatar } from "@/components/errors/actor-chip"
import { ErrorSignalRow } from "@/components/errors/error-signal-row"
import { IssueOccurrencesTable } from "@/components/errors/issue-occurrences-table"
import { useIssueMutations } from "@/components/errors/use-issue-mutations"
import { RulesOverviewTable } from "@/components/alerts/overview/rules-overview-table"
import { VerdictCard } from "@/components/investigations/verdict-card"
import { LogsTableView } from "@/components/logs/logs-table"
import { ReleaseComparison } from "@/components/releases/release-detail-panels"
import { buildErrorsLabFixture } from "@/lab/errors-fixture"
import { actorIdentities, errorSignal, rulesFixture, sampleTraces, verdict } from "@/lab/worst-case-docs"
import { attributes, logs, releaseImpact, type WorstCaseMode } from "@/lab/worst-case-fixture"

export function WcSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
	return (
		<section id={id} className="space-y-3 border-b pb-10">
			<h2 className="font-mono text-xs text-muted-foreground">
				#{id} <span className="text-foreground">{title}</span>
			</h2>
			{children}
		</section>
	)
}

/** A sidebar-ish container, for components that live in a narrow column. */
export function Narrow({ children, width = 360 }: { children: ReactNode; width?: number }) {
	return (
		<div className="rounded-md border p-2" style={{ width }}>
			{children}
		</div>
	)
}

export function VerdictSection({ mode }: { mode: WorstCaseMode }) {
	const investigation = useMemo(() => verdict(mode), [mode])
	return (
		<WcSection id="wc-verdict" title="Investigation VerdictCard">
			<div className="max-w-3xl">
				<VerdictCard investigation={investigation} />
			</div>
		</WcSection>
	)
}

export function ErrorsSection({ mode }: { mode: WorstCaseMode }) {
	const [nowMs] = useState(() => Date.now())
	const fixture = useMemo(() => buildErrorsLabFixture(nowMs), [nowMs])
	const signal = errorSignal(mode, fixture.signals[0]!)
	const mutations = useIssueMutations()
	return (
		<WcSection id="wc-errors" title="Errors: occurrences, signal row, avatars">
			<div className="max-w-4xl rounded-md border">
				<IssueOccurrencesTable traces={sampleTraces(mode)} />
			</div>
			<div className="@container/page max-w-5xl rounded-md border">
				<div role="list">
					<div role="listitem">
						<ErrorSignalRow
							signal={signal}
							sparkWindow={fixture.sparkWindow}
							mutations={mutations}
							selected={false}
							selecting={false}
							onToggleSelect={() => undefined}
							focused={false}
							onFocus={() => undefined}
							picker={null}
							onPickerChange={() => undefined}
						/>
					</div>
				</div>
			</div>
			<Narrow>
				<div className="space-y-2">
					{actorIdentities(mode).map((identity) => (
						<div key={identity.seed} className="flex items-center gap-2 text-xs">
							<IdentityAvatar identity={identity} />
							<IdentityAvatar identity={identity} size="md" />
							<span className="truncate">{identity.name}</span>
						</div>
					))}
				</div>
			</Narrow>
		</WcSection>
	)
}

export function TablesSection({ mode }: { mode: WorstCaseMode }) {
	const { rules, derived, states } = useMemo(() => rulesFixture(mode), [mode])
	const [nowMs] = useState(() => Date.now())
	return (
		<WcSection id="wc-tables" title="Tables: alert rules, release comparison">
			<div className="rounded-md border">
				<RulesOverviewTable
					rules={rules}
					groups={null}
					grouped={false}
					destinationsById={new Map()}
					derivedByRuleId={derived}
					statesByRule={states}
					incidentsByRuleId={new Map()}
					timelineRange={{ min: nowMs - 24 * 60 * 60 * 1000, max: nowMs }}
					isAdmin
					onToggle={() => undefined}
				/>
			</div>
			<Narrow width={420}>
				<ReleaseComparison impact={releaseImpact(mode)} />
			</Narrow>
		</WcSection>
	)
}

export function MiscSection({ mode }: { mode: WorstCaseMode }) {
	const severities = mode === "demo" ? ["INFO", "ERROR"] : ["", "TRACE2", "EMERGENCY_UNRECOVERABLE"]
	const toolName = mode === "demo" ? "query_traces" : "mcp__maple__query_traces_by_service_and_time_window"
	return (
		<WcSection id="wc-misc" title="Misc: severity, log body, attributes, tool header">
			<div className="flex items-center gap-2">
				{severities.map((severity) => (
					<SeverityBadge key={severity || "empty"} severity={severity} />
				))}
			</div>
			<div className="flex h-[260px] flex-col rounded-md border">
				<LogsTableView
					allData={[...logs(mode)]}
					isFetchingNextPage={false}
					hasNextPage={false}
					isCapped={false}
					fetchNextPage={() => undefined}
					waiting={false}
					wrap={false}
					density="compact"
					pinnedColumns={["db.user"]}
					embedded
					onLogClick={() => undefined}
				/>
			</div>
			<Narrow>
				<AttributesTable attributes={attributes(mode)} title="Span attributes" />
			</Narrow>
			<Narrow>
				<Tool
					toolName={toolName}
					toolCallId="wc-tool-1"
					state="output-available"
					input={{
						service:
							mode === "demo"
								? "api"
								: "checkout-service-payments-reconciliation-worker-eu-west-1",
					}}
					output="ok"
				/>
				<Tool toolName={toolName} toolCallId="wc-tool-2" state="input-available" input={{}} live />
			</Narrow>
		</WcSection>
	)
}

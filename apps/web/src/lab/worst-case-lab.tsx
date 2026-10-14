import { useState } from "react"

import { QueryBuilderLegend } from "@maple/ui/components/charts/_shared/query-builder-legend"
import { TraceViewTabs, type TraceView } from "@maple/ui/components/traces/trace-view-tabs"
import { ListFooter } from "@maple/ui/components/ui/list-footer"
import { cn } from "@maple/ui/lib/utils"

import { DataTable as ToolDataTable } from "@/components/ai-elements/renderers/components/data-table"
import { HeroChip } from "@/components/common/page-hero"
import { HostTable } from "@/components/infra/host-table"
import { FINDINGS_LIST_CLASS, FindingRow } from "@/components/infra/overview/infra-overview"
import { PodTable } from "@/components/infra/pod-table"
import {
	containerImage,
	finding,
	formatterCases,
	hosts,
	legend,
	pods,
	toolTable,
	type WorstCaseMode,
} from "@/lab/worst-case-fixture"
import { worstCaseTrace } from "@/lab/worst-case-trace"
import {
	ErrorsSection,
	MiscSection,
	Narrow,
	TablesSection,
	VerdictSection,
	WcSection,
} from "@/lab/worst-case-sections"

function ModeToggle({ mode, onChange }: { mode: WorstCaseMode; onChange: (mode: WorstCaseMode) => void }) {
	const options: ReadonlyArray<{ value: WorstCaseMode; label: string }> = [
		{ value: "demo", label: "Demo data" },
		{ value: "worst", label: "Worst case" },
	]
	return (
		<div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 gap-0.5 rounded-full bg-neutral-200 p-1">
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					aria-pressed={mode === option.value}
					onClick={() => onChange(option.value)}
					className={cn(
						"rounded-full px-3 py-1 text-xs",
						mode === option.value ? "bg-white text-neutral-900 " : "text-neutral-600",
					)}
				>
					{option.label}
				</button>
			))}
		</div>
	)
}

function FormattersSection({ mode }: { mode: WorstCaseMode }) {
	return (
		<WcSection id="wc-formatters" title="Formatters: input to output">
			<table className="w-full max-w-3xl border-collapse font-mono text-xs">
				<thead>
					<tr className="text-left text-muted-foreground">
						<th className="border-b py-1 pr-4 font-normal">function</th>
						<th className="border-b py-1 pr-4 font-normal">input</th>
						<th className="border-b py-1 font-normal">output</th>
					</tr>
				</thead>
				<tbody>
					{formatterCases(mode).map((row, i) => (
						<tr key={i}>
							<td className="border-b py-1 pr-4">{row.fn}</td>
							<td className="border-b py-1 pr-4">{row.input}</td>
							<td className="border-b py-1">{row.output}</td>
						</tr>
					))}
				</tbody>
			</table>
			<div className="max-w-3xl space-y-1 rounded-md border">
				{mode === "demo" ? (
					<ListFooter shown={50} total={1284} noun="logs" hasMore onLoadMore={() => undefined} />
				) : (
					<>
						<ListFooter shown={1} total={1} noun="logs" />
						<ListFooter shown={0} total={0} noun="queries" />
						<ListFooter shown={12_849_302} total={Number.POSITIVE_INFINITY} noun="spans" capped />
						<ListFooter shown={200} noun="traces" hasMore failed onLoadMore={() => undefined} />
					</>
				)}
			</div>
		</WcSection>
	)
}

function InfraSection({ mode }: { mode: WorstCaseMode }) {
	return (
		<WcSection id="wc-infra" title="Infra: pods, hosts, findings, image chip">
			<PodTable pods={pods(mode)} timeSearch={{}} />
			<HostTable hosts={hosts(mode)} />
			<div className={FINDINGS_LIST_CLASS}>
				<FindingRow finding={finding(mode)} timeSearch={{}} />
			</div>
			<Narrow>
				<div className="flex flex-wrap gap-1.5">
					<HeroChip>{containerImage(mode)}</HeroChip>
					<HeroChip>linux/amd64</HeroChip>
				</div>
			</Narrow>
		</WcSection>
	)
}

function TraceBox({ mode, initialView }: { mode: WorstCaseMode; initialView: TraceView }) {
	const { detail, deepestSpanId } = worstCaseTrace(mode)
	const [view, setView] = useState<TraceView>(initialView)
	const [selected, setSelected] = useState<string | undefined>(deepestSpanId)
	return (
		<div className="h-[640px] rounded-md border p-2">
			<TraceViewTabs
				rootSpans={detail.rootSpans}
				spans={detail.spans}
				totalDurationMs={detail.totalDurationMs}
				traceStartTime={detail.traceStartTime}
				services={detail.services}
				selectedSpanId={selected}
				onSelectSpan={(span) => setSelected(span?.spanId)}
				view={view}
				onViewChange={setView}
			/>
		</div>
	)
}

function TraceSection({ mode }: { mode: WorstCaseMode }) {
	// Selecting the deepest span expands its whole ancestor chain: the "expand all" of a chain.
	return (
		<WcSection id="wc-trace" title="Trace: 60-deep chain, deepest span selected">
			<TraceBox key={`w-${mode}`} mode={mode} initialView="waterfall" />
			<TraceBox key={`t-${mode}`} mode={mode} initialView="timeline" />
		</WcSection>
	)
}

function LegendSection({ mode }: { mode: WorstCaseMode }) {
	const { series, stats } = legend(mode)
	const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
	const toggle = (key: string) =>
		setHidden((prev) => {
			const next = new Set(prev)
			if (next.has(key)) next.delete(key)
			else next.add(key)
			return next
		})
	return (
		<WcSection id="wc-legend" title="QueryBuilderLegend: stats and compact">
			<div className="max-w-2xl rounded-md border p-2">
				<QueryBuilderLegend
					series={series}
					stats={stats}
					hidden={hidden}
					onToggle={toggle}
					unit="ms"
				/>
			</div>
			<div className="max-w-2xl rounded-md border p-2">
				<QueryBuilderLegend
					series={series}
					stats={stats}
					hidden={hidden}
					onToggle={toggle}
					variant="compact"
				/>
			</div>
			<Narrow>
				<QueryBuilderLegend
					series={series}
					stats={stats}
					hidden={hidden}
					onToggle={toggle}
					unit="ms"
				/>
			</Narrow>
		</WcSection>
	)
}

function ToolTableSection({ mode }: { mode: WorstCaseMode }) {
	return (
		<WcSection id="wc-tool-table" title="AI renderer DataTable">
			<Narrow width={480}>
				<ToolDataTable props={toolTable(mode)} />
			</Narrow>
		</WcSection>
	)
}

/** Existing components over worst-case fixtures, with a demo twin, for before and after screenshots. */
export function WorstCaseLab({
	mode,
	onModeChange,
}: {
	mode: WorstCaseMode
	onModeChange: (mode: WorstCaseMode) => void
}) {
	return (
		<div className="mx-auto max-w-6xl space-y-10 p-8 pb-24" data-wc-mode={mode}>
			<FormattersSection mode={mode} />
			<InfraSection mode={mode} />
			<TraceSection mode={mode} />
			<LegendSection mode={mode} />
			<ToolTableSection mode={mode} />
			<VerdictSection mode={mode} />
			<ErrorsSection mode={mode} />
			<TablesSection mode={mode} />
			<MiscSection mode={mode} />
			<ModeToggle mode={mode} onChange={onModeChange} />
		</div>
	)
}

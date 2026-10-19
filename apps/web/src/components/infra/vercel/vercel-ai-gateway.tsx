// AI Gateway usage from the trace drain's `ai-gateway` root spans: the list page's AI Gateway view
// (with the by-project table) and the project page's section (without it).

import { useMemo, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import type { VercelAiGatewayBucket, VercelAiGatewayResponse } from "@maple/domain/http"
import { formatCost } from "@maple/agent-sessions"
import { QueryBuilderBarChart } from "@maple/ui/components/charts"
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@maple/ui/components/ui/empty"
import { ERROR_RATE_TEXT, errorRateLevel } from "@maple/ui/lib/error-rate"
import { EMPTY_VALUE, formatErrorRate, formatLatency, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { ChartCard } from "@/components/common/chart-card"
import { ColumnHead, DataTable, ROW_LINK_CLASS } from "@/components/common/data-table"
import { DocsLink, EmptyActions } from "@/components/common/docs-link"
import { SectionHeading } from "@/components/common/section-heading"
import { StatRail, StatRailItem } from "@/components/common/stat-rail"
import { SquareSparkleIcon } from "@/components/icons"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"

import { aiGatewayProjectLabel } from "./list-model"

const ROW_CLASS = "flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0"
const NUM = "w-[96px] text-right font-mono text-xs tabular-nums text-foreground/80"

const errorRate = (errors: number, requests: number) => (requests > 0 ? errors / requests : 0)

/** Nothing went through AI Gateway in the window: what makes it show up. */
export function VercelAiGatewayEmpty() {
	return (
		<Empty className="rounded-md border border-dashed py-14">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<SquareSparkleIcon size={16} />
				</EmptyMedia>
				<EmptyTitle>Requests through AI Gateway appear here</EmptyTitle>
				<EmptyDescription>
					Call a model through Vercel AI Gateway from a forwarded project. The traces drain carries
					each request's model, tokens and cost.
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<EmptyActions>
					<DocsLink page="vercel">How AI Gateway traces reach Maple</DocsLink>
				</EmptyActions>
			</EmptyContent>
		</Empty>
	)
}

function Charts({ timeseries }: { timeseries: ReadonlyArray<VercelAiGatewayBucket> }) {
	const spend = useMemo(
		() => timeseries.map((row) => ({ bucket: row.bucket, Spend: row.costUsd })),
		[timeseries],
	)
	const requests = useMemo(
		() =>
			timeseries.map((row) => ({
				bucket: row.bucket,
				Succeeded: row.requests - row.errors,
				Failed: row.errors,
			})),
		[timeseries],
	)
	return (
		<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
			<ChartCard title="Spend" description="AI Gateway's cost per request, summed per bucket">
				<div className="h-[200px] w-full px-1 pb-2">
					<QueryBuilderBarChart data={spend} unit="usd" legend="hidden" className="h-full w-full" />
				</div>
			</ChartCard>
			<ChartCard title="Requests" description="Failed: the gateway returned an error">
				<div className="h-[200px] w-full px-1 pb-2">
					<QueryBuilderBarChart data={requests} stacked legend="hidden" className="h-full w-full" />
				</div>
			</ChartCard>
		</div>
	)
}

function UsageCells({
	requests,
	costUsd,
	inputTokens,
	outputTokens,
	errors,
}: {
	requests: number
	costUsd: number
	inputTokens: number
	outputTokens: number
	errors: number
}) {
	const rate = errorRate(errors, requests)
	return (
		<>
			<div className={NUM}>{formatNumber(requests)}</div>
			<div className={cn(NUM, "font-medium text-foreground")}>{formatCost(costUsd)}</div>
			<div className={cn(NUM, "hidden md:block")}>{formatNumber(inputTokens)}</div>
			<div className={cn(NUM, "hidden md:block")}>{formatNumber(outputTokens)}</div>
			<div className={cn(NUM, ERROR_RATE_TEXT[errorRateLevel(rate)])}>
				{errors === 0 ? "0" : `${formatNumber(errors)} · ${formatErrorRate(rate)}`}
			</div>
		</>
	)
}

function UsageHeads() {
	return (
		<>
			<ColumnHead label="Requests" width="w-[96px]" align="right" />
			<ColumnHead label="Spend" width="w-[96px]" align="right" />
			<ColumnHead label="Input tokens" width="w-[96px]" align="right" hidden="hidden md:flex" />
			<ColumnHead label="Output tokens" width="w-[96px]" align="right" hidden="hidden md:flex" />
			<ColumnHead label="Errors" width="w-[96px]" align="right" />
		</>
	)
}

function ModelsTable({ models }: { models: VercelAiGatewayResponse["models"] }) {
	return (
		<section className="space-y-3">
			<SectionHeading title="By model" hint="most spend first" count={models.length} />
			<DataTable.Root ariaLabel="AI Gateway models">
				<DataTable.Head>
					<ColumnHead label="Model" width="w-0 flex-1 min-w-[220px]" />
					<UsageHeads />
					<ColumnHead label="p95" width="w-[80px]" align="right" />
				</DataTable.Head>
				{[...models]
					.sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests)
					.map((model) => (
						<div key={`${model.provider}:${model.model}`} className={ROW_CLASS}>
							<div className="flex w-0 min-w-[220px] flex-1 items-baseline gap-2">
								<span
									className="truncate font-mono text-xs font-medium text-foreground"
									title={model.model}
								>
									{model.model}
								</span>
								{model.provider ? (
									<span className="shrink-0 font-mono text-3xs text-muted-foreground">
										{model.provider}
									</span>
								) : null}
							</div>
							<UsageCells {...model} />
							<div className="w-[80px] text-right font-mono text-xs tabular-nums text-foreground/80">
								{model.p95DurationMs === null
									? EMPTY_VALUE
									: formatLatency(model.p95DurationMs)}
							</div>
						</div>
					))}
			</DataTable.Root>
		</section>
	)
}

function ProjectsTable({
	projects,
	projectNames,
	timeSearch,
}: {
	projects: VercelAiGatewayResponse["projects"]
	projectNames: ReadonlyMap<string, string>
	timeSearch: TimeRangeSearch
}) {
	const name = (projectId: string, children: ReactNode) => (
		<div className="w-0 min-w-[220px] flex-1">
			<span
				className={cn(
					"block truncate font-mono text-xs font-medium",
					projectId === ""
						? "text-muted-foreground"
						: "text-foreground transition-colors group-hover:text-primary",
				)}
			>
				{children}
			</span>
		</div>
	)
	return (
		<section className="space-y-3">
			<SectionHeading title="By project" hint="most spend first" count={projects.length} />
			<DataTable.Root ariaLabel="AI Gateway projects">
				<DataTable.Head>
					<ColumnHead label="Project" width="w-0 flex-1 min-w-[220px]" />
					<UsageHeads />
				</DataTable.Head>
				{[...projects]
					.sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests)
					.map((project) => {
						const label = aiGatewayProjectLabel(project.projectId, projectNames)
						return project.projectId === "" ? (
							<div key="" className={ROW_CLASS}>
								{name("", label)}
								<UsageCells {...project} />
							</div>
						) : (
							<Link
								key={project.projectId}
								to="/infra/vercel/$projectId"
								params={{ projectId: project.projectId }}
								search={timeSearch}
								className={ROW_LINK_CLASS}
							>
								{name(project.projectId, label)}
								<UsageCells {...project} />
							</Link>
						)
					})}
			</DataTable.Root>
		</section>
	)
}

/** Summary, spend and request charts, then usage by model and, on the list page, by project. */
export function VercelAiGatewayPanel({
	data,
	timeseries,
	projectNames,
	timeSearch,
}: {
	data: VercelAiGatewayResponse
	/** `data.timeseries` with the window's empty buckets filled. */
	timeseries: ReadonlyArray<VercelAiGatewayBucket>
	projectNames: ReadonlyMap<string, string>
	timeSearch: TimeRangeSearch
}) {
	const { summary } = data
	const rate = errorRate(summary.errors, summary.requests)
	return (
		<div className="space-y-6">
			<StatRail columns={5}>
				<StatRailItem
					eyebrow="Spend"
					value={formatCost(summary.costUsd)}
					spark={timeseries.map((row) => row.costUsd)}
					subline={
						summary.requests > 0
							? `${formatCost(summary.costUsd / summary.requests)} per request`
							: undefined
					}
				/>
				<StatRailItem
					eyebrow="Requests"
					value={formatNumber(summary.requests)}
					spark={timeseries.map((row) => row.requests)}
					subline={`${data.models.length} ${data.models.length === 1 ? "model" : "models"}`}
				/>
				<StatRailItem
					eyebrow="Tokens"
					value={formatNumber(summary.inputTokens)}
					hint="in"
					spark={timeseries.map((row) => row.inputTokens + row.outputTokens)}
					subline={`${formatNumber(summary.outputTokens)} out`}
				/>
				<StatRailItem
					eyebrow="Error rate"
					value={formatErrorRate(rate)}
					tone={errorRateLevel(rate)}
					spark={timeseries.map((row) => row.errors)}
					subline={`${formatNumber(summary.errors)} failed`}
				/>
				<StatRailItem
					eyebrow="p95 latency"
					value={
						summary.p95DurationMs === null ? EMPTY_VALUE : formatLatency(summary.p95DurationMs)
					}
					compact
					subline={
						summary.p50DurationMs === null
							? undefined
							: `p50 ${formatLatency(summary.p50DurationMs)}`
					}
				/>
			</StatRail>
			<Charts timeseries={timeseries} />
			<ModelsTable models={data.models} />
			{data.projects.length > 0 ? (
				<ProjectsTable projects={data.projects} projectNames={projectNames} timeSearch={timeSearch} />
			) : null}
		</div>
	)
}

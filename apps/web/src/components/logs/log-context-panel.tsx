import { createContext, useCallback, useContext, useState, type ReactNode } from "react"
import { formatWarehouseDateTime, formatWarehouseDateTimeMs } from "@maple/query-engine"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { Skeleton, SkeletonList } from "@maple/ui/components/ui/skeleton"
import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
import { cn } from "@maple/ui/lib/utils"
import { getSeverityColor } from "@maple/ui/lib/severity"
import { ErrorState } from "@/components/common/error-state"
import type { ListLogsInput, Log } from "@/api/warehouse/logs"
import { listLogsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { LogTime } from "./log-time"

/** Logs shown on each side of the selected one. */
const CONTEXT_SIZE = 25
/** Each side's scan stops this far from the selected log, so a quiet service stays bounded. */
const CONTEXT_WINDOW_MS = 60 * 60 * 1000
/** Resource attributes that name one running instance, most specific first. */
const INSTANCE_KEYS = ["k8s.pod.name", "service.instance.id"] as const

const WAREHOUSE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/

type ContextScope = "service" | "instance"

interface InstanceAttribute {
	key: string
	value: string
}

function instanceAttribute(log: Log): InstanceAttribute | undefined {
	const key = INSTANCE_KEYS.find((k) => (log.resourceAttributes[k] ?? "") !== "")
	return key ? { key, value: log.resourceAttributes[key] ?? "" } : undefined
}

/** The query's record hash when the row has one; else nanosecond timestamp + span + body. */
function contextKey(log: Log): string {
	return log.recordIdentity ?? `${log.exactTimestamp}|${log.spanId ?? ""}|${log.body}`
}

function timestampMs(timestamp: string): number {
	return new Date(timestamp.includes("T") ? timestamp : `${timestamp.replace(" ", "T")}Z`).getTime()
}

/**
 * The selected log between its neighbours, oldest first. Ties at the selected
 * timestamp come back from both sides, so rows are deduped by identity.
 */
function mergeLogContext(selected: Log, beforeDesc: readonly Log[], afterAsc: readonly Log[]): Log[] {
	const selectedKey = contextKey(selected)
	const seen = new Set([selectedKey])
	const unique = (rows: readonly Log[]) =>
		rows.filter((row) => {
			const key = contextKey(row)
			if (seen.has(key)) return false
			seen.add(key)
			return true
		})
	const before = unique(beforeDesc).slice(0, CONTEXT_SIZE).toReversed()
	const after = unique(afterAsc).slice(0, CONTEXT_SIZE)
	return [...before, selected, ...after]
}

/**
 * Logs to read context from instead of the warehouse. The `/lab/logs` page sets
 * it to its fixture; everywhere else it is absent.
 */
const LogContextFixture = createContext<readonly Log[] | null>(null)

export function LogContextFixtureProvider({ logs, children }: { logs: readonly Log[]; children: ReactNode }) {
	return <LogContextFixture.Provider value={logs}>{children}</LogContextFixture.Provider>
}

interface LogContextPanelProps {
	log: Log
	onLogSelect: (log: Log) => void
	/** Classes for the scrolling list, which needs a bounded height to center the selected row. */
	listClassName?: string
}

/**
 * The logs just before and after one log from the same service, or the same
 * instance when the log names one. Works in the drawer and on `/logs/$logId`.
 */
export function LogContextPanel({ log, onLogSelect, listClassName }: LogContextPanelProps) {
	const fixture = useContext(LogContextFixture)
	const instance = instanceAttribute(log)
	const [preferredScope, setPreferredScope] = useState<ContextScope>("instance")
	const scope: ContextScope = instance ? preferredScope : "service"
	const scopedInstance = scope === "instance" ? instance : undefined

	return (
		<div className="flex h-full min-h-0 flex-col gap-1.5">
			<div className="flex shrink-0 items-center gap-2">
				<h4 className="text-xs font-medium text-muted-foreground">
					Surrounding logs
					<span className="ml-1 font-normal text-muted-foreground/60">
						{scopedInstance ? `${scopedInstance.key}=${scopedInstance.value}` : log.serviceName}
					</span>
				</h4>
				{instance && (
					<ToggleGroup
						variant="outline"
						size="xs"
						aria-label="Context scope"
						className="ml-auto"
						value={[scope]}
						onValueChange={(values) => {
							const next = values[0]
							if (next === "service" || next === "instance") setPreferredScope(next)
						}}
					>
						<ToggleGroupItem value="instance">Instance</ToggleGroupItem>
						<ToggleGroupItem value="service">Service</ToggleGroupItem>
					</ToggleGroup>
				)}
			</div>
			{fixture ? (
				<FixtureContext
					log={log}
					fixture={fixture}
					instance={scopedInstance}
					onLogSelect={onLogSelect}
					listClassName={listClassName}
				/>
			) : (
				<WarehouseContext
					log={log}
					instance={scopedInstance}
					onLogSelect={onLogSelect}
					listClassName={listClassName}
				/>
			)}
		</div>
	)
}

interface ContextSourceProps {
	log: Log
	instance: InstanceAttribute | undefined
	onLogSelect: (log: Log) => void
	listClassName?: string
}

function contextInputs(log: Log, instance: InstanceAttribute | undefined) {
	const ms = timestampMs(log.timestamp)
	if (Number.isNaN(ms)) return undefined
	// Both sides include this instant; rows read twice are deduped by `contextKey`.
	const at = WAREHOUSE_DATETIME.test(log.exactTimestamp)
		? log.exactTimestamp
		: formatWarehouseDateTimeMs(ms)
	const shared: ListLogsInput = {
		services: [log.serviceName],
		// One extra per side: the selected log itself comes back and is dropped.
		limit: CONTEXT_SIZE + 1,
		resourceAttributeFilters: instance
			? [{ key: instance.key, value: instance.value, mode: "equals" }]
			: undefined,
	}
	return {
		before: { ...shared, startTime: formatWarehouseDateTime(ms - CONTEXT_WINDOW_MS), endTime: at },
		after: {
			...shared,
			startTime: at,
			endTime: formatWarehouseDateTime(ms + CONTEXT_WINDOW_MS),
			order: "asc" as const,
		},
	}
}

function WarehouseContext({ log, instance, onLogSelect, listClassName }: ContextSourceProps) {
	const inputs = contextInputs(log, instance)
	if (!inputs) return <EmptyMessage>This log has no readable timestamp</EmptyMessage>
	return (
		<WarehouseContextQuery
			log={log}
			before={inputs.before}
			after={inputs.after}
			onLogSelect={onLogSelect}
			listClassName={listClassName}
		/>
	)
}

function WarehouseContextQuery({
	log,
	before,
	after,
	onLogSelect,
	listClassName,
}: {
	log: Log
	before: ListLogsInput
	after: ListLogsInput
	onLogSelect: (log: Log) => void
	listClassName?: string
}) {
	const beforeResult = useAtomValue(listLogsResultAtom({ data: before }))
	const afterResult = useAtomValue(listLogsResultAtom({ data: after }))

	return Result.builder(Result.all([beforeResult, afterResult]))
		.onInitial(() => <ContextSkeleton />)
		.onError((error) => (
			<ErrorState error={error} title="Failed to load surrounding logs" variant="inline" />
		))
		.onSuccess(([beforePage, afterPage]) => (
			<ContextList
				log={log}
				rows={mergeLogContext(log, beforePage.data, afterPage.data)}
				onLogSelect={onLogSelect}
				className={listClassName}
			/>
		))
		.render()
}

function FixtureContext({
	log,
	fixture,
	instance,
	onLogSelect,
	listClassName,
}: ContextSourceProps & { fixture: readonly Log[] }) {
	const ms = timestampMs(log.timestamp)
	const scoped = fixture.filter(
		(row) =>
			row.serviceName === log.serviceName &&
			(!instance || row.resourceAttributes[instance.key] === instance.value),
	)
	const byTime = scoped.toSorted((a, b) => timestampMs(a.timestamp) - timestampMs(b.timestamp))
	const before = byTime.filter((row) => timestampMs(row.timestamp) <= ms).toReversed()
	const after = byTime.filter((row) => timestampMs(row.timestamp) >= ms)
	return (
		<ContextList
			log={log}
			rows={mergeLogContext(log, before, after)}
			onLogSelect={onLogSelect}
			className={listClassName}
		/>
	)
}

function ContextSkeleton() {
	return (
		<SkeletonList
			rows={8}
			className="gap-0 overflow-hidden rounded-md border"
			renderRow={() => (
				<div className="flex items-center gap-2 border-b px-2 py-1.5 last:border-b-0">
					<Skeleton className="h-3 w-16 shrink-0" />
					<Skeleton className="h-3 w-8 shrink-0" />
					<Skeleton className="h-3 flex-1" />
				</div>
			)}
		/>
	)
}

function ContextList({
	log,
	rows,
	onLogSelect,
	className,
}: {
	log: Log
	rows: readonly Log[]
	onLogSelect: (log: Log) => void
	className?: string
}) {
	const { effectiveTimezone } = useTimezonePreference()
	const selectedKey = contextKey(log)
	// Center the selected row inside this list only; `scrollIntoView` would also scroll the page.
	const centerSelected = useCallback((node: HTMLLIElement | null) => {
		const list = node?.parentElement
		if (!node || !list) return
		list.scrollTop = node.offsetTop - (list.clientHeight - node.offsetHeight) / 2
	}, [])

	if (rows.length <= 1) return <EmptyMessage>No other logs around this one</EmptyMessage>

	return (
		<ul className={cn("relative min-h-0 flex-1 overflow-y-auto rounded-md border", className)}>
			{rows.map((row) => {
				const key = contextKey(row)
				const isCurrent = key === selectedKey
				const severity = row.severityText.toUpperCase()
				const cells = (
					<>
						<span className="w-[92px] shrink-0 tabular-nums text-foreground/75">
							<LogTime timestamp={row.timestamp} timeZone={effectiveTimezone} />
						</span>
						<span
							className="w-11 shrink-0 text-3xs font-semibold uppercase leading-4 tracking-wide tabular-nums"
							style={{ color: getSeverityColor(row.severityText) }}
						>
							{row.severityText}
						</span>
						<span
							className={cn(
								"min-w-0 flex-1 truncate",
								isCurrent
									? "text-foreground"
									: QUIET_SEVERITIES.has(severity)
										? "text-muted-foreground"
										: "text-foreground/85",
							)}
						>
							{row.body.split("\n", 1)[0]}
						</span>
					</>
				)
				return (
					<li
						key={key}
						ref={isCurrent ? centerSelected : undefined}
						aria-current={isCurrent || undefined}
						style={{ borderLeftColor: getSeverityColor(row.severityText) }}
						className="border-b border-l-2 border-b-border/70 font-mono text-xs last:border-b-0"
					>
						{isCurrent ? (
							<div className={cn(ROW_CLASS, "bg-primary/8")}>{cells}</div>
						) : (
							<button
								type="button"
								className={cn(
									ROW_CLASS,
									"cursor-pointer text-left hover:bg-muted/50 focus-visible:bg-muted/70 focus-visible:outline-none",
								)}
								onClick={() => onLogSelect(row)}
							>
								{cells}
							</button>
						)}
					</li>
				)
			})}
		</ul>
	)
}

const ROW_CLASS = "flex w-full items-center gap-2 px-2 py-1"
const QUIET_SEVERITIES = new Set(["DEBUG", "TRACE"])

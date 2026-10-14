import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"
import { errorRateClass } from "@maple/ui/lib/error-rate"
import { EMPTY_VALUE, formatErrorRate, formatLatency, formatNumber } from "@maple/ui/lib/format"

import { Link } from "@tanstack/react-router"

import { ColumnHead, DataTable, ROW_LINK_CLASS } from "@/components/common/data-table"
import { MetaLine } from "../primitives/meta-line"
import {
	CPU_HEAVY_P99_MS,
	SLOW_P99_MS,
	workerHealth,
	workerRowKey,
	type WorkerHealth,
	type WorkerListRow,
} from "./list-model"

const TABLE_MAX_HEIGHT = 560

const HEALTH_DOT = {
	erroring: "bg-severity-error",
	slow: "bg-severity-warn",
	ok: "bg-severity-info",
} satisfies Record<WorkerHealth, string>

function WorkerColumns({ showAccount }: { showAccount: boolean }) {
	return (
		<>
			<div className="w-2 shrink-0" />
			<ColumnHead label="Worker" width="w-0 flex-1 min-w-[220px]" />
			{showAccount ? <ColumnHead label="Account" width="w-[110px]" hidden="hidden lg:flex" /> : null}
			<ColumnHead label="Invocations" align="right" width="w-[90px]" />
			<ColumnHead label="Errors" align="right" width="w-[80px]" />
			<ColumnHead label="CPU p99" align="right" width="w-[80px]" hidden="hidden md:flex" />
			<ColumnHead label="Duration p99" align="right" width="w-[100px]" />
		</>
	)
}

export function CloudflareWorkerTableLoading() {
	return (
		<DataTable.Root ariaLabel="Workers">
			<DataTable.Head>
				<WorkerColumns showAccount={false} />
			</DataTable.Head>
			<DataTable.SkeletonRows count={4}>
				<Skeleton className="size-2 rounded-full" />
				<div className="w-0 min-w-[220px] flex-1 space-y-1.5">
					<Skeleton className="h-3.5 w-40" />
					<Skeleton className="h-2.5 w-28" />
				</div>
				<Skeleton className="h-3 w-[90px]" />
				<Skeleton className="h-3 w-[80px]" />
				<Skeleton className="hidden h-3 w-[80px] md:block" />
				<Skeleton className="h-3 w-[100px]" />
			</DataTable.SkeletonRows>
		</DataTable.Root>
	)
}

/** Rows arrive already ordered (problems first); the table doesn't re-sort them. */
export function CloudflareWorkerTable({
	rows,
	accounts,
	waiting,
	emptyMessage,
}: {
	rows: ReadonlyArray<WorkerListRow>
	/** Account name per account id; the column only renders when it is passed. */
	accounts?: ReadonlyMap<string, string>
	waiting?: boolean
	emptyMessage?: string
}) {
	const showAccount = accounts !== undefined
	return (
		<DataTable.Root ariaLabel="Cloudflare Workers" waiting={waiting} maxHeight={TABLE_MAX_HEIGHT}>
			<DataTable.Head>
				<WorkerColumns showAccount={showAccount} />
			</DataTable.Head>
			{rows.length === 0 && (
				<DataTable.Empty>
					{emptyMessage ?? "No Worker invocations in the selected window."}
				</DataTable.Empty>
			)}

			{rows.map((row) => {
				const health = workerHealth(row)
				const invocationsOnly = row.requests > 0
				return (
					<Link
						key={workerRowKey(row)}
						to="/infra/cloudflare/workers/$scriptName"
						params={{ scriptName: row.scriptName }}
						// A shared name is only one Worker once the account is pinned.
						search={{
							account:
								row.nameInOtherAccounts && row.accountId !== "" ? row.accountId : undefined,
						}}
						className={ROW_LINK_CLASS}
					>
						<span
							aria-hidden
							className={cn("size-2 shrink-0 rounded-full", HEALTH_DOT[health])}
						/>
						<div className="w-0 min-w-[220px] flex-1 space-y-0.5">
							<div
								className="truncate font-mono text-xs font-medium text-foreground transition-colors group-hover:text-primary"
								title={row.scriptName}
							>
								{row.scriptName}
							</div>
							<MetaLine items={metaItems(row)} />
						</div>
						{showAccount ? (
							<div className="hidden w-[110px] truncate font-mono text-2xs text-muted-foreground lg:block">
								{accounts.get(row.accountId) ?? EMPTY_VALUE}
							</div>
						) : null}
						<div className="w-[90px] text-right font-mono text-xs tabular-nums text-foreground/80">
							{invocationsOnly ? formatNumber(row.requests) : EMPTY_VALUE}
						</div>
						<div
							className={cn(
								"w-[80px] text-right font-mono text-xs tabular-nums",
								invocationsOnly ? errorRateClass(row.errorRate) : "text-muted-foreground",
							)}
						>
							{invocationsOnly ? formatErrorRate(row.errorRate) : EMPTY_VALUE}
						</div>
						<div
							className={cn(
								"hidden w-[80px] text-right font-mono text-xs tabular-nums md:block",
								row.cpuP99Ms >= CPU_HEAVY_P99_MS
									? "text-severity-warn"
									: "text-foreground/80",
							)}
						>
							{row.cpuP99Ms > 0 ? formatLatency(row.cpuP99Ms) : EMPTY_VALUE}
						</div>
						<div
							className={cn(
								"w-[100px] text-right font-mono text-xs tabular-nums",
								row.durationP99Ms >= SLOW_P99_MS
									? "text-severity-warn"
									: "text-foreground/80",
							)}
						>
							{row.durationP99Ms > 0 ? formatLatency(row.durationP99Ms) : EMPTY_VALUE}
						</div>
					</Link>
				)
			})}
		</DataTable.Root>
	)
}

function metaItems(row: WorkerListRow) {
	const durable =
		row.doRequests > 0 ? (
			<span className={row.doErrorRate >= 0.01 ? "text-severity-error" : undefined}>
				Durable Objects · {formatNumber(row.doRequests)} calls
				{row.doErrors > 0 ? ` · ${formatErrorRate(row.doErrorRate)} failed` : ""}
			</span>
		) : (
			""
		)
	return [
		row.nameInOtherAccounts ? "name shared with another account" : "",
		row.errors > 0 ? `${formatNumber(row.errors)} of ${formatNumber(row.requests)} failed` : "",
		durable,
		row.isPreview ? "preview deploy" : "",
	]
}

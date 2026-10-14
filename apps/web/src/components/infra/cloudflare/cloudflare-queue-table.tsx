import type { CloudflareQueueRow } from "@/api/warehouse/cloudflare-infra"
import { ColumnHead, DataTable, useTableSort } from "@/components/common/data-table"
import { formatBytes, formatNumber } from "@maple/ui/lib/format"

const ROW_CLASS =
	"flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0 hover:bg-muted/40"

const numCell = (value: string, hidden?: boolean) => (
	<div
		className={`w-[110px] text-right font-mono text-xs tabular-nums text-foreground/80 ${
			hidden ? "hidden md:block" : ""
		}`}
	>
		{value}
	</div>
)

type QueueSortKey = "queueName" | "backlogMessages" | "backlogMessagesMax" | "consumerConcurrency"

/** Queue backlog and consumer gauges, one row per queue. */
export function CloudflareQueueTable({
	queues,
	waiting,
}: {
	queues: ReadonlyArray<CloudflareQueueRow>
	waiting?: boolean
}) {
	const { sorted, sortKey, sortDir, handleSort } = useTableSort<CloudflareQueueRow, QueueSortKey>(queues, {
		initialKey: "backlogMessagesMax",
		stringKeys: ["queueName"],
	})
	return (
		<DataTable.Root ariaLabel="Cloudflare queues" waiting={waiting}>
			<DataTable.Head>
				<ColumnHead<QueueSortKey>
					label="Queue"
					sortKey="queueName"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					width="w-0 flex-1 min-w-[220px]"
				/>
				<ColumnHead<QueueSortKey>
					label="Backlog avg"
					sortKey="backlogMessages"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[110px]"
				/>
				<ColumnHead<QueueSortKey>
					label="Backlog peak"
					sortKey="backlogMessagesMax"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[110px]"
				/>
				<ColumnHead label="Backlog size" align="right" width="w-[110px]" hidden="hidden md:flex" />
				<ColumnHead<QueueSortKey>
					label="Consumers"
					sortKey="consumerConcurrency"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[110px]"
				/>
			</DataTable.Head>
			{sorted.length === 0 && (
				<DataTable.Empty>No queue activity in the selected window.</DataTable.Empty>
			)}

			{sorted.map((queue) => (
				<div key={queue.serviceName} className={ROW_CLASS}>
					<div className="w-0 min-w-[220px] flex-1 truncate font-mono text-xs font-medium text-foreground">
						{queue.queueName}
					</div>
					{numCell(formatNumber(Math.round(queue.backlogMessages)))}
					{numCell(formatNumber(Math.round(queue.backlogMessagesMax)))}
					{numCell(formatBytes(queue.backlogBytes), true)}
					{numCell(queue.consumerConcurrency.toFixed(1))}
				</div>
			))}
		</DataTable.Root>
	)
}

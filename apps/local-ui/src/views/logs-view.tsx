import { useEffect, useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { SeverityBadge } from "@maple/ui/components/logs/severity-badge"
import { Spinner } from "@maple/ui/components/ui/spinner"
import type { LogsListOutput } from "@maple/query-engine/ch"
import { useLocalLogs } from "../hooks/use-local-logs"

const ROW_HEIGHT = 40

export function LogsView() {
	const { data, isPending, isError, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
		useLocalLogs()

	const rows: ReadonlyArray<LogsListOutput> = data?.pages.flat() ?? []
	const scrollRef = useRef<HTMLDivElement>(null)

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 12,
	})

	// Fetch the next page when the last virtual row scrolls into view.
	const virtualItems = virtualizer.getVirtualItems()
	useEffect(() => {
		const last = virtualItems[virtualItems.length - 1]
		if (!last) return
		if (last.index >= rows.length - 1 && hasNextPage && !isFetchingNextPage) {
			fetchNextPage()
		}
	}, [virtualItems, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage])

	if (isPending) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		)
	}

	if (isError) {
		return (
			<div className="p-6 text-sm text-destructive">
				Failed to load logs: {error instanceof Error ? error.message : String(error)}
			</div>
		)
	}

	if (rows.length === 0) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground">
				<p className="text-sm">No logs yet</p>
				<p className="text-xs">Send OTLP logs to the local ingest endpoint to get started.</p>
			</div>
		)
	}

	return (
		<div ref={scrollRef} className="h-full overflow-auto">
			<div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
				{virtualItems.map((virtualRow) => {
					const log = rows[virtualRow.index]
					return (
						<div
							key={virtualRow.key}
							className="absolute inset-x-0 flex items-center gap-3 border-b px-4 font-mono text-xs"
							style={{
								height: virtualRow.size,
								transform: `translateY(${virtualRow.start}px)`,
							}}
						>
							<span className="w-44 shrink-0 text-muted-foreground">{log.timestamp}</span>
							<SeverityBadge severity={log.severityText || "info"} className="shrink-0" />
							<span className="w-40 shrink-0 truncate text-muted-foreground" title={log.serviceName}>
								{log.serviceName}
							</span>
							<span className="min-w-0 flex-1 truncate" title={log.body}>
								{log.body}
							</span>
						</div>
					)
				})}
			</div>
			{isFetchingNextPage ? (
				<div className="flex justify-center p-3">
					<Spinner className="size-4" />
				</div>
			) : null}
		</div>
	)
}

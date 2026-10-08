import { Link } from "@tanstack/react-router"
import { ClockIcon, ExternalLinkIcon, LinkIcon, PulseIcon } from "@/components/icons"

import { CopyableValue } from "@/components/attributes"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { IconButton } from "@maple/ui/components/ui/icon-button"
import { shortId } from "@maple/ui/lib/ids"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import { encodeLogKey, logPermalink } from "@/lib/log-key"
import { buildLogJsonPayload } from "./log-raw-panel"
import type { Log } from "@/api/warehouse/logs"

interface LogMetaStripProps {
	log: Log
	timeZone: string
	/**
	 * Show the "Open full page" link. `true` in the drawer; `false` on the
	 * standalone `/logs/$logId` page, where the link would point at itself.
	 */
	showOpenFullPage?: boolean
}

export function LogMetaStrip({ log, timeZone, showOpenFullPage = true }: LogMetaStripProps) {
	return (
		<div className="flex items-center gap-2 overflow-x-auto border-b px-4 py-1.5 text-xs shrink-0 whitespace-nowrap">
			<div className="flex items-center gap-1.5 shrink-0">
				<ClockIcon size={12} className="text-muted-foreground" />
				<span className="font-mono">
					<CopyableValue value={log.timestamp}>
						{formatTimestampInTimezone(log.timestamp, {
							timeZone,
							withMilliseconds: true,
						})}
					</CopyableValue>
				</span>
			</div>

			{log.traceId && (
				<Link
					to="/traces/$traceId"
					params={{ traceId: log.traceId }}
					search={{ t: log.timestamp }}
					className="inline-flex shrink-0 items-center gap-1 rounded border border-primary/20 bg-primary/5 px-1.5 py-0.5 font-mono text-2xs text-primary hover:bg-primary/10 transition-colors"
					title={`View trace ${log.traceId}`}
				>
					<PulseIcon size={10} />
					trace:{shortId(log.traceId, "trace")}
				</Link>
			)}

			{log.spanId && (
				<span className="shrink-0 font-mono text-2xs text-muted-foreground">
					<CopyableValue value={log.spanId}>span:{shortId(log.spanId, "span")}</CopyableValue>
				</span>
			)}

			{/* Icon-only actions keep the strip on a single line in the narrow drawer. */}
			<div className="ml-auto flex shrink-0 items-center gap-0.5">
				{showOpenFullPage && (
					<IconButton
						label="Open in full page"
						size="icon-xs"
						className="text-muted-foreground"
						render={<Link to="/logs/$logId" params={{ logId: encodeLogKey(log) }} />}
					>
						<ExternalLinkIcon size={13} />
					</IconButton>
				)}

				<CopyButton
					value={() => logPermalink(log)}
					label="Link to log"
					idleIcon={LinkIcon}
					iconSize={13}
					tooltip
				/>

				<CopyButton value={() => buildLogJsonPayload(log)} label="Log JSON" iconSize={13} tooltip />
			</div>
		</div>
	)
}

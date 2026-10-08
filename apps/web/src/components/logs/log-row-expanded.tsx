import * as React from "react"

import { ExternalLinkIcon } from "@/components/icons"
import { tryParseJson } from "@maple/ui/components/attributes"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { getSeverityColor } from "@maple/ui/lib/severity"
import type { Log } from "@/api/warehouse/logs"
import type { LogAttributeFilter } from "@/lib/logs/log-attribute-filters"
import { LogAttributesPanel } from "./log-attributes-panel"
import { buildLogJsonPayload } from "./log-raw-panel"
import { HighlightedText } from "./highlighted-text"
import { LogTextButton } from "./log-text-button"

interface LogRowExpandedProps {
	log: Log
	/** Text to mark in the message, when the search box holds a text search. */
	highlight?: string
	/** Opens the full detail drawer (Attributes / Trace / Raw tabs). */
	onOpenDetail: () => void
	/** Filter in / out from an attribute row. Omit and the rows only copy. */
	onAttributeFilter?: (filter: LogAttributeFilter) => void
}

/** A JSON body, re-indented; anything else comes back as-is. */
function prettyBody(body: string): string {
	const parsed = tryParseJson(body)
	return parsed === null ? body : JSON.stringify(parsed, null, 2)
}

/** Stack frames (`at …`, `File "…"`) read as context under the message line. */
const FRAME = /^\s+(at |File "|from )/

/**
 * Inline expansion beneath a log row's one-line header: the full body (JSON
 * re-indented, stack frames set back) on a severity-colored edge, then every
 * attribute via the shared `LogAttributesPanel`, in one height-bounded scroll
 * area so a wide event reads in place without leaving the stream.
 */
export function LogRowExpanded({ log, highlight, onOpenDetail, onAttributeFilter }: LogRowExpandedProps) {
	const lines = React.useMemo(() => prettyBody(log.body).split("\n"), [log.body])

	return (
		<div className="border-t border-border/60 bg-muted/20 px-3 py-3 pl-9 font-mono">
			<div className="max-h-[60vh] space-y-3 overflow-auto">
				<div className="relative rounded-md border border-border/70 bg-background/60 py-2 pl-3 pr-24">
					<span
						aria-hidden="true"
						className="absolute inset-y-1.5 left-0 w-0.5 rounded-full"
						style={{ backgroundColor: getSeverityColor(log.severityText) }}
					/>
					<div className="absolute right-1.5 top-1.5 flex items-center gap-2">
						<LogTextButton
							onClick={(e) => {
								e.stopPropagation()
								onOpenDetail()
							}}
						>
							<ExternalLinkIcon size={10} />
							Details
						</LogTextButton>
						<CopyButton
							value={() => buildLogJsonPayload(log)}
							label="Log JSON"
							idleLabel="JSON"
							iconSize={10}
							className="h-5 px-1.5 text-3xs"
							onClick={(e) => e.stopPropagation()}
						/>
					</div>
					<pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">
						{lines.map((line, index) => (
							<span
								key={index}
								className={FRAME.test(line) ? "text-muted-foreground" : undefined}
							>
								<HighlightedText text={line} query={highlight} />
								{index < lines.length - 1 ? "\n" : null}
							</span>
						))}
					</pre>
				</div>
				<LogAttributesPanel log={log} onAttributeFilter={onAttributeFilter} />
			</div>
		</div>
	)
}

import { toast } from "sonner"
import { CopyIcon, ExternalLinkIcon } from "@/components/icons"
import { useClipboard } from "@maple/ui/hooks/use-clipboard"
import type { Log } from "@/api/warehouse/logs"
import { LogAttributesPanel } from "./log-attributes-panel"
import { buildLogJsonPayload } from "./log-raw-panel"

interface LogRowExpandedProps {
	log: Log
	/** Opens the full detail drawer (Attributes / Trace / Raw tabs). */
	onOpenDetail: () => void
}

/**
 * Inline expansion rendered beneath a log row's one-line header. Shows the full
 * wrapped body plus every attribute (via the shared `LogAttributesPanel`) in a
 * height-bounded, vertically scrollable panel so a wide event reads in place
 * without leaving the stream.
 */
export function LogRowExpanded({ log, onOpenDetail }: LogRowExpandedProps) {
	const clipboard = useClipboard()

	return (
		<div className="border-t border-border/60 bg-muted/15 px-3 py-2.5 font-mono">
			<div className="mb-2 flex items-center justify-end gap-3">
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation()
						onOpenDetail()
					}}
					className="flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
				>
					<ExternalLinkIcon size={10} />
					Open detail
				</button>
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation()
						clipboard.copy(buildLogJsonPayload(log))
						toast.success("Copied log as JSON")
					}}
					className="flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
				>
					<CopyIcon size={10} />
					JSON
				</button>
			</div>
			{/* Body + attributes share one height-bounded scroll area so even a very
			    wide event stays a predictable size and scrolls vertically in place. */}
			<div className="max-h-[60vh] space-y-2.5 overflow-auto">
				<p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-foreground">
					{log.body}
				</p>
				<LogAttributesPanel log={log} />
			</div>
		</div>
	)
}

import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { toastManager } from "@maple/ui/components/ui/toast"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"
import { PaperPlaneIcon, PulseIcon } from "@/components/icons"
import { sendTestEvent, type IngestConnection } from "./use-ingest-connection"
import { useAsyncAction } from "@/hooks/use-mutation-action"

/**
 * Compact live-connection indicator for the Connect popover header. Amber pulse
 * while waiting, green dot once telemetry is observed.
 */
export function ConnectionStatusPill({ connection }: { connection: IngestConnection }) {
	const connected = connection.status === "connected"
	return (
		<Badge
			pill
			className={cn(
				"gap-1.5 text-2xs transition-colors sm:text-2xs",
				connected
					? "border-severity-info/30 bg-severity-info/10 text-severity-info"
					: "border-primary/30 bg-primary/10 text-primary",
			)}
		>
			{connected ? (
				<>
					<StatusDot tone="ok" />
					Connected · {connection.serviceCount}{" "}
					{connection.serviceCount === 1 ? "service" : "services"}
				</>
			) : (
				<>
					<PulseIcon size={11} className="size-[11px]" />
					Waiting for telemetry
				</>
			)}
		</Badge>
	)
}

/**
 * The waiting strip: "Watching for your first trace…" with a fallback
 * "Send a test event" button. Used by the dashboard checklist (waiting state).
 */
export function SendTestEventStrip({ apiKey, onTestSent }: { apiKey: string; onTestSent: () => void }) {
	const [handleSendTest, sending] = useAsyncAction(() => {
		if (!apiKey) return Promise.resolve()
		return sendTestEvent(apiKey).then(
			() => {
				toastManager.add({ title: "Test event sent. Watch for it to land below.", type: "success" })
				onTestSent()
			},
			() => {
				toastManager.add({
					title: "Couldn't reach the ingest endpoint. Double-check your API key.",
					type: "error",
				})
			},
		)
	})

	return (
		<div className="flex flex-col gap-3 rounded-lg border border-dashed border-primary/30 bg-primary/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
			<div className="flex items-center gap-2.5">
				<PulseIcon size={14} className="text-primary" />
				<span className="text-xs text-muted-foreground">Watching for your first trace…</span>
			</div>
			<div className="flex items-center gap-2">
				<span className="hidden text-2xs text-muted-foreground sm:inline">
					Not ready to instrument?
				</span>
				<Button
					variant="outline"
					size="sm"
					onClick={() => void handleSendTest()}
					loading={sending}
					disabled={!apiKey}
					className="gap-2 shrink-0"
				>
					<PaperPlaneIcon size={13} />
					Send a test event
				</Button>
			</div>
		</div>
	)
}

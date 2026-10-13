// Sidebar "Connect" affordance: a popover with the local ingest endpoint and
// exporter env. No API keys: everything ingests under the synthetic `local` org.

import { useState } from "react"
import { Button } from "@maple/ui/components/ui/button"
import {
	Popover,
	PopoverDescription,
	PopoverPopup,
	PopoverTitle,
	PopoverTrigger,
} from "@maple/ui/components/ui/popover"
import { ConnectionIcon } from "@maple/ui/components/icons"
import { useLocalServerStatus } from "../hooks/use-local-server-status"
import { ConnectGuide } from "./connect-guide"

export function ConnectButton() {
	const [open, setOpen] = useState(false)
	// The call to action until the first telemetry lands; a quiet outline after that.
	// Latched: older binaries estimate last ingest from a short window, so it goes back
	// to null when an app idles, and the button must not turn loud again then.
	const status = useLocalServerStatus()
	const [hasIngested, setHasIngested] = useState(false)
	if (!hasIngested && (status.data?.lastIngestAtMs ?? null) !== null) setHasIngested(true)

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<Button
						variant={hasIngested ? "outline" : "default"}
						size="sm"
						className="flex-1 justify-start gap-2 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:flex-none group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
						aria-label="Connect your app"
					>
						<ConnectionIcon />
						<span className="group-data-[collapsible=icon]:hidden">Connect</span>
					</Button>
				}
			/>
			<PopoverPopup side="right" align="end" className="w-[min(26rem,calc(100vw-2rem))]">
				{open && (
					<div className="space-y-4">
						<div className="space-y-1">
							<PopoverTitle className="text-base">Connect your app</PopoverTitle>
							<PopoverDescription className="text-xs">
								Point your OpenTelemetry SDK at your local Maple to stream traces, logs and
								metrics.
							</PopoverDescription>
						</div>
						<ConnectGuide
							note={
								<p className="text-xs text-muted-foreground">
									Recording browser sessions? Point{" "}
									<code className="rounded bg-muted px-1">@maple-dev/browser</code> at the
									same endpoint.
								</p>
							}
						/>
					</div>
				)}
			</PopoverPopup>
		</Popover>
	)
}

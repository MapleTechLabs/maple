// Header "Connect" affordance: a popover with the local ingest endpoint and
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
import { ConnectGuide } from "./connect-guide"

export function ConnectButton() {
	const [open, setOpen] = useState(false)

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<Button variant="default" size="sm" className="gap-2" aria-label="Connect your app">
						<ConnectionIcon size={14} />
						<span className="hidden sm:inline">Connect</span>
					</Button>
				}
			/>
			<PopoverPopup align="end" className="w-[min(26rem,calc(100vw-2rem))]">
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

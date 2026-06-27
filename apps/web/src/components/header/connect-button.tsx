import { useState } from "react"
import { Link } from "@tanstack/react-router"

import { Button } from "@maple/ui/components/ui/button"
import {
	Popover,
	PopoverDescription,
	PopoverPopup,
	PopoverTitle,
	PopoverTrigger,
} from "@maple/ui/components/ui/popover"
import { Separator } from "@maple/ui/components/ui/separator"
import { ArrowRightIcon, ConnectionIcon } from "@/components/icons"
import { CopyableField } from "@/components/ingest/copyable-field"
import { ConnectCredentials } from "@/components/ingest/connect-credentials"
import { ConnectionStatusPill } from "@/components/ingest/connection-status"
import { useIngestConnection } from "@/components/ingest/use-ingest-connection"

const ONBOARD_SKILL_COMMAND = "bunx skills add Makisuo/maple/skills/maple-onboard"

export function ConnectButton() {
	const [open, setOpen] = useState(false)

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<Button variant="default" size="sm" className="gap-2">
						<ConnectionIcon size={14} />
						Connect
					</Button>
				}
			/>
			<PopoverPopup align="end" className="w-[26rem]">
				{open && <ConnectPanel />}
			</PopoverPopup>
		</Popover>
	)
}

function ConnectPanel() {
	const connection = useIngestConnection()

	return (
		<div className="space-y-4">
			<div className="space-y-1.5">
				<div className="flex items-start justify-between gap-2">
					<PopoverTitle className="text-base">Connect your app</PopoverTitle>
					<ConnectionStatusPill connection={connection} />
				</div>
				<PopoverDescription className="text-xs">
					Point your OpenTelemetry SDK at this endpoint to start streaming telemetry into Maple.
				</PopoverDescription>
			</div>

			<ConnectCredentials />

			<Separator />

			<div className="space-y-2">
				<span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
					Fastest path · Claude Code
				</span>
				<CopyableField value={ONBOARD_SKILL_COMMAND} />
				<p className="text-xs text-muted-foreground">
					The <code className="rounded bg-muted px-1">maple-onboard</code> skill installs
					OpenTelemetry and wires traces, logs, and metrics end-to-end.
				</p>
			</div>

			<div className="flex items-center justify-between text-xs">
				<Link
					to="/settings"
					search={{ tab: "ingestion" }}
					className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
				>
					Open setup guide
					<ArrowRightIcon size={12} />
				</Link>
				<a
					href="https://maple.dev/docs"
					target="_blank"
					rel="noopener noreferrer"
					className="text-muted-foreground underline underline-offset-2 hover:no-underline"
				>
					Documentation
				</a>
			</div>
		</div>
	)
}

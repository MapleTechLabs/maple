import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"

import { Button } from "@maple/ui/components/ui/button"
import {
	Popover,
	PopoverDescription,
	PopoverPopup,
	PopoverTitle,
	PopoverTrigger,
} from "@maple/ui/components/ui/popover"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import { Separator } from "@maple/ui/components/ui/separator"
import { ArrowRightIcon, CheckIcon, ConnectionIcon, CopyIcon, EyeIcon } from "@/components/icons"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { ingestUrl } from "@/lib/services/common/ingest-url"

const ONBOARD_SKILL_COMMAND = "bunx skills add Makisuo/maple/skills/maple-onboard"

function maskKey(key: string): string {
	if (key.length <= 18) return key
	const prefix = key.slice(0, 14)
	const suffix = key.slice(-4)
	return `${prefix}${"•".repeat(key.length - 18)}${suffix}`
}

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
	const keysResult = useAtomValue(MapleApiAtomClient.query("ingestKeys", "get", {}))

	return (
		<div className="space-y-4">
			<div className="space-y-1">
				<PopoverTitle className="text-base">Connect your app</PopoverTitle>
				<PopoverDescription className="text-xs">
					Point your OpenTelemetry SDK at this endpoint to start streaming telemetry into Maple.
				</PopoverDescription>
			</div>

			<CopyableField label="Ingest endpoint" value={ingestUrl} />

			{Result.isFailure(keysResult) ? (
				<p className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
					Ask an org admin for your ingest keys, or open{" "}
					<SettingsLink>Settings → Ingestion</SettingsLink>.
				</p>
			) : (
				<>
					<CopyableField
						label="Public key"
						value={Result.builder(keysResult)
							.onSuccess((v) => v.publicKey)
							.orElse(() => "Loading…")}
						masked
					/>
					<CopyableField
						label="Private key"
						value={Result.builder(keysResult)
							.onSuccess((v) => v.privateKey)
							.orElse(() => "Loading…")}
						masked
					/>
				</>
			)}

			<Separator />

			<div className="space-y-2">
				<span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
					Set up with Claude Code
				</span>
				<CopyableField label="" value={ONBOARD_SKILL_COMMAND} />
				<p className="text-xs text-muted-foreground">
					The <code className="rounded bg-muted px-1">maple-onboard</code> skill installs
					OpenTelemetry and wires traces, logs, and metrics end-to-end.
				</p>
			</div>

			<div className="flex items-center justify-between text-xs">
				<SettingsLink className="inline-flex items-center gap-1 font-medium text-foreground hover:underline">
					Manage ingest keys
					<ArrowRightIcon size={12} />
				</SettingsLink>
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

function SettingsLink({ children, className }: { children: React.ReactNode; className?: string }) {
	return (
		<Link
			to="/settings"
			search={{ tab: "ingestion" }}
			className={
				className ?? "font-medium text-foreground underline underline-offset-2 hover:no-underline"
			}
		>
			{children}
		</Link>
	)
}

function CopyableField({ label, value, masked }: { label: string; value: string; masked?: boolean }) {
	const [copied, setCopied] = useState(false)
	const [isVisible, setIsVisible] = useState(false)

	async function handleCopy() {
		try {
			await navigator.clipboard.writeText(value)
			setCopied(true)
			toast.success(`${label || "Command"} copied`)
			setTimeout(() => setCopied(false), 1500)
		} catch {
			toast.error(`Failed to copy ${(label || "command").toLowerCase()}`)
		}
	}

	return (
		<div className="space-y-1">
			{label && <label className="text-xs text-muted-foreground">{label}</label>}
			<InputGroup>
				<InputGroupInput
					readOnly
					value={masked && !isVisible ? maskKey(value) : value}
					className="font-mono text-xs tracking-wide select-all"
				/>
				<InputGroupAddon align="inline-end">
					{masked && (
						<InputGroupButton
							onClick={() => setIsVisible((v) => !v)}
							aria-label={isVisible ? "Hide key" : "Reveal key"}
						>
							<EyeIcon size={14} className={isVisible ? "text-foreground" : undefined} />
						</InputGroupButton>
					)}
					<InputGroupButton
						onClick={handleCopy}
						aria-label={`Copy ${(label || "command").toLowerCase()}`}
					>
						{copied ? (
							<CheckIcon size={14} className="text-severity-info" />
						) : (
							<CopyIcon size={14} />
						)}
					</InputGroupButton>
				</InputGroupAddon>
			</InputGroup>
		</div>
	)
}

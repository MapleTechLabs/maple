import { useState } from "react"
import { cn } from "@maple/ui/lib/utils"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { Button } from "@maple/ui/components/ui/button"
import { Item, ItemContent, ItemMedia, ItemTitle } from "@maple/ui/components/ui/item"
import {
	ChevronDownIcon,
	ChevronRightIcon,
	CircleCheckIcon,
	CircleWarningIcon,
	CircleXmarkIcon,
} from "@/components/icons"
import { toolLabel } from "@/components/ai-elements/tool-metadata"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { ApprovalSummary, safeStringify } from "./approval-renderers"

interface ApprovalCardProps {
	toolName: string
	input: unknown
	/** Terminal state once the user has acted. Applies happen out-of-band (no agent round-trip). */
	resolved?: "applied" | "denied"
	onApprove: () => void | Promise<void>
	onDeny: () => void | Promise<void>
}

export function ApprovalCard({ toolName, input, resolved, onApprove, onDeny }: ApprovalCardProps) {
	const [showRaw, setShowRaw] = useState(false)
	const label = toolLabel(toolName)
	const [approve, approving] = useAsyncAction(async () => {
		await onApprove()
	})
	const [deny, denying] = useAsyncAction(async () => {
		await onDeny()
	})

	return (
		<div className="overflow-hidden rounded-lg border border-severity-warn/40 bg-severity-warn/5 text-xs">
			<Item size="xs" variant="flush" className="gap-2 px-3">
				<ItemMedia variant="icon">
					<CircleWarningIcon className={cn("size-3.5", TONE_TEXT.warn)} />
				</ItemMedia>
				<ItemContent>
					<ItemTitle>Approval required: {label}</ItemTitle>
				</ItemContent>
			</Item>
			<div className="border-t border-severity-warn/20 bg-background/50 p-3">
				<ApprovalSummary toolName={toolName} input={input} />

				<button
					type="button"
					onClick={() => setShowRaw((v) => !v)}
					className="mt-3 flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
				>
					{showRaw ? (
						<ChevronDownIcon className="size-3" />
					) : (
						<ChevronRightIcon className="size-3" />
					)}
					{showRaw ? "Hide raw input" : "Show raw input"}
				</button>
				{showRaw ? (
					<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-2xs leading-snug">
						{safeStringify(input)}
					</pre>
				) : null}

				{resolved === "applied" ? (
					<div className="mt-3 flex items-center gap-1.5 font-medium text-severity-info">
						<CircleCheckIcon className="size-3.5 shrink-0" />
						Applied
					</div>
				) : resolved === "denied" ? (
					<div className="mt-3 flex items-center gap-1.5 font-medium text-muted-foreground">
						<CircleXmarkIcon className="size-3.5 shrink-0" />
						Denied
					</div>
				) : (
					<div className="mt-3 flex gap-2">
						<Button
							type="button"
							size="sm"
							onClick={() => void approve()}
							loading={approving}
							disabled={denying}
						>
							Approve
						</Button>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() => void deny()}
							loading={denying}
							disabled={approving}
						>
							Deny
						</Button>
					</div>
				)}
			</div>
		</div>
	)
}

import { useState } from "react"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { maskKey } from "@maple/ui/components/ui/copyable-field"
import { IconButton } from "@maple/ui/components/ui/icon-button"
import { cn } from "@maple/ui/lib/utils"
import { REPLAY_BLOCK_CLASS } from "@/components/common/replay-privacy"
import { EyeIcon } from "@/components/icons"

/** An ingest key, masked until revealed, with copy. Copy always takes the real value. */
export function IngestKeyValue({ label, value }: { label: string; value: string }) {
	const [visible, setVisible] = useState(false)
	return (
		<div className="flex min-w-0 items-center gap-1">
			<span
				// A revealed key is plain text, which the dashboard's own session recording would capture.
				className={cn(
					REPLAY_BLOCK_CLASS,
					"text-muted-foreground min-w-0 font-mono text-2xs tracking-wide",
					visible ? "break-all" : "truncate",
				)}
			>
				{visible ? value : maskKey(value)}
			</span>
			<IconButton
				variant="ghost"
				size="icon-xs"
				onClick={() => setVisible((v) => !v)}
				label={visible ? "Hide key" : "Reveal key"}
			>
				<EyeIcon className={visible ? "text-foreground" : "text-muted-foreground"} />
			</IconButton>
			<CopyButton value={value} label={label} size="icon-xs" />
		</div>
	)
}

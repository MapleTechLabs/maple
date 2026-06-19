// Shared loading / empty / error placeholders so every view reads the same way.
// Built on the @maple/ui `Empty` compound + `Skeleton` so local mode matches the
// main web app's states exactly.

import type { ReactNode } from "react"
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@maple/ui/components/ui/empty"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { CircleWarningIcon, ConnectionIcon } from "@maple/ui/components/icons"
import { LOCAL_OTLP_ENDPOINT, localApiBase } from "../lib/constants"
import { CopyableField } from "./copyable-field"

export function EmptyState({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: ReactNode }) {
	return (
		<Empty className="h-full">
			{icon ? <EmptyMedia variant="icon">{icon}</EmptyMedia> : null}
			<EmptyHeader>
				<EmptyTitle>{title}</EmptyTitle>
				{hint ? <EmptyDescription>{hint}</EmptyDescription> : null}
			</EmptyHeader>
		</Empty>
	)
}

export function ErrorState({
	label,
	error,
	onRetry,
}: {
	label: string
	error: unknown
	onRetry?: () => void
}) {
	const message = error instanceof Error ? error.message : String(error)
	return (
		<Empty className="h-full">
			<EmptyMedia variant="icon">
				<CircleWarningIcon className="text-destructive" />
			</EmptyMedia>
			<EmptyHeader>
				<EmptyTitle>Couldn’t load {label}</EmptyTitle>
				<EmptyDescription className="font-mono text-xs break-all">{message}</EmptyDescription>
			</EmptyHeader>
			{onRetry ? (
				<EmptyContent>
					<Button variant="outline" size="sm" onClick={onRetry}>
						Try again
					</Button>
				</EmptyContent>
			) : null}
		</Empty>
	)
}

/**
 * Shown in place of the views when the local `maple` binary is unreachable —
 * the connection gate in `App` swaps to this instead of leaving an infinite
 * skeleton. Tells the user how to start the backend; the gate keeps polling, so
 * it auto-recovers (and "Try again" forces an immediate probe).
 */
export function DisconnectedState({ onRetry }: { onRetry: () => void }) {
	// `?port=` only matters in remote mode (the UI on local.maple.dev reaching
	// loopback); on same-origin/dev `localApiBase()` is "" and the port is fixed.
	const isRemote = localApiBase() !== ""
	return (
		<Empty className="h-full">
			<EmptyMedia variant="icon">
				<ConnectionIcon className="text-muted-foreground" />
			</EmptyMedia>
			<EmptyHeader>
				<EmptyTitle>Can’t reach Maple Local</EmptyTitle>
				<EmptyDescription>
					Start your local Maple backend and this view connects automatically.
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent className="w-full max-w-sm items-stretch gap-3">
				<CopyableField label="Start Maple" value="maple start" />
				<CopyableField label="Expecting" value={LOCAL_OTLP_ENDPOINT} />
				<p className="text-left text-xs text-muted-foreground">
					Make sure <code className="rounded bg-muted px-1">maple start</code> is running.
					{isRemote ? (
						<>
							{" "}
							On a different port? Append{" "}
							<code className="rounded bg-muted px-1">?port=&lt;n&gt;</code> to the URL.
						</>
					) : null}
				</p>
				<div className="flex items-center justify-between gap-2">
					<Button variant="outline" size="sm" onClick={onRetry}>
						Try again
					</Button>
					<a
						href="https://maple.dev/docs"
						target="_blank"
						rel="noopener noreferrer"
						className="text-xs text-muted-foreground underline underline-offset-2 hover:no-underline"
					>
						Documentation
					</a>
				</div>
			</EmptyContent>
		</Empty>
	)
}

/**
 * Content-shaped loading placeholder. `table` for the trace/log row lists,
 * `card` for the session card stack — keeps every loading state on the same
 * skeleton vocabulary instead of a bare spinner.
 */
export function ListSkeleton({ rows = 8, variant = "table" }: { rows?: number; variant?: "table" | "card" }) {
	return (
		<div className="space-y-2 p-4">
			{Array.from({ length: rows }).map((_, i) => (
				<Skeleton
					key={i}
					className={variant === "card" ? "h-[68px] w-full rounded-xl" : "h-10 w-full rounded-md"}
				/>
			))}
		</div>
	)
}

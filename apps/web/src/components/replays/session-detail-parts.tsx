import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { cn } from "@maple/ui/utils"
import { useClipboard } from "@maple/ui/hooks/use-clipboard"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { GlobeIcon, ComputerIcon, MobileIcon, ClockIcon, CopyIcon, CheckIcon } from "@/components/icons"
import { formatRelativeTime, gradientFor } from "./replay-format"
import { parseChTimestampMs } from "./replay-timeline"

// Presentational building blocks for the session-replay detail page. Extracted
// from the route so both the real page and the placeholder-data preview render
// the exact same components (no drift between what ships and what we review).

/** Device glyph keyed off the session's device type; falls back to a desktop. */
export function deviceIcon(deviceType: string): React.ReactNode {
	const d = deviceType.toLowerCase()
	if (d.includes("mobile") || d.includes("phone") || d.includes("tablet")) {
		return <MobileIcon className="size-3.5" />
	}
	return <ComputerIcon className="size-3.5" />
}

/** One-shot entrance reveal, skipped when the user prefers reduced motion. */
export function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
	const reduceMotion = useReducedMotion()
	if (reduceMotion) return <>{children}</>
	return (
		<motion.div
			initial={{ opacity: 0, y: 8 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.3, delay, ease: "easeOut" }}
		>
			{children}
		</motion.div>
	)
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
	const { copy } = useClipboard()
	const [copied, setCopied] = React.useState(false)

	const onCopy = React.useCallback(() => {
		void copy(value)
			.then(() => {
				setCopied(true)
				window.setTimeout(() => setCopied(false), 1200)
			})
			.catch(() => {})
	}, [copy, value])

	return (
		<button
			type="button"
			onClick={onCopy}
			aria-label={label ?? "Copy"}
			title={copied ? "Copied" : (label ?? "Copy")}
			className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
		>
			{copied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
		</button>
	)
}

export function StatusPill({ active }: { active: boolean }) {
	if (!active) {
		return (
			<span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
				<span className="size-1.5 rounded-full bg-muted-foreground/50" />
				Ended
			</span>
		)
	}
	return (
		<span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
			<span className="relative flex size-1.5">
				<span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
				<span className="relative inline-flex size-1.5 rounded-full bg-success" />
			</span>
			Live
		</span>
	)
}

/** Avatar + label + status + URL/started/id meta row. */
export function SessionIdentityHeader({
	sessionId,
	label,
	urlInitial,
	startTime,
	isActive,
}: {
	sessionId: string
	label: string
	urlInitial: string
	startTime: string
	isActive: boolean
}) {
	const startedEpoch = parseChTimestampMs(startTime)
	const startedValid = Number.isFinite(startedEpoch)
	return (
		<div className="mb-5 flex flex-wrap items-center gap-3">
			<div
				className={`grid size-11 shrink-0 place-items-center rounded-full bg-gradient-to-br ${gradientFor(sessionId)} font-display text-base font-semibold text-white shadow-sm`}
			>
				{(label[0] ?? "?").toUpperCase()}
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<h2 className="truncate font-display text-lg font-semibold leading-tight">{label}</h2>
					<StatusPill active={isActive} />
				</div>
				<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
					<a
						href={urlInitial}
						target="_blank"
						rel="noreferrer"
						className="inline-flex max-w-md items-center gap-1.5 truncate font-mono hover:text-foreground"
					>
						<GlobeIcon className="size-3 shrink-0 opacity-70" />
						<span className="truncate">{urlInitial}</span>
					</a>
					{startedValid && (
						<span
							className="inline-flex items-center gap-1.5"
							title={new Date(startedEpoch).toLocaleString()}
						>
							<ClockIcon className="size-3 shrink-0 opacity-70" />
							{formatRelativeTime(startedEpoch)}
						</span>
					)}
					<span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px]">
						{sessionId.slice(0, 12)}
						<CopyButton value={sessionId} label="Copy session id" />
					</span>
				</div>
			</div>
		</div>
	)
}

export function StatTile({
	icon,
	label,
	value,
	tone,
}: {
	icon: React.ReactNode
	label: string
	value: string
	tone?: "error"
}) {
	const isError = tone === "error"
	return (
		<div className="rounded-xl border border-border bg-card p-3.5 transition-colors hover:bg-muted/20">
			<div className="flex items-center justify-between gap-2">
				<span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
					{label}
				</span>
				<span
					className={cn(
						"grid size-6 shrink-0 place-items-center rounded-md",
						isError ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
					)}
				>
					{icon}
				</span>
			</div>
			<div
				className={cn(
					"mt-2 font-display text-2xl font-semibold tabular-nums",
					isError ? "text-destructive" : "text-foreground",
				)}
			>
				{value}
			</div>
		</div>
	)
}

export function DetailRow({
	icon,
	label,
	children,
}: {
	icon: React.ReactNode
	label: string
	children: React.ReactNode
}) {
	return (
		<div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm transition-colors hover:bg-muted/20">
			<dt className="flex items-center gap-2 text-muted-foreground">
				<span className="opacity-70">{icon}</span>
				{label}
			</dt>
			<dd className="truncate text-right font-medium">{children}</dd>
		</div>
	)
}

export function ReplayDetailSkeleton() {
	return (
		<div>
			{/* Identity header */}
			<div className="mb-5 flex items-center gap-3">
				<Skeleton className="size-11 shrink-0 rounded-full" />
				<div className="space-y-2">
					<Skeleton className="h-4 w-44" />
					<Skeleton className="h-3 w-64" />
				</div>
			</div>

			{/* Player + side column */}
			<div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1.9fr_1fr]">
				<Skeleton className="aspect-video w-full rounded-xl" />
				<div className="space-y-4">
					<div className="grid grid-cols-2 gap-2.5">
						{Array.from({ length: 4 }).map((_, i) => (
							<Skeleton key={i} className="h-[88px] rounded-xl" />
						))}
					</div>
					<Skeleton className="h-[200px] rounded-xl" />
				</div>
			</div>

			{/* Timeline strip */}
			<Skeleton className="mt-4 h-40 w-full rounded-xl" />
		</div>
	)
}

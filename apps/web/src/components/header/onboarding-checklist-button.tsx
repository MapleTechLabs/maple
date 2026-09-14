import { useState } from "react"
import { Link } from "@tanstack/react-router"
import type { V2OnboardingChecklist, V2OnboardingChecklistStep } from "@maple/domain/http/v2"
import { Button } from "@maple/ui/components/ui/button"
import { Popover, PopoverPopup, PopoverTrigger } from "@maple/ui/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/lib/utils"
import {
	ArrowRightIcon,
	CircleCheckIcon,
	ClockIcon,
	RocketIcon,
	StarIcon,
	XmarkIcon,
} from "@/components/icons"
import { useLiveClock } from "@/hooks/use-live-clock"
import { useOnboardingChecklist } from "@/hooks/use-onboarding-checklist"
import { parseSearchFromHref } from "@/lib/href"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"

const pad = (value: number) => value.toString().padStart(2, "0")

/** `23:41:07` — the pill's live countdown; clamps at `00:00:00`. */
export function formatCountdown(deadlineMs: number, nowMs: number): string {
	const remaining = Math.max(0, Math.floor((deadlineMs - nowMs) / 1000))
	const hours = Math.floor(remaining / 3600)
	const minutes = Math.floor((remaining % 3600) / 60)
	const seconds = remaining % 60
	return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

const formatCredits = (checklist: Pick<V2OnboardingChecklist, "reward_amount_usd">) =>
	`$${checklist.reward_amount_usd} credits`

/** Renders only under Clerk: self-hosted deployments have no billing to credit. */
export function OnboardingChecklistButton() {
	if (!isClerkAuthEnabled) return null
	return <OnboardingChecklistPill />
}

function OnboardingChecklistPill() {
	const {
		checklist,
		isAdmin,
		dismissed,
		dismiss,
		seen,
		markSeen,
		refresh,
		claim,
		claimPending,
		claimError,
	} = useOnboardingChecklist()
	const [open, setOpen] = useState(false)
	// Keeps the popover up through the "credits added" beat: the refreshed checklist reads
	// `claimed`, which would otherwise unmount the pill mid-sentence. Cleared on close.
	const [justClaimed, setJustClaimed] = useState(false)
	// The pill is a countdown, so it ticks every second while there is one to show.
	const counting = checklist !== null && !dismissed && checklist.status === "in_progress"
	const nowMs = useLiveClock({ intervalMs: 1000, enabled: counting })

	if (checklist === null || dismissed) return null
	const active = checklist.status === "in_progress" || checklist.status === "claimable"
	const deadlineMs = checklist.deadline_at === null ? null : Date.parse(checklist.deadline_at)
	// A session that crosses the deadline hides the pill on its next tick, without a timer of its own.
	const windowOpen = deadlineMs !== null && deadlineMs >= nowMs
	if (!justClaimed && !(active && windowOpen)) return null

	const claimable = checklist.status === "claimable"
	const credits = formatCredits(checklist)

	const handleOpenChange = (next: boolean) => {
		setOpen(next)
		if (next) {
			refresh()
			markSeen()
		} else {
			setJustClaimed(false)
		}
	}

	const handleClaim = async () => {
		if (await claim()) setJustClaimed(true)
	}

	return (
		<Popover open={open} onOpenChange={handleOpenChange}>
			<div className="relative">
				<PopoverTrigger
					render={
						<Button
							variant="outline"
							size="sm"
							className={cn(
								"gap-2 border-primary/40 bg-primary/10 text-foreground hover:bg-primary/15",
								claimable && "border-primary bg-primary/20",
							)}
						>
							<StarIcon size={14} className="text-primary" />
							{claimable || deadlineMs === null ? (
								<span>Claim {credits}</span>
							) : (
								<span className="font-mono tabular-nums">
									{formatCountdown(deadlineMs, nowMs)}
								</span>
							)}
							<ProgressChip
								completed={checklist.completed_count}
								total={checklist.total_count}
							/>
						</Button>
					}
				/>
				{!seen && !open && (
					<RewardCallout
						credits={credits}
						steps={checklist.total_count}
						onOpen={() => handleOpenChange(true)}
						onClose={markSeen}
					/>
				)}
			</div>
			<PopoverPopup align="end" className="w-[22rem] max-w-[calc(100vw-1rem)] p-0">
				{open && (
					<OnboardingChecklistPanel
						checklist={checklist}
						isAdmin={isAdmin}
						claimed={justClaimed || checklist.status === "claimed"}
						claimPending={claimPending}
						claimError={claimError}
						onClaim={handleClaim}
						onDismiss={() => {
							dismiss()
							setOpen(false)
						}}
						onClose={() => handleOpenChange(false)}
						nowMs={nowMs}
					/>
				)}
			</PopoverPopup>
		</Popover>
	)
}

/** `2/5` as a small chip: the count is the whole message, so it is written out. */
function ProgressChip({ completed, total }: { completed: number; total: number }) {
	return (
		<span
			className={cn(
				"rounded-full px-1.5 py-px font-mono text-[11px] font-semibold tabular-nums",
				completed === total ? "bg-primary text-primary-foreground" : "bg-primary/15 text-primary",
			)}
		>
			{completed}/{total}
		</span>
	)
}

/**
 * The one-time pointer under the pill that says what the timer is for. Goes away once the
 * popover has been opened or the pointer closed, and never comes back for this viewer and org.
 */
function RewardCallout({
	credits,
	steps,
	onOpen,
	onClose,
}: {
	credits: string
	steps: number
	onOpen: () => void
	onClose: () => void
}) {
	return (
		<div
			role="status"
			className="absolute top-full right-0 z-40 mt-3 w-max max-w-[16rem] rounded-lg border border-primary/40 bg-popover text-popover-foreground shadow-lg animate-in fade-in-0 slide-in-from-top-1"
		>
			<span
				className="absolute -top-1.5 right-6 size-3 rotate-45 border-t border-l border-primary/40 bg-popover"
				aria-hidden
			/>
			<div className="flex items-start gap-2 p-3 pr-2">
				<button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left outline-none">
					<span className="block text-sm font-semibold">Earn {credits}</span>
					<span className="mt-0.5 block text-xs text-muted-foreground">
						Finish {steps} setup steps before the timer runs out.
					</span>
				</button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Got it"
					onClick={onClose}
					className="-mt-1 shrink-0 text-muted-foreground"
				>
					<XmarkIcon size={12} />
				</Button>
			</div>
		</div>
	)
}

export interface OnboardingChecklistPanelProps {
	readonly checklist: V2OnboardingChecklist
	readonly isAdmin: boolean
	/** True once the credit is applied, whether in this session or an earlier one. */
	readonly claimed: boolean
	readonly claimPending: boolean
	readonly claimError: string | null
	readonly onClaim: () => void
	readonly onDismiss: () => void
	readonly onClose: () => void
	/** The live clock from the pill; tests inject a fixed one. */
	readonly nowMs?: number
}

export function OnboardingChecklistPanel({
	checklist,
	isAdmin,
	claimed,
	claimPending,
	claimError,
	onClaim,
	onDismiss,
	onClose,
	nowMs,
}: OnboardingChecklistPanelProps) {
	const credits = formatCredits(checklist)
	const deadlineMs = checklist.deadline_at === null ? null : Date.parse(checklist.deadline_at)
	const timeLeft = deadlineMs === null ? null : formatCountdown(deadlineMs, nowMs ?? Date.now())
	const progress = checklist.total_count === 0 ? 0 : checklist.completed_count / checklist.total_count

	return (
		<div>
			<div className="relative space-y-3 border-b bg-primary/[0.06] px-4 pt-4 pb-3">
				<div className="flex items-start gap-3 pr-8">
					<span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/15 text-primary">
						{claimed ? <CircleCheckIcon size={18} /> : <RocketIcon size={18} />}
					</span>
					<div className="min-w-0 space-y-1">
						{/* Plain elements rather than Popover.Title/Description: the panel is also rendered
						    and tested on its own, outside a Popover root. */}
						<h3 className="text-base font-semibold leading-tight">
							{claimed ? `${credits} added` : `Get ${credits}`}
						</h3>
						<p className="text-xs leading-relaxed text-muted-foreground">
							{claimed
								? `${credits} were added to your balance. They apply to your next invoices.`
								: `Finish these steps within 24 hours of creating your org and we'll credit your balance.`}
						</p>
					</div>
				</div>
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="Hide"
								onClick={onDismiss}
								className="absolute top-2 right-2 text-muted-foreground"
							/>
						}
					>
						<XmarkIcon size={14} />
					</TooltipTrigger>
					<TooltipContent>Hide</TooltipContent>
				</Tooltip>
				<div className="h-1 overflow-hidden rounded-full bg-primary/15" aria-hidden>
					<div
						className="h-full rounded-full bg-primary transition-[width] duration-500"
						style={{ width: `${Math.round(progress * 100)}%` }}
					/>
				</div>
			</div>

			<ol className="space-y-0.5 p-2">
				{checklist.steps.map((step, index) => (
					<StepRow key={step.id} step={step} index={index + 1} />
				))}
			</ol>

			<div className="flex items-center justify-between gap-3 border-t px-4 py-3 text-xs">
				{claimed ? (
					<>
						<span className="text-muted-foreground">You're all set.</span>
						<Button size="sm" onClick={onClose}>
							Done
						</Button>
					</>
				) : checklist.status === "claimable" ? (
					isAdmin ? (
						<>
							<span
								className={cn(
									"text-muted-foreground",
									claimError !== null && "text-destructive",
								)}
							>
								{claimError ?? "Every step is done."}
							</span>
							<Button size="sm" onClick={onClaim} disabled={claimPending}>
								{claimPending ? "Claiming…" : `Claim ${credits}`}
							</Button>
						</>
					) : (
						<span className="text-muted-foreground">
							All done. Ask an org admin to claim the credits.
						</span>
					)
				) : (
					<>
						<span className="font-mono tabular-nums text-muted-foreground">
							{checklist.completed_count} of {checklist.total_count} done
						</span>
						{timeLeft !== null && (
							<span className="inline-flex items-center gap-1 font-mono font-medium tabular-nums text-primary">
								<ClockIcon size={12} />
								{timeLeft}
							</span>
						)}
					</>
				)}
			</div>
		</div>
	)
}

function StepRow({ step, index }: { step: V2OnboardingChecklistStep; index: number }) {
	if (step.completed) {
		return (
			<li className="flex items-center gap-3 rounded-md px-2 py-2 text-sm text-muted-foreground">
				<CircleCheckIcon size={18} className="shrink-0 text-primary" />
				<span className="min-w-0 flex-1 truncate line-through decoration-muted-foreground/40">
					{step.title}
				</span>
			</li>
		)
	}
	const { pathname, search } = parseSearchFromHref(step.href)
	return (
		<li>
			<Link
				to={pathname}
				search={search as never}
				className="group flex items-center gap-3 rounded-md px-2 py-2 text-sm text-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
			>
				<span
					className="flex size-[18px] shrink-0 items-center justify-center rounded-full border border-muted-foreground/40 font-mono text-[10px] text-muted-foreground transition-colors group-hover:border-primary group-hover:text-primary"
					aria-hidden
				>
					{index}
				</span>
				<span className="min-w-0 flex-1 truncate">{step.title}</span>
				<ArrowRightIcon
					size={14}
					className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
				/>
			</Link>
		</li>
	)
}

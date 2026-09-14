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
import { useOnboardingChecklist } from "@/hooks/use-onboarding-checklist"
import { parseSearchFromHref } from "@/lib/href"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"

const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

/** `19h left` down to `42m left`; never negative. */
export function formatTimeLeft(deadlineMs: number, nowMs: number): string {
	const remaining = Math.max(0, deadlineMs - nowMs)
	if (remaining >= HOUR_MS) return `${Math.floor(remaining / HOUR_MS)}h left`
	return `${Math.max(1, Math.ceil(remaining / MINUTE_MS))}m left`
}

const formatCredits = (checklist: Pick<V2OnboardingChecklist, "reward_amount_usd">) =>
	`$${checklist.reward_amount_usd} credits`

/** The pill's label: the ask while steps remain, the payoff once they are done. */
export function formatOnboardingPill(
	checklist: Pick<V2OnboardingChecklist, "status" | "reward_amount_usd">,
): string {
	return checklist.status === "claimable"
		? `Claim ${formatCredits(checklist)}`
		: `Earn ${formatCredits(checklist)}`
}

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
	// `null` until the user has opened or closed it themselves; before that the popover
	// opens on its own exactly once per org, which is the attention cue.
	const [openOverride, setOpenOverride] = useState<boolean | null>(null)
	// Keeps the popover up through the "credits added" beat: the refreshed checklist reads
	// `claimed`, which would otherwise unmount the pill mid-sentence. Cleared on close.
	const [justClaimed, setJustClaimed] = useState(false)

	if (checklist === null || dismissed) return null
	const active = checklist.status === "in_progress" || checklist.status === "claimable"
	const deadlineMs = checklist.deadline_at === null ? null : Date.parse(checklist.deadline_at)
	// A session that crosses the deadline hides the pill on its next render, without a timer.
	const windowOpen = deadlineMs !== null && deadlineMs >= Date.now()
	if (!justClaimed && !(active && windowOpen)) return null

	const open = openOverride ?? !seen
	const claimable = checklist.status === "claimable"

	const handleOpenChange = (next: boolean) => {
		setOpenOverride(next)
		if (next) refresh()
		if (!next) {
			markSeen()
			setJustClaimed(false)
		}
	}

	const handleClaim = async () => {
		if (await claim()) setJustClaimed(true)
	}

	return (
		<Popover open={open} onOpenChange={handleOpenChange}>
			<PopoverTrigger
				render={
					<Button
						variant="outline"
						size="sm"
						className={cn(
							"relative gap-2 border-primary/40 bg-primary/10 text-foreground hover:bg-primary/15",
							claimable && "border-primary bg-primary/20",
						)}
					>
						<StarIcon size={14} className="text-primary" />
						<span className="hidden sm:inline">{formatOnboardingPill(checklist)}</span>
						<span className="inline sm:hidden">{formatCredits(checklist)}</span>
						<ProgressChip completed={checklist.completed_count} total={checklist.total_count} />
						{!seen && <AttentionDot />}
					</Button>
				}
			/>
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
							setOpenOverride(false)
						}}
						onClose={() => handleOpenChange(false)}
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

/** A pulsing corner marker until the popover has been opened once. */
function AttentionDot() {
	return (
		<span className="absolute -top-1 -right-1 flex size-2.5" aria-hidden>
			<span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
			<span className="relative inline-flex size-2.5 rounded-full bg-primary" />
		</span>
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
	/** Injected by tests; the panel otherwise reads the clock. */
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
	const timeLeft = deadlineMs === null ? null : formatTimeLeft(deadlineMs, nowMs ?? Date.now())
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
							<span className="inline-flex items-center gap-1 font-medium text-primary">
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

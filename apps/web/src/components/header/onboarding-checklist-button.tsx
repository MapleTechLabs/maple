import { useState } from "react"
import { Link } from "@tanstack/react-router"
import type { V2OnboardingChecklist, V2OnboardingChecklistStep } from "@maple/domain/http/v2"
import { Button } from "@maple/ui/components/ui/button"
import { Popover, PopoverPopup, PopoverTrigger } from "@maple/ui/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/lib/utils"
import { ArrowRightIcon, CircleCheckIcon, XmarkIcon } from "@/components/icons"
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
	const { checklist, isAdmin, dismissed, dismiss, refresh, claim, claimPending, claimError } =
		useOnboardingChecklist()
	const [open, setOpen] = useState(false)
	// Keeps the popover up through the "credits added" beat: the refreshed checklist reads
	// `claimed`, which would otherwise unmount the pill mid-sentence. Cleared on close.
	const [justClaimed, setJustClaimed] = useState(false)

	if (checklist === null || dismissed) return null
	const active = checklist.status === "in_progress" || checklist.status === "claimable"
	const deadlineMs = checklist.deadline_at === null ? null : Date.parse(checklist.deadline_at)
	// A session that crosses the deadline hides the pill on its next render, without a timer.
	const windowOpen = deadlineMs !== null && deadlineMs >= Date.now()
	if (!justClaimed && !(active && windowOpen)) return null

	const handleOpenChange = (next: boolean) => {
		setOpen(next)
		if (next) refresh()
		if (!next) setJustClaimed(false)
	}

	const handleClaim = async () => {
		if (await claim()) setJustClaimed(true)
	}

	return (
		<Popover open={open} onOpenChange={handleOpenChange}>
			<PopoverTrigger
				render={
					<Button variant="outline" size="sm" className="gap-2">
						<span className="hidden sm:inline">{formatOnboardingPill(checklist)}</span>
						<span className="inline sm:hidden">{formatCredits(checklist)}</span>
						<StepDots steps={checklist.steps} />
					</Button>
				}
			/>
			<PopoverPopup align="end" className="w-[22rem] max-w-[calc(100vw-1rem)]">
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
					/>
				)}
			</PopoverPopup>
		</Popover>
	)
}

/** One dot per step, filled as it completes — progress at a glance without a number. */
function StepDots({ steps }: { steps: ReadonlyArray<Pick<V2OnboardingChecklistStep, "id" | "completed">> }) {
	return (
		<span className="flex items-center gap-0.5" aria-hidden>
			{steps.map((step) => (
				<span
					key={step.id}
					className={cn(
						"size-1.5 rounded-full",
						step.completed ? "bg-primary" : "bg-muted-foreground/30",
					)}
				/>
			))}
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

	return (
		<div className="space-y-4">
			<div className="flex items-start justify-between gap-2">
				<div className="space-y-1">
					{/* Plain elements rather than Popover.Title/Description: the panel is also rendered
					    and tested on its own, outside a Popover root. */}
					<h3 className="text-base font-semibold leading-none">
						{claimed ? `${credits} added` : `Get ${credits}`}
					</h3>
					<p className="text-xs text-muted-foreground">
						{claimed
							? `${credits} were added to your balance. They apply to your next invoices.`
							: `Finish these steps within 24 hours of creating your org and we'll add ${credits} to your balance.`}
					</p>
				</div>
				<Tooltip>
					<TooltipTrigger
						render={
							<Button variant="ghost" size="icon-sm" aria-label="Hide" onClick={onDismiss} />
						}
					>
						<XmarkIcon size={14} />
					</TooltipTrigger>
					<TooltipContent>Hide</TooltipContent>
				</Tooltip>
			</div>

			<ol className="space-y-1">
				{checklist.steps.map((step) => (
					<StepRow key={step.id} step={step} />
				))}
			</ol>

			<div className="flex items-center justify-between gap-3 border-t pt-3 text-xs">
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
							<span className="text-muted-foreground">
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
						<span className="text-muted-foreground">
							{checklist.completed_count} of {checklist.total_count} done
						</span>
						{timeLeft !== null && <span className="font-medium text-foreground">{timeLeft}</span>}
					</>
				)}
			</div>
		</div>
	)
}

function StepRow({ step }: { step: V2OnboardingChecklistStep }) {
	if (step.completed) {
		return (
			<li className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground">
				<CircleCheckIcon size={16} className="shrink-0 text-primary" />
				<span className="min-w-0 flex-1 truncate">{step.title}</span>
			</li>
		)
	}
	const { pathname, search } = parseSearchFromHref(step.href)
	return (
		<li>
			<Link
				to={pathname}
				search={search as never}
				className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
			>
				<span
					className="size-4 shrink-0 rounded-full border-[1.5px] border-muted-foreground/40"
					aria-hidden
				/>
				<span className="min-w-0 flex-1 truncate">{step.title}</span>
				<ArrowRightIcon
					size={14}
					className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
				/>
			</Link>
		</li>
	)
}

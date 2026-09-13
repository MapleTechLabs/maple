import { Effect } from "effect"
import { StepIntent } from "@/components/onboarding/step-intent"
import { StepTeam } from "@/components/onboarding/step-team"
import type { OnboardingIntent } from "@/lib/onboarding-intent"
import { useState } from "react"
import { AnimatePresence } from "motion/react"
import { Link } from "@tanstack/react-router"
import { Button } from "@maple/ui/components/ui/button"
import { MapleMark } from "@maple/ui/components/icons/maple-mark"
import { CatalogPlan } from "@maple/domain/http"
import { STEP_IDS } from "@/atoms/quick-start-atoms"
import type { OnboardingRole } from "@/lib/onboarding-role"
import { OnboardingLayout } from "@/components/onboarding/onboarding-layout"
import { MotionStep } from "@/components/onboarding/motion-step"
import { StepRole } from "@/components/onboarding/step-role"
import { StepPlanLayout } from "@/components/onboarding/step-plan"
import { PlanCards } from "@/components/settings/pricing-cards"

// Illustrative catalog only. This lab never mounts billing or seed actions.
const PLANS = [
	new CatalogPlan({
		id: "startup",
		name: "Startup",
		price: { amount: 25, interval: "month" },
		items: [],
		customerEligibility: { trialAvailable: true },
	}),
]

export function OnboardingLab({ initialStep = 1 }: { initialStep?: number }) {
	const [step, setStep] = useState(initialStep)
	const [direction, setDirection] = useState(1)
	const [role, setRole] = useState<{ id: OnboardingRole; detail: string } | null>(null)
	const [run, setRun] = useState(0)
	const [intents, setIntents] = useState<readonly OnboardingIntent[]>([])
	const [workspaceName, setWorkspaceName] = useState("Your workspace")
	const [invitations, setInvitations] = useState<string[]>([])

	function goTo(next: number) {
		setDirection(next >= step ? 1 : -1)
		setStep(next)
	}

	function restart() {
		setRole(null)
		setIntents([])
		setWorkspaceName("Your workspace")
		setInvitations([])
		setRun(run + 1)
		goTo(1)
	}

	return (
		<OnboardingLayout
			currentStep={Math.min(step, STEP_IDS.length)}
			totalSteps={STEP_IDS.length}
			accountActions={
				<Link to="/lab" className="text-xs underline underline-offset-4">
					Exit preview
				</Link>
			}
		>
			<div className="flex flex-wrap items-center justify-center gap-3 border-y px-4 py-2 text-xs text-muted-foreground">
				<span>Onboarding preview · sample pricing · invites and checkout simulated</span>
				<Button variant="ghost" size="sm" onClick={restart}>
					Restart
				</Button>
			</div>
			<AnimatePresence mode="wait" custom={direction} initial={false}>
				<MotionStep key={`${run}-${step}`} direction={direction}>
					{step === 1 && (
						<StepRole
							value={role?.id ?? null}
							detail={role?.detail ?? ""}
							onChange={(id, detail) => setRole({ id, detail })}
							onContinue={() => goTo(2)}
						/>
					)}
					{step === 2 && (
						<StepIntent
							value={intents}
							onChange={setIntents}
							onContinue={() => goTo(3)}
							onBack={() => goTo(1)}
						/>
					)}
					{step === 3 && (
						<StepTeam
							initialName={workspaceName}
							initialInvitations={invitations}
							actions={{
								rename: (name) => Effect.sync(() => setWorkspaceName(name)),
								invite: (email) =>
									Effect.sync(() => setInvitations((previous) => [...previous, email])),
							}}
							onContinue={() => goTo(4)}
							onBack={() => goTo(2)}
						/>
					)}

					{step === 4 && (
						<StepPlanLayout onBack={() => goTo(3)}>
							<PlanCards
								plans={PLANS}
								onCheckout={() => goTo(5)}
								onEnterpriseContact={() => goTo(5)}
							/>
						</StepPlanLayout>
					)}
					{step === 5 && (
						<div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-16 text-center">
							<MapleMark size={56} className="text-primary" />
							<h1 className="text-2xl font-semibold">Preview complete</h1>
							<p className="max-w-md text-sm text-muted-foreground">
								In the real flow, plan selection opens checkout. This preview ends here
								without creating data or changing your plan.
							</p>
							<Button onClick={restart}>Try it again</Button>
							<Button variant="ghost" onClick={() => goTo(4)}>
								Back to plans
							</Button>
						</div>
					)}
				</MotionStep>
			</AnimatePresence>
		</OnboardingLayout>
	)
}

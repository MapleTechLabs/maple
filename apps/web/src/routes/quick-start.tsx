import { StepIntent } from "@/components/onboarding/step-intent"
import { StepTeamConnected } from "@/components/onboarding/step-team-connected"
import { MotionStep } from "@/components/onboarding/motion-step"
import { useState } from "react"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { useAuth } from "@clerk/clerk-react"
import { AnimatePresence } from "motion/react"
import { useMapleCustomer } from "@/hooks/use-maple-customer"

import { BootSplash } from "@/components/boot-splash"
import { OnboardingLayout } from "@/components/onboarding/onboarding-layout"
import { StepRole } from "@/components/onboarding/step-role"
import { StepPlan } from "@/components/onboarding/step-plan"

import { useQuickStart, type StepId } from "@/hooks/use-quick-start"
import { hasSelectedPlan, resolvePlanAccess } from "@/lib/billing/plan-gating"
import { STEP_IDS } from "@/atoms/quick-start-atoms"

const QuickStartSearch = Schema.Struct({
	// Where __root sends the user once onboarding completes.
	redirect_url: Schema.optional(Schema.String),
	// Stripe Checkout return marker — see `lib/billing/checkout-return.ts`.
	checkout: Schema.optional(Schema.Literal("complete")),
})

export const Route = createFileRoute("/quick-start")({
	component: QuickStartPage,
	validateSearch: Schema.toStandardSchemaV1(QuickStartSearch),
})

function QuickStartPage() {
	const { orgId } = useAuth()
	const { activeStep, setActiveStep, completeStep, isStepComplete, qualifyAnswers, setQualifyAnswers } =
		useQuickStart(orgId)

	const { data: customer, isLoading, error } = useMapleCustomer()
	const planSelected = hasSelectedPlan(customer)
	// Shared with __root's redirect gate. Anything but "onboarding" means this org
	// is not a new one — a lapsed subscriber arriving by bookmark, back button or
	// the post-signup redirect, or a customer read we could not trust. Both belong
	// in the app (the reactivation banner is what a lapsed one needs), never in
	// the new-user wizard.
	const access = resolvePlanAccess({ customer, error, isLoading })

	// "plan" completion is the live Autumn plan state, never a persisted flag.
	// A stale flag would disagree with __root.tsx's no-plan guard and trap the
	// user in an infinite /quick-start <-> / redirect loop that freezes the tab.
	const onboardingComplete =
		STEP_IDS.filter((step) => step !== "plan").every(isStepComplete) && planSelected

	const currentStepNumber = STEP_IDS.indexOf(activeStep as StepId) + 1
	const stepLabel = `Step ${currentStepNumber} of ${STEP_IDS.length}`

	// Track the previous step index for slide direction by adjusting state
	// during render — the documented React pattern for previous-render values.
	const [stepWindow, setStepWindow] = useState<[number, number]>([currentStepNumber, currentStepNumber])
	if (stepWindow[1] !== currentStepNumber) {
		setStepWindow([stepWindow[1], currentStepNumber])
	}
	const direction = currentStepNumber >= stepWindow[0] ? 1 : -1

	// Wait for the customer before rendering a step: deciding from an unsettled
	// query flashes "what's your role?" at a returning subscriber before the
	// bail-out below can fire.
	if (access === "loading") {
		return <BootSplash />
	}

	if (onboardingComplete || access !== "onboarding") {
		return <Navigate to="/" replace />
	}

	return (
		<OnboardingLayout currentStep={currentStepNumber} totalSteps={STEP_IDS.length} stepLabel={stepLabel}>
			<AnimatePresence mode="wait" custom={direction} initial={false}>
				{activeStep === "role" && (
					<MotionStep key="role" direction={direction}>
						<StepRole
							value={qualifyAnswers.role}
							detail={qualifyAnswers.roleDetail}
							onChange={(role, roleDetail) =>
								setQualifyAnswers({ ...qualifyAnswers, role, roleDetail })
							}
							onContinue={() => completeStep("role")}
						/>
					</MotionStep>
				)}

				{activeStep === "intent" && (
					<MotionStep key="intent" direction={direction}>
						<StepIntent
							value={qualifyAnswers.intents}
							onChange={(intents) => setQualifyAnswers({ ...qualifyAnswers, intents })}
							onContinue={() => completeStep("intent")}
							onBack={() => setActiveStep("role")}
						/>
					</MotionStep>
				)}
				{activeStep === "team" && (
					<MotionStep key="team" direction={direction}>
						<StepTeamConnected
							onContinue={() => completeStep("team")}
							onBack={() => setActiveStep("intent")}
						/>
					</MotionStep>
				)}

				{activeStep === "plan" && (
					<MotionStep key="plan" direction={direction}>
						<StepPlan onBack={() => setActiveStep("team")} />
					</MotionStep>
				)}
			</AnimatePresence>
		</OnboardingLayout>
	)
}

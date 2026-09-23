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
import { StepRegion } from "@/components/onboarding/step-region"
import { useOrganizationRegion } from "@/hooks/use-organization-region"
import { hasMultipleRegions } from "@/lib/region"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"

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

	// Asked first, and only where there is a choice: an organization Clerk created at sign-up has
	// no region yet. It is read from the organization, not saved here, because choosing the other
	// region continues onboarding on that region's dashboard.
	const orgRegion = useOrganizationRegion()
	const regionUnknown = isClerkAuthEnabled && hasMultipleRegions && !orgRegion.isLoaded
	const needsRegion = isClerkAuthEnabled && hasMultipleRegions && orgRegion.isLoaded && orgRegion.open

	// Billing is asked only once the region is settled: on the EU dashboard an organization without
	// one still reads as US, and this instance refuses its requests until it chooses.
	const {
		data: customer,
		isLoading,
		error,
	} = useMapleCustomer({
		queryOptions: { enabled: !needsRegion && !regionUnknown },
	})
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

	// Counted for the rest of the visit once shown, so the step total does not shrink under the user.
	const [regionStepShown, setRegionStepShown] = useState(false)
	if (needsRegion && !regionStepShown) setRegionStepShown(true)
	const regionOffset = regionStepShown ? 1 : 0
	const totalSteps = STEP_IDS.length + regionOffset

	const currentStepNumber = needsRegion ? 1 : STEP_IDS.indexOf(activeStep as StepId) + 1 + regionOffset
	const stepLabel = `Step ${currentStepNumber} of ${totalSteps}`

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
	if (regionUnknown || (!needsRegion && access === "loading")) {
		return <BootSplash />
	}

	if (!needsRegion && (onboardingComplete || access !== "onboarding")) {
		return <Navigate to="/" replace />
	}

	return (
		<OnboardingLayout currentStep={currentStepNumber} totalSteps={totalSteps} stepLabel={stepLabel}>
			<AnimatePresence mode="wait" custom={direction} initial={false}>
				{needsRegion && (
					<MotionStep key="region" direction={direction}>
						<StepRegion />
					</MotionStep>
				)}

				{!needsRegion && activeStep === "role" && (
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

				{!needsRegion && activeStep === "intent" && (
					<MotionStep key="intent" direction={direction}>
						<StepIntent
							value={qualifyAnswers.intents}
							onChange={(intents) => setQualifyAnswers({ ...qualifyAnswers, intents })}
							onContinue={() => completeStep("intent")}
							onBack={() => setActiveStep("role")}
						/>
					</MotionStep>
				)}
				{!needsRegion && activeStep === "team" && (
					<MotionStep key="team" direction={direction}>
						<StepTeamConnected
							onContinue={() => completeStep("team")}
							onBack={() => setActiveStep("intent")}
						/>
					</MotionStep>
				)}

				{!needsRegion && activeStep === "plan" && (
					<MotionStep key="plan" direction={direction}>
						<StepPlan onBack={() => setActiveStep("team")} />
					</MotionStep>
				)}
			</AnimatePresence>
		</OnboardingLayout>
	)
}

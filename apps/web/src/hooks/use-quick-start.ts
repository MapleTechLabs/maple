import { useCallback } from "react"
import { useAtom } from "@/lib/effect-atom"
import type { FrameworkId } from "@/components/quick-start/sdk-snippets"
import { trackProduct } from "@/lib/analytics"
import {
	DEFAULT_QUICK_START_STATE,
	quickStartAtomFamily,
	resolveQuickStartStep,
	STEP_IDS,
	type QualifyAnswers,
	type StepId,
} from "@/atoms/quick-start-atoms"

export type { StepId }

export function useQuickStart(orgId?: string | null) {
	const key = orgId ?? "default"
	const [state, setState] = useAtom(quickStartAtomFamily(key))

	const setActiveStep = useCallback(
		(id: StepId) => {
			setState((prev) => ({ ...prev, activeStep: id }))
		},
		[setState],
	)

	const completeStep = useCallback(
		(id: StepId) => {
			// Outside the updater: `setState` reducers run under StrictMode twice, and
			// an event emitted from one would double-count the funnel step.
			trackProduct("onboarding_step_completed", { step: id })
			setState((prev) => {
				const currentIndex = STEP_IDS.indexOf(id)
				const onThisStep = resolveQuickStartStep(prev) === id
				const nextStep =
					onThisStep && currentIndex < STEP_IDS.length - 1
						? STEP_IDS[currentIndex + 1]
						: prev.activeStep

				return {
					...prev,
					completedSteps: { ...prev.completedSteps, [id]: true },
					activeStep: nextStep,
				}
			})
		},
		[setState],
	)

	const uncompleteStep = useCallback(
		(id: StepId) => {
			setState((prev) => {
				const { [id]: _, ...rest } = prev.completedSteps
				return { ...prev, completedSteps: rest }
			})
		},
		[setState],
	)

	const setSelectedFramework = useCallback(
		(framework: FrameworkId) => {
			setState((prev) => ({ ...prev, selectedFramework: framework }))
		},
		[setState],
	)

	const setQualifyAnswers = useCallback(
		(answers: QualifyAnswers) => {
			setState((prev) => ({ ...prev, qualifyAnswers: answers }))
		},
		[setState],
	)

	const dismissChecklist = useCallback(() => {
		setState((prev) => ({ ...prev, checklistDismissed: true }))
	}, [setState])

	const setChecklistExpanded = useCallback(
		(expanded: boolean) => {
			setState((prev) => ({ ...prev, checklistExpanded: expanded }))
		},
		[setState],
	)

	const dismiss = useCallback(() => {
		setState((prev) => ({ ...prev, dismissed: true }))
	}, [setState])

	const undismiss = useCallback(() => {
		setState((prev) => ({ ...prev, dismissed: false }))
	}, [setState])

	const reset = useCallback(() => {
		setState(DEFAULT_QUICK_START_STATE)
	}, [setState])

	const isStepComplete = useCallback((id: StepId) => !!state.completedSteps[id], [state.completedSteps])

	const completedCount = STEP_IDS.filter((id) => state.completedSteps[id]).length
	const totalSteps = STEP_IDS.length
	const progressPercent = Math.round((completedCount / totalSteps) * 100)
	const isDismissed = state.dismissed
	const isComplete = completedCount === totalSteps

	return {
		activeStep: resolveQuickStartStep(state),
		setActiveStep,
		completeStep,
		uncompleteStep,
		dismiss,
		undismiss,
		reset,
		isStepComplete,
		completedCount,
		totalSteps,
		progressPercent,
		isDismissed,
		isComplete,
		selectedFramework: state.selectedFramework as FrameworkId | null,
		setSelectedFramework,
		qualifyAnswers: state.qualifyAnswers,
		setQualifyAnswers,
		checklistDismissed: state.checklistDismissed,
		dismissChecklist,
		checklistExpanded: state.checklistExpanded,
		setChecklistExpanded,
	}
}

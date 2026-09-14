import { useCallback, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { useRouter } from "@tanstack/react-router"
import { Exit } from "effect"
import type { V2OnboardingChecklist } from "@maple/domain/http/v2"
import { Result, useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { trackProduct } from "@/lib/analytics"
import { displayError } from "@/lib/error-messages"
import { onboardingRewardSeenAtomFamily } from "@/atoms/onboarding-reward-atoms"
import {
	claimOnboardingRewardMutation,
	onboardingChecklistAtom,
} from "@/lib/services/atoms/onboarding-checklist-atoms"

export interface OnboardingChecklistState {
	/** `null` until the first fetch lands, or when the org cannot be resolved. */
	readonly checklist: V2OnboardingChecklist | null
	readonly isAdmin: boolean
	/** False until the checklist has been opened once; drives the one-time pointer. */
	readonly seen: boolean
	readonly markSeen: () => void
	readonly refresh: () => void
	readonly claim: () => Promise<boolean>
	readonly claimPending: boolean
	readonly claimError: string | null
}

export function useOnboardingChecklist(): OnboardingChecklistState {
	const { orgId, userId } = useAuth()
	const isAdmin = useIsOrgAdmin()
	const router = useRouter()

	// Built per render, not at module load: the retained identity carries the active org, so
	// switching orgs inside the persistent layout reads the new org's checklist rather than
	// the one the module captured on first load.
	const checklistAtom = onboardingChecklistAtom()
	const result = useAtomValue(checklistAtom)
	const refresh = useAtomRefresh(checklistAtom)
	const [seen, setSeen] = useAtom(
		onboardingRewardSeenAtomFamily(`${orgId ?? "no-org"}:${userId ?? "no-user"}`),
	)
	const runClaim = useAtomSet(claimOnboardingRewardMutation, { mode: "promiseExit" })
	const [claimPending, setClaimPending] = useState(false)
	const [claimError, setClaimError] = useState<string | null>(null)

	// Every step is done on another page, so a navigation is the moment the user comes back
	// from one. One subscription for the lifetime of the layout; no polling.
	useMountEffect(() => router.subscribe("onResolved", () => refresh()))

	const markSeen = useCallback(() => {
		setSeen(true)
	}, [setSeen])

	const claim = useCallback(async () => {
		setClaimPending(true)
		setClaimError(null)
		const exit = await runClaim({})
		setClaimPending(false)
		if (Exit.isSuccess(exit)) {
			trackProduct("onboarding_reward_claimed")
			refresh()
			return true
		}
		setClaimError(displayError(exit).message)
		return false
	}, [runClaim, refresh])

	return {
		checklist: Result.isSuccess(result) ? result.value : null,
		isAdmin,
		seen,
		markSeen,
		refresh,
		claim,
		claimPending,
		claimError,
	}
}

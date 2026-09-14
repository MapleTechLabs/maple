import { MapleApiV2AtomClient, retainedQueryV2 } from "@/lib/services/common/v2-atom-client"

/**
 * The org's onboarding reward checklist. One fetch shared by the top-bar pill and its popover.
 *
 * Not polled: the pill lives in the persistent layout, so it refreshes when the popover opens,
 * after a claim, and once per navigation (see `useOnboardingChecklist`). Every step is a thing
 * the user does elsewhere in the app, and a navigation is the moment they come back from it.
 */
export const onboardingChecklistAtom = retainedQueryV2("onboardingChecklist", "retrieve", {})

export const claimOnboardingRewardMutation = MapleApiV2AtomClient.mutation("onboardingChecklist", "claim")

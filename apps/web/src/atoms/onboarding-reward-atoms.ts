import { Atom } from "@/lib/effect-atom"
import { Schema } from "effect"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"

/**
 * Whether this viewer has already met the onboarding reward pill for one org: the first
 * time, a pointer under the pill explains the timer; opening the checklist or closing the
 * pointer retires it. Keyed by org AND viewer (see `useOnboardingChecklist`): localStorage
 * outlives a sign-out, and a teammate signing in on the same browser gets their own first look.
 *
 * Deliberately NOT a dismissal. The pill itself stays until the credit is claimed or the
 * window closes — a reward with a deadline should not vanish on a misclick.
 */
export const onboardingRewardSeenAtomFamily = Atom.family((key: string) =>
	Atom.kvs({
		runtime: localStorageRuntime,
		key: `maple-onboarding-reward-seen-v3-${key}`,
		schema: Schema.Boolean,
		defaultValue: () => false,
	}),
)

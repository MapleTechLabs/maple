import { Atom } from "@/lib/effect-atom"
import { Schema } from "effect"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"

/**
 * This viewer's relationship to the onboarding reward pill for one org. A per-viewer
 * preference, not org state: a teammate should not lose the pill because an admin closed
 * it, and the reward window is a day, so cross-device persistence would buy nothing.
 *
 * `seen` flips the first time the popover closes; until then it opens by itself once and
 * the pill carries an attention marker.
 */
export interface OnboardingRewardViewState {
	readonly dismissed: boolean
	readonly seen: boolean
}

const OnboardingRewardViewStateSchema = Schema.Struct({
	dismissed: Schema.Boolean,
	seen: Schema.Boolean,
}) as Schema.Codec<OnboardingRewardViewState>

const DEFAULT: OnboardingRewardViewState = { dismissed: false, seen: false }

export const onboardingRewardViewAtomFamily = Atom.family((orgId: string) =>
	Atom.kvs({
		runtime: localStorageRuntime,
		key: `maple-onboarding-reward-v2-${orgId}`,
		schema: OnboardingRewardViewStateSchema,
		defaultValue: () => DEFAULT,
	}),
)

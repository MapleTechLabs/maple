import { Atom } from "@/lib/effect-atom"
import { Schema } from "effect"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"

/**
 * Whether this person hid the onboarding reward pill for this org. A per-viewer preference,
 * not org state: a teammate should not lose the pill because an admin closed it, and the
 * reward window is a day, so cross-device persistence would buy nothing.
 */
export const onboardingRewardDismissedAtomFamily = Atom.family((orgId: string) =>
	Atom.kvs({
		runtime: localStorageRuntime,
		key: `maple-onboarding-reward-dismissed-v1-${orgId}`,
		schema: Schema.Boolean,
		defaultValue: () => false,
	}),
)

import { Atom } from "@/lib/effect-atom"
import { Schema } from "effect"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"

/**
 * Per-org memory of "this org was last seen holding an active selected plan",
 * used by the `__root` gate to optimistically render the dashboard while the
 * Autumn customer query is still loading. Keyed by orgId so a brand-new org
 * (fresh signup) starts with no record — taking the no-flash "wait for the plan
 * to settle" path — while a returning paid org skips straight to the dashboard.
 * Cleared the moment an org is seen planless (e.g. after unsubscribing), so that
 * case flashes the dashboard at most once and then reverts to the wait path.
 * See MAP-45.
 */
const selectedPlanKnownAtomFamily = Atom.family((orgId: string) =>
	Atom.kvs({
		runtime: localStorageRuntime,
		key: `maple.billing.selected-plan.${orgId}`,
		schema: Schema.Boolean,
		defaultValue: () => false,
	}),
)

// Inert, in-memory fallback for renders without an active org (an org-less or
// still-settling auth session). Lets the consuming `useAtom` call stay
// unconditional without minting a bogus "default" org bucket in localStorage —
// an org-less session never reads or persists the flag anyway.
const noOrgSelectedPlanAtom = Atom.make(false)

/** The per-org selected-plan flag, or an inert in-memory atom when there's no org. */
export const selectedPlanKnownAtomFor = (orgId: string | null | undefined) =>
	orgId ? selectedPlanKnownAtomFamily(orgId) : noOrgSelectedPlanAtom

import { BillingCustomer } from "@maple/domain/http"
import type { MapleRegion } from "@maple/domain/organization-regions"
import { hasSelectedPlan, type PlanAccess, resolvePlanAccess } from "../../lib/billing/plan-gating"
import { hasMultipleRegions } from "../../lib/region"
import { writeLocalStorage } from "@maple/ui/lib/local-storage"
import { validateInternalRedirect } from "@maple/ui/lib/sanitizers"
import { Effect, Option, Schema } from "effect"
import { AsyncData } from "foldkit"
import type { ClerkOrganization } from "../../platform/clerk"
import { AppRoute, hrefOf, type Redirect } from "../../route"

// The plan and region gates of `ClerkReverseRedirects`, and the Autumn customer (`billingCustomerAtom`) they
// share with onboarding and the billing banners.

export const CustomerData = AsyncData.Schema(BillingCustomer, Schema.Literal("Failed"))
export type CustomerData = typeof CustomerData.schema.Type

/** The customer of the org it was read for; another org's answer is stale. */
export const CustomerSlot = Schema.Struct({ orgId: Schema.NullOr(Schema.String), data: CustomerData.schema })
export type CustomerSlot = typeof CustomerSlot.Type

export const initCustomer = (): CustomerSlot => ({ orgId: null, data: CustomerData.Idle() })

/** `useMapleCustomer().data`. */
export const customerOf = (slot: CustomerSlot): BillingCustomer | undefined =>
	AsyncData.getOrElse(slot.data, (): BillingCustomer | undefined => undefined)

export const accessOf = (slot: CustomerSlot): PlanAccess =>
	resolvePlanAccess({
		customer: customerOf(slot),
		error: AsyncData.isFailure(slot.data) ? slot.data : undefined,
		isLoading: AsyncData.isIdle(slot.data) || AsyncData.isLoading(slot.data),
	})

/** `selectedPlanKnownAtomFor(orgId)`: `maple.billing.selected-plan.<orgId>`. */
export const SELECTED_PLAN_KEY_PREFIX = "maple.billing.selected-plan."

/** Every org's remembered flag (Atom.kvs writes JSON), read once before the first render. */
export const readKnownToRenderApp: Effect.Effect<Record<string, boolean>> = Effect.try(() =>
	Object.fromEntries(
		Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
			.filter((key): key is string => key !== null && key.startsWith(SELECTED_PLAN_KEY_PREFIX))
			.map((key) => [key.slice(SELECTED_PLAN_KEY_PREFIX.length), localStorage.getItem(key) === "true"] as const),
	),
).pipe(Effect.orElseSucceed(() => ({})))

/** Writes the per-org "may render the app" memory once the plan settles. */
export const saveSelectedPlanKnown = (orgId: string, mayRenderApp: boolean): Effect.Effect<void> =>
	Effect.sync(() => writeLocalStorage(`${SELECTED_PLAN_KEY_PREFIX}${orgId}`, JSON.stringify(mayRenderApp)))

// GATE

/** Routes that render their own onboarding or billing UI: never sent away for want of a plan. */
const isAllowedWithoutPlan = AppRoute.isAnyOf(["SelectPlan", "QuickStart", "CliLogin", "McpAuthorize"])

/** Public paths that never read org data (`isOrgIndependentPath`). */
const isOrgIndependent = AppRoute.isAnyOf(["Unsubscribe"])

export type GateInput = Readonly<{
	route: AppRoute
	organization: Option.Option<ClerkOrganization>
	customer: CustomerSlot
	/** This browser last saw the org entitled to the app (the optimistic fast path). */
	isKnownToRenderApp: boolean
}>

/** `wrongRegion`: the org lives in another region and its choice is closed (`WrongRegionScreen`). */
export type Gate = Readonly<{ redirect: Option.Option<Redirect>; isSplash: boolean; wrongRegion: MapleRegion | null }>

const app: Gate = { redirect: Option.none(), isSplash: false, wrongRegion: null }
const splash: Gate = { redirect: Option.none(), isSplash: true, wrongRegion: null }
const redirectTo = (url: string): Gate => ({ redirect: Option.some({ url, isReplace: true }), isSplash: false, wrongRegion: null })

/** The region of an org another region serves, once it can no longer choose (`WrongRegionScreen`). */
export const wrongRegionOf = (organization: Option.Option<ClerkOrganization>): Option.Option<MapleRegion> =>
	Option.flatMap(organization, (org) => (org.isServedHere || org.isRegionOpen ? Option.none() : Option.some(org.homeRegion)))

/** `ClerkReverseRedirects` renders a splash or redirects instead of the route: nothing mounts yet. */
export const isRouteHeld = (gate: Gate): boolean => gate.isSplash || Option.isSome(gate.redirect)

/** `/quick-start` asks for the region first (`needsRegion`): a new org another region would serve. */
export const needsRegion = (organization: Option.Option<ClerkOrganization>): boolean =>
	Option.exists(organization, (org) => org.isRegionOpen && (hasMultipleRegions || !org.isServedHere))

/** The signed-in, org-holding branch of `ClerkReverseRedirects`, plus `/quick-start`'s bail-out. */
export const planGate = ({ route, organization, customer, isKnownToRenderApp }: GateInput): Gate => {
	if (isOrgIndependent(route)) return app
	const quickStart = hrefOf(AppRoute.QuickStart({ search: { redirect_url: hrefOf(route) } }))
	if (Option.exists(organization, (org) => !org.isServedHere)) {
		// A new org with no region yet has not picked one: onboarding asks.
		const isOpen = Option.exists(organization, (org) => org.isRegionOpen)
		if (isOpen) return route._tag !== "QuickStart" ? redirectTo(quickStart) : app
		return Option.match(wrongRegionOf(organization), {
			onNone: () => app,
			onSome: (region) => ({ ...app, wrongRegion: region }),
		})
	}
	const access = accessOf(customer)
	if (route._tag === "QuickStart" && !needsRegion(organization) && access !== "loading")
		return access === "onboarding" ? app : redirectTo("/")
	if (access === "unknown") return app
	if (access === "loading") return isAllowedWithoutPlan(route) || isKnownToRenderApp ? app : splash
	if (access !== "app" && !isAllowedWithoutPlan(route)) return redirectTo(quickStart)
	if (route._tag === "SelectPlan" && hasSelectedPlan(customerOf(customer)))
		return redirectTo(validateInternalRedirect(route.search.redirect_url) ?? "/")
	return app
}

import { OrgId, UserId } from "@maple/domain"
import { BillingCustomer } from "@maple/domain/http"
import { Option, Schema, Array as Arr, String as Str } from "effect"
import { describe, expect, test, vi } from "vitest"

// Clerk mode is read at import; the shell's favorites listener targets `window` at import too.
vi.hoisted(() => {
	vi.stubEnv("VITE_MAPLE_AUTH_MODE", "clerk")
	Object.assign(globalThis, { window: new EventTarget() })
})
import { Message } from "./message"
import { ClerkPhase, type Model, Session } from "./model"
import { initCustomer } from "./page/onboarding/plan-gate"
import * as Preload from "./page/preload"
import * as SignIn from "./page/sign-in"
import type { ClerkSnapshot } from "./platform/clerk"
import { AppRoute } from "./route"
import * as Shell from "./shell"
import * as Toast from "@maple/views/ui/toast"
import { pageContextOf, planGateOf, update } from "./update"
import * as TooltipHost from "@maple/views/ui/tooltip-host"

const orgId = Schema.decodeSync(OrgId)("org_acme")

const base = (knownToRenderApp: Record<string, boolean>): Model => ({
	route: AppRoute.Settings({ search: { tab: "members" } }),
	session: Session.Resolving(),
	clerk: ClerkPhase.Unused(),
	signIn: SignIn.init(),
	shell: Shell.init({ isMobile: false, theme: "light", pinnedNamespaces: {}, dashboardFavorites: [] }),
	toasts: Toast.init("toasts"),
	toastActions: {},
	toastRootActions: {},
	tooltip: TooltipHost.init("tooltip"),
	page: null,
	pageInstances: 0,
	parkedPages: [],
	onboarding: null,
	clerkSnapshot: null,
	customer: initCustomer(),
	knownToRenderApp,
	preload: Preload.init(),
	sessionTimeRange: null,
	timeZone: "UTC",
})

const snapshot: ClerkSnapshot = {
	maybeUserId: Option.some(UserId.make("user_ada")),
	maybeOrgId: Option.some(orgId),
	maybeUser: Option.some({ fullName: "Ada Lovelace", email: "ada@acme.test", imageUrl: "" }),
	maybeOrganization: Option.some({
		id: orgId,
		name: "Acme",
		imageUrl: "",
		homeRegion: "us",
		isServedHere: true,
		isRegionOpen: false,
		flags: {
			aiAutoTriage: false,
			cloudSecurity: false,
			dataSources: false,
			llmEvals: false,
			profiling: false,
			securityAudit: false,
		},
	}),
	memberships: [],
	maybeRole: Option.none(),
	maybeGrants: Option.none(),
	maybePendingTask: Option.none(),
}

const isSplash = (model: Model) => Option.exists(planGateOf(model), (gate) => gate.isSplash)
const namesOf = (result: { readonly commands?: ReadonlyArray<{ readonly name: string }> }) =>
	Arr.map(result.commands ?? [], ({ name }) => name)

describe("plan gate splash on a slow customer read", () => {
	test("a first visit holds the splash only until the grace elapses, then the page mounts", () => {
		const loaded = update(base({}), Message.CompletedLoadClerk({ snapshot }))
		expect(isSplash(loaded.model)).toBe(true)
		expect(loaded.model.page).toBeNull()
		expect(namesOf(loaded)).toContain("WaitCustomerGrace")

		const elapsed = update(loaded.model, Message.ElapsedCustomerGrace({ orgId }))
		expect(isSplash(elapsed.model)).toBe(false)
		expect(elapsed.model.page).not.toBeNull()
	})

	test("a grace that elapses after the read settled changes nothing", () => {
		const loaded = update(base({}), Message.CompletedLoadClerk({ snapshot }))
		const failed = update(loaded.model, Message.FailedLoadCustomer({ orgId }))
		const elapsed = update(failed.model, Message.ElapsedCustomerGrace({ orgId }))
		expect(elapsed.model).toBe(failed.model)
	})

	test("an org this browser already rendered skips the splash and the grace timer", () => {
		const loaded = update(base({ [orgId]: true }), Message.CompletedLoadClerk({ snapshot }))
		expect(isSplash(loaded.model)).toBe(false)
		expect(namesOf(loaded)).not.toContain("WaitCustomerGrace")
	})

	test("an org with no plan still goes to quick start once its slow read settles after the grace", () => {
		const loaded = update(base({}), Message.CompletedLoadClerk({ snapshot }))
		const elapsed = update(loaded.model, Message.ElapsedCustomerGrace({ orgId }))
		expect(Option.isNone(Option.flatMap(planGateOf(elapsed.model), (gate) => gate.redirect))).toBe(true)

		const customer = new BillingCustomer({ id: orgId, subscriptions: [] })
		const settled = update(elapsed.model, Message.SucceededLoadCustomer({ orgId, customer }))
		const redirect = Option.flatMap(planGateOf(settled.model), (gate) => gate.redirect)
		expect(Option.map(redirect, ({ url }) => Str.startsWith("/quick-start")(url))).toEqual(
			Option.some(true),
		)
	})
})

test("every org gets the Product analytics page, with no rollout flag", () => {
	const at: Model = { ...base({ [orgId]: true }), route: AppRoute.ProductAnalytics({ search: {} }) }
	const loaded = update(at, Message.CompletedLoadClerk({ snapshot }))
	expect(loaded.model.page).not.toBeNull()
	expect(namesOf(loaded)).not.toContain("ReplaceUrl")
})

describe("profiling rollout", () => {
	const withFlag = (profiling: boolean): ClerkSnapshot => ({
		...snapshot,
		maybeOrganization: Option.map(snapshot.maybeOrganization, (organization) => ({
			...organization,
			flags: { ...organization.flags, profiling },
		})),
	})
	const atService = (): Model => ({
		...base({ [orgId]: true }),
		route: AppRoute.Service({ serviceName: "checkout-api", search: { tab: "profiles" } }),
	})
	const profilingOf = (flag: boolean) => {
		const loaded = update(atService(), Message.CompletedLoadClerk({ snapshot: withFlag(flag) }))
		return Option.map(pageContextOf(loaded.model), (context) => context.hasProfiling)
	}

	test("a service page is told whether its org is in the rollout", () => {
		expect(profilingOf(false)).toEqual(Option.some(false))
		expect(profilingOf(true)).toEqual(Option.some(true))
	})
})

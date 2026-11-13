import { OrgId, UserId } from "@maple/domain"
import { Option, Schema } from "effect"
import { describe, expect, test, vi } from "vitest"

// Clerk mode is read at import; the shell's favorites listener targets `window` at import too.
vi.hoisted(() => {
	vi.stubEnv("VITE_MAPLE_AUTH_MODE", "clerk")
	Object.assign(globalThis, { window: new EventTarget() })
})
import { ClerkPhase, type Model, Session } from "./model"
import { initCustomer } from "./page/onboarding/plan-gate"
import * as Preload from "./page/preload"
import * as SignIn from "./page/sign-in"
import type { ClerkSnapshot } from "./platform/clerk"
import { AppRoute } from "./route"
import * as Shell from "./shell"
import * as Toast from "@maple/views/ui/toast"
import { pageContextOf, shellClerkOf } from "./update"
import * as TooltipHost from "@maple/views/ui/tooltip-host"

// The page and the shell read the viewer's audience from the same Clerk role, so they never disagree.

const orgId = Schema.decodeSync(OrgId)("org_acme")

const snapshotOf = (role: string | null): ClerkSnapshot => ({
	maybeUserId: Option.some(UserId.make("user_ada")),
	maybeOrgId: Option.some(orgId),
	maybeUser: Option.some({ fullName: "Ada Lovelace", email: "ada@acme.test", imageUrl: "" }),
	maybeOrganization: Option.none(),
	memberships: [],
	maybeRole: Option.fromNullishOr(role),
	maybePendingTask: Option.none(),
})

const signedIn = (role: string | null): Model => ({
	route: AppRoute.Home({ search: {} }),
	session: Session.SignedIn({ maybeOrgId: Option.some(orgId) }),
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
	clerkSnapshot: snapshotOf(role),
	customer: initCustomer(),
	knownToRenderApp: {},
	preload: Preload.init(),
	sessionTimeRange: null,
	timeZone: "UTC",
})

const audienceOf = (model: Model) => Option.getOrThrow(pageContextOf(model)).audience

describe("page context audience", () => {
	test("an observer's pages are told so, as their shell is", () => {
		const model = signedIn("org:observer")
		expect(audienceOf(model)).toBe("observer")
		expect(Shell.shellAudience(shellClerkOf(model))).toBe("observer")
	})

	test("any other role, and a role Clerk has not read yet, is an operator", () => {
		expect(audienceOf(signedIn("org:admin"))).toBe("operator")
		expect(audienceOf(signedIn("org:member"))).toBe("operator")
		expect(audienceOf(signedIn(null))).toBe("operator")
	})
})

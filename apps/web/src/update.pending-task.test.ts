import { OrgId, UserId } from "@maple/domain"
import { Option, Schema } from "effect"
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
import type { ClerkSnapshot, PendingSessionTask } from "./platform/clerk"
import { AppRoute } from "./route"
import * as Shell from "./shell"
import * as Toast from "./ui/toast"
import { update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")

const base = (route: AppRoute): Model => ({
	route,
	session: Session.Resolving(),
	clerk: ClerkPhase.Unused(),
	signIn: SignIn.init(),
	shell: Shell.init({ isMobile: false, theme: "light", pinnedNamespaces: {}, dashboardFavorites: [] }),
	toasts: Toast.init("toasts"),
	toastActions: {},
	toastRootActions: {},
	page: null,
	pageInstances: 0,
	parkedPages: [],
	onboarding: null,
	clerkSnapshot: null,
	customer: initCustomer(),
	knownToRenderApp: {},
	preload: Preload.init(),
	sessionTimeRange: null,
	timeZone: "UTC",
})

const snapshotOf = (task: PendingSessionTask | null): ClerkSnapshot => ({
	maybeUserId: Option.some(UserId.make("user_ada")),
	maybeOrgId: Option.some(orgId),
	maybeUser: Option.some({ fullName: "Ada Lovelace", email: "ada@acme.test", imageUrl: "" }),
	maybeOrganization: Option.none(),
	memberships: [],
	maybePendingTask: Option.fromNullishOr(task),
})

const namesOf = (result: { readonly commands?: ReadonlyArray<{ readonly name: string }> }) =>
	(result.commands ?? []).map(({ name }) => name)
const urlsOf = (result: {
	readonly commands?: ReadonlyArray<{ readonly name: string; readonly args?: unknown }>
}) => (result.commands ?? []).filter(({ name }) => name === "ReplaceUrl").map(({ args }) => args)

describe("pending session task", () => {
	test("a pending reset-password session is sent to the task screen, not the dashboard", () => {
		const loaded = update(
			base(AppRoute.Services({ search: {} })),
			Message.CompletedLoadClerk({ snapshot: snapshotOf("reset-password") }),
		)
		expect(urlsOf(loaded)).toEqual([{ url: "/sign-in?redirect_url=%2Fservices" }])
		expect(namesOf(loaded)).not.toContain("LoadCustomer")
		expect(loaded.model.page).toBeNull()
	})

	test("on /sign-in the pending session gets Clerk's task card, aimed back at the page it wanted", () => {
		const route = AppRoute.SignIn({ search: { redirect_url: "/services" } })
		const loaded = update(base(route), Message.CompletedLoadClerk({ snapshot: snapshotOf("setup-mfa") }))
		expect(urlsOf(loaded)).toEqual([])
		expect(loaded.model.onboarding?.screen).toEqual({
			_tag: "SessionTask",
			task: "setup-mfa",
			target: "/services",
		})
	})

	test("once the task is done the session leaves /sign-in for its target", () => {
		const route = AppRoute.SignIn({ search: { redirect_url: "/services" } })
		const pending = update(
			base(route),
			Message.CompletedLoadClerk({ snapshot: snapshotOf("reset-password") }),
		).model
		const done = update(pending, Message.ChangedClerkSession({ snapshot: snapshotOf(null) }))
		expect(urlsOf(done)).toEqual([{ url: "/services" }])
		expect(done.model.session).toEqual(Session.SignedIn({ maybeOrgId: Option.some(orgId) }))
	})

	test("a pending session on /sign-up keeps the sign-up's onboarding destination", () => {
		const loaded = update(
			base(AppRoute.SignUp({ search: {} })),
			Message.CompletedLoadClerk({ snapshot: snapshotOf("setup-mfa") }),
		)
		expect(urlsOf(loaded)).toEqual([{ url: "/sign-in?redirect_url=%2Fquick-start" }])
	})

	test("an org-less session without a task still goes to /org-required", () => {
		const snapshot = { ...snapshotOf(null), maybeOrgId: Option.none() }
		const loaded = update(
			base(AppRoute.Services({ search: {} })),
			Message.CompletedLoadClerk({ snapshot }),
		)
		expect(urlsOf(loaded)).toEqual([{ url: "/org-required?redirect_url=%2Fservices" }])
	})
})

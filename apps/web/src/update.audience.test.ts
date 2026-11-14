import { OrgId, UserId } from "@maple/domain"
import { Option, Schema } from "effect"
import { describe, expect, test, vi } from "vitest"

// Clerk mode is read at import; the shell's favorites listener targets `window` at import too.
vi.hoisted(() => {
	vi.stubEnv("VITE_MAPLE_AUTH_MODE", "clerk")
	Object.assign(globalThis, { window: new EventTarget() })
})
import { ClerkPhase, type Model, Session } from "./model"
import * as PageHold from "./page/page-hold"
import { initCustomer } from "./page/onboarding/plan-gate"
import * as Preload from "./page/preload"
import * as SignIn from "./page/sign-in"
import type { ClerkSnapshot } from "./platform/clerk"
import { AppRoute } from "./route"
import * as Shell from "./shell"
import * as Toast from "@maple/views/ui/toast"
import { pageContextOf, settle, shellClerkOf, update } from "./update"
import { view } from "./view"
import type { HtmlBuilder } from "foldkit/html"
import { expect as expectView, given, Mount, scene, text } from "foldkit/scene"
import { LinkedCursorMessage, MountLinkedZoom } from "@maple/views/charts/linked-cursor"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { MountAnalystHome } from "./page/overview/analyst/command"
import { Message as AnalystMessage } from "./page/overview/analyst/message"
import { MeasureSidebarOverflow } from "./shell/mounts"
import { Message as ShellMessage } from "./shell/message"
import type { Message } from "./message"
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
	pageHold: PageHold.Model.None(),
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
	test("an analyst's pages are told so, as their shell is", () => {
		const model = signedIn("org:analyst")
		expect(audienceOf(model)).toBe("analyst")
		expect(Shell.shellAudience(shellClerkOf(model))).toBe("analyst")
	})

	test("any other role, and a role Clerk has not read yet, is an operator", () => {
		expect(audienceOf(signedIn("org:admin"))).toBe("operator")
		expect(audienceOf(signedIn("org:member"))).toBe("operator")
		expect(audienceOf(signedIn(null))).toBe("operator")
	})
})

describe("the Overview the root draws", () => {
	const body = (model: Model, h: HtmlBuilder<Message>) => view(model, h).body
	// An org known to render the app is past the plan gate, so the page itself is drawn.
	const entered = (role: string) =>
		given(settle({ ...signedIn(role), knownToRenderApp: { [orgId]: true } }).model)

	const shellMounted = [
		Mount.resolve(Toast.PortalToasts, Toast.Message.CompletedPortalToasts()),
		Mount.resolve(Toast.PortalToasts, Toast.Message.CompletedPortalToasts()),
		Mount.resolve(MeasureSidebarOverflow, ShellMessage.MeasuredSidebarOverflow()),
	]

	test("an analyst gets their own page, not the engineers'", () => {
		scene(
			{ update, view: body },
			entered("org:analyst"),
			...shellMounted,
			Mount.resolve(MountAnalystHome, AnalystMessage.Entered()),
			expectView(text("Open incidents")).toExist(),
			expectView(text("Top errors")).toExist(),
		)
	})

	test("an admin keeps the engineers' page", () => {
		scene(
			{ update, view: body },
			entered("org:admin"),
			...shellMounted,
			Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
			Mount.resolve(MountLinkedZoom, LinkedCursorMessage.CompletedMountLinkedCursor()),
			expectView(text("Open incidents")).toBeAbsent(),
		)
	})
})

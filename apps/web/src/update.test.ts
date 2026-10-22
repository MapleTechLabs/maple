import { OrgId, UserId } from "@maple/domain"
import { Option, Schema } from "effect"
import { UrlRequest } from "foldkit/navigation"
import { fromString as urlFromString } from "foldkit/url"
import { describe, expect, test, vi } from "vitest"

// The shell's favorites listener targets `window` at import; the root update never touches it here.
vi.hoisted(() => Object.assign(globalThis, { window: new EventTarget() }))
import * as ChatSheet from "./page/chat/sheet"
import { Message } from "./message"
import { ClerkPhase, type Model, Session } from "./model"
import { initCustomer } from "./page/onboarding/plan-gate"
import * as Preload from "./page/preload"
import * as SignIn from "./page/sign-in"
import { AppRoute } from "./route"
import * as Shell from "./shell"
import { DashboardsData } from "./shell/model"
import * as Toast from "./ui/toast"
import type { ClerkSnapshot } from "./platform/clerk"
import { subscriptions } from "./subscription"
import { settle, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const NOW = Date.parse("2026-10-01T12:00:00Z")

const base = (route: AppRoute): Model => ({
	route,
	session: Session.SignedIn({ maybeOrgId: Option.some(orgId) }),
	clerk: ClerkPhase.Unused(),
	signIn: SignIn.init(),
	shell: Shell.init({ isMobile: false, theme: "light", pinnedNamespaces: {}, dashboardFavorites: [] }),
	toasts: Toast.init("toasts"),
	toastActions: {},
	toastRootActions: {},
	chatSheet: ChatSheet.init(),
	page: null,
	pageInstances: 0,
	parkedPages: [],
	onboarding: null,
	clerkSnapshot: null,
	customer: initCustomer(),
	knownToRenderApp: {},
	preload: Preload.init(),
	sessionTimeRange: { orgId, value: { timePreset: "7d" }, nowMs: NOW, isLoaded: true },
	timeZone: "UTC",
})

const urlOf = (path: string) => Option.getOrThrow(urlFromString(`http://localhost${path}`))
const commandsOf = (result: {
	readonly commands?: ReadonlyArray<{ readonly name: string; readonly args?: unknown }>
}) => (result.commands ?? []).map(({ name, args }) => ({ name, args }))

describe("root navigation", () => {
	test("a link navigation lands with the remembered window; Back/Forward is left as it is", () => {
		const model = base(AppRoute.Logs({ search: {} }))
		const clicked = update(
			model,
			Message.ClickedLink({ request: UrlRequest.Internal({ url: urlOf("/services") }) }),
		)
		expect(commandsOf(clicked)).toEqual([
			{ name: "NavigateInternal", args: { url: "/services?timePreset=7d" } },
		])
		const popped = update(model, Message.ChangedUrl({ url: urlOf("/services") }))
		expect(commandsOf(popped).filter(({ name }) => name === "ReplaceUrl")).toEqual([])
		expect(popped.model.route).toEqual(AppRoute.Services({ search: {} }))
	})

	test("a new zone preference becomes the page context: the open page re-resolves under it", () => {
		const entered = settle(base(AppRoute.AgentSessionTools({ search: {} }))).model
		const zoned = update(entered, Message.ChangedTimeZonePreference({ timeZone: "Asia/Tokyo" }))
		expect(zoned.model.timeZone).toBe("Asia/Tokyo")
		const resolve = commandsOf(zoned).filter(({ args }) => JSON.stringify(args).includes("Asia/Tokyo"))
		expect(resolve).toHaveLength(1)
		expect(
			update(zoned.model, Message.ChangedTimeZonePreference({ timeZone: "Asia/Tokyo" })).commands ?? [],
		).toEqual([])
	})

	test("a closed toast's action entries are dropped", () => {
		const model = {
			...base(AppRoute.Logs({ search: {} })),
			toastRootActions: { t1: { _tag: "ReconnectOrgCollections" as const } },
		}
		const ended = update(
			model,
			Message.GotToastMessage({ message: Toast.Message.EndedToastTransition({ toastId: "t1" }) }),
		)
		expect(ended.model.toastRootActions).toEqual({})
	})

	test("signing out releases what the last page held", () => {
		const model: Model = {
			...base(AppRoute.Services({ search: {} })),
			session: Session.SignedOut(),
			preload: { ...Preload.init(), holder: "ServicesList:Services:org_acme:1", heldKeys: ["k1"] },
		}
		const result = settle(model)
		expect(commandsOf(result)).toContainEqual({
			name: "ReleaseReads",
			args: { orgId: null, keys: ["k1"] },
		})
		expect(result.model.preload.heldKeys).toEqual([])
	})

	test("signing out drops the parked pages, so none comes back in the next session", () => {
		const parked = settle(base(AppRoute.Services({ search: {} }))).model.page
		const model: Model = {
			...base(AppRoute.Services({ search: {} })),
			session: Session.SignedOut(),
			parkedPages: parked === null ? [] : [parked],
		}
		expect(model.parkedPages).toHaveLength(1)
		expect(settle(model).model.parkedPages).toEqual([])
	})
})

describe("telemetry identity", () => {
	test("the first Clerk answer identifies the session; an unchanged emit does not again", () => {
		const snapshot = {
			maybeUserId: Option.some(UserId.make("user_ada")),
			maybeOrgId: Option.some(orgId),
			maybeUser: Option.some({ fullName: "Ada Lovelace", email: "ada@acme.test", imageUrl: "" }),
			maybeOrganization: Option.none(),
			memberships: [],
		}
		const loaded = update(
			base(AppRoute.Services({ search: {} })),
			Message.CompletedLoadClerk({ snapshot }),
		)
		expect(commandsOf(loaded)).toContainEqual({
			name: "IdentifySession",
			args: {
				identity: {
					id: "user_ada",
					username: "Ada Lovelace",
					email: "ada@acme.test",
					groupId: "org_acme",
				},
			},
		})
		const again = update(loaded.model, Message.ChangedClerkSession({ snapshot }))
		expect(commandsOf(again).map(({ name }) => name)).not.toContain("IdentifySession")
	})
})

describe("re-render on change only", () => {
	const snapshotOf = (organizationName: string): ClerkSnapshot => ({
		maybeUserId: Option.some(UserId.make("user_ada")),
		maybeOrgId: Option.some(orgId),
		maybeUser: Option.some({ fullName: "Ada Lovelace", email: "ada@acme.test", imageUrl: "" }),
		maybeOrganization: Option.some({
			id: orgId,
			name: organizationName,
			imageUrl: "",
			homeRegion: "us",
			isServedHere: true,
			isRegionOpen: false,
			flags: { aiAutoTriage: false, releases: false },
		}),
		memberships: [],
	})
	const loadedHome = () =>
		update(
			base(AppRoute.Home({ search: {} })),
			Message.CompletedLoadClerk({ snapshot: snapshotOf("Acme") }),
		).model

	test("a Clerk emit that changed nothing (a token refresh) keeps the model and runs nothing", () => {
		const model = loadedHome()
		const refreshed = update(model, Message.ChangedClerkSession({ snapshot: snapshotOf("Acme") }))
		expect(refreshed.model).toBe(model)
		expect(refreshed.commands ?? []).toEqual([])
	})

	test("a Clerk emit with a renamed org stores the new snapshot", () => {
		const renamed = update(
			loadedHome(),
			Message.ChangedClerkSession({ snapshot: snapshotOf("Acme Labs") }),
		)
		expect(renamed.model.clerkSnapshot?.maybeOrganization).toEqual(
			Option.some(expect.objectContaining({ name: "Acme Labs" })),
		)
	})

	test("a Clerk emit without a user signs the session out", () => {
		const signedOut = update(
			loadedHome(),
			Message.ChangedClerkSession({ snapshot: { ...snapshotOf("Acme"), maybeUserId: Option.none() } }),
		)
		expect(signedOut.model.session).toEqual(Session.SignedOut())
	})

	test("a shell message that changes no state keeps the root model, so the app does not re-render", () => {
		const model = base(AppRoute.Logs({ search: {} }))
		const visible = update(model, Message.GotShellMessage({ message: Shell.Message.BecameTabVisible() }))
		expect(visible.model).toBe(model)
		expect(commandsOf(visible).map(({ name }) => name)).toEqual(["CheckDeployedCommit"])
	})
})

describe("pinned dashboards load", () => {
	test("the sidebar waiting on dashboards watches for a sync failure, which settles it as failed", () => {
		const shell = {
			...base(AppRoute.Logs({ search: {} })).shell,
			maybeOrgId: Option.some(orgId),
			hasRequestedSidebarData: true,
		}
		const waiting: Model = {
			...base(AppRoute.Logs({ search: {} })),
			shell: { ...shell, dashboards: DashboardsData.Loading() },
		}
		const watched = (model: Model) => subscriptions.shellDashboardsLoad.modelToDependencies(model).orgId
		expect(watched(waiting)).toBe(orgId)
		const failed = update(
			waiting,
			Message.GotShellMessage({ message: Shell.Message.FailedLoadDashboards({ orgId }) }),
		).model
		expect(failed.shell.dashboards._tag).toBe("Failure")
		expect(watched(failed)).toBeNull()
	})
})

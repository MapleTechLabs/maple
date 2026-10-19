import { OrgId } from "@maple/domain"
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
import * as Toast from "./ui/toast"
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
	onboarding: null,
	clerkSnapshot: null,
	customer: initCustomer(),
	knownToRenderApp: {},
	preload: Preload.init(),
	sessionTimeRange: { orgId, value: { timePreset: "7d" }, nowMs: NOW, isLoaded: true },
	timeZone: "UTC",
})

const urlOf = (path: string) => Option.getOrThrow(urlFromString(`http://localhost${path}`))
const commandsOf = (result: { readonly commands?: ReadonlyArray<{ readonly name: string; readonly args?: unknown }> }) =>
	(result.commands ?? []).map(({ name, args }) => ({ name, args }))

describe("root navigation", () => {
	test("a link navigation lands with the remembered window; Back/Forward is left as it is", () => {
		const model = base(AppRoute.Logs({ search: {} }))
		const clicked = update(model, Message.ClickedLink({ request: UrlRequest.Internal({ url: urlOf("/services") }) }))
		expect(commandsOf(clicked)).toEqual([{ name: "NavigateInternal", args: { url: "/services?timePreset=7d" } }])
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
		expect(update(zoned.model, Message.ChangedTimeZonePreference({ timeZone: "Asia/Tokyo" })).commands ?? []).toEqual([])
	})

	test("a closed toast's action entries are dropped", () => {
		const model = { ...base(AppRoute.Logs({ search: {} })), toastRootActions: { t1: { _tag: "ReconnectOrgCollections" as const } } }
		const ended = update(model, Message.GotToastMessage({ message: Toast.Message.EndedToastTransition({ toastId: "t1" }) }))
		expect(ended.model.toastRootActions).toEqual({})
	})

	test("signing out releases what the last page held", () => {
		const model: Model = {
			...base(AppRoute.Services({ search: {} })),
			session: Session.SignedOut(),
			preload: { ...Preload.init(), holder: "ServicesList:Services:org_acme:1", heldKeys: ["k1"] },
		}
		const result = settle(model)
		expect(commandsOf(result)).toContainEqual({ name: "ReleaseReads", args: { orgId: null, keys: ["k1"] } })
		expect(result.model.preload.heldKeys).toEqual([])
	})
})

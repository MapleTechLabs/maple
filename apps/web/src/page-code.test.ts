import { OrgId } from "@maple/domain"
import { Effect, Option, Schema } from "effect"
import { fromString as urlFromString } from "foldkit/url"
import type { HtmlBuilder } from "foldkit/html"
import { expect as expectView, given, Mount, role, scene, text } from "foldkit/scene"
import { describe, expect, test, vi } from "vitest"

// The shell's favorites listener targets `window` at import; nothing here touches it.
vi.hoisted(() => Object.assign(globalThis, { window: new EventTarget() }))
import * as ChatSheet from "./page/chat/sheet"
import { toLoadFailure } from "./data/load-failure"
import { Message } from "./message"
import { init } from "./main"
import { LoadPageCode } from "./command"
import { ClerkPhase, type Model, PageCode, Session } from "./model"
import { initCustomer } from "./page/onboarding/plan-gate"
import * as Preload from "./page/preload"
import { PageLoadError } from "./page/registry"
import * as SignIn from "./page/sign-in"
import { AppRoute } from "./route"
import * as Shell from "./shell"
import { MeasureSidebarOverflow } from "./shell/mounts"
import { Message as ShellMessage } from "./shell/message"
import { subscriptions } from "./subscription"
import * as Toast from "./ui/toast"
import { settle, update } from "./update"
import { view } from "./view"

// No page code is loaded up front: each test file gets its own registry.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const NOW = Date.parse("2026-10-01T12:00:00Z")

const signedIn = (route: AppRoute): Model => ({
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
	pageCode: PageCode.Ready(),
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

type Step = ReturnType<typeof update>
const commandsNamed = (step: Step, name: string) =>
	(step.commands ?? []).filter((command) => command.name === name)
const loadArgsOf = (step: Step) => commandsNamed(step, "LoadPageCode").map((command) => command.args)
const LoadArgs = Schema.Struct({ pageId: Schema.String, preloadHref: Schema.NullOr(Schema.String) })
/** Runs the `LoadPageCode` the step asked for, as the runtime would. */
const runLoad = (step: Step) =>
	Effect.runPromise(
		Effect.flatMap(
			Schema.decodeUnknownEffect(LoadArgs)(loadArgsOf(step)[0]),
			(args) => LoadPageCode(args).effect,
		),
	)
const body = (model: Model, h: HtmlBuilder<Message>) => view(model, h).body

describe("page code", () => {
	test("the first load asks for the route's page code beside the session check", () => {
		const shell = {
			isMobile: false,
			theme: "light" as const,
			pinnedNamespaces: {},
			dashboardFavorites: [],
		}
		const started = init(
			{ hasStoredSession: true, timeZone: "UTC", knownToRenderApp: {}, shell },
			Option.getOrThrow(urlFromString("http://localhost/releases")),
		)
		expect((started.commands ?? []).map(({ name, args }) => ({ name, args }))).toEqual([
			{ name: "CheckSession", args: undefined },
			{ name: "LoadPageCode", args: { pageId: "ReleasesList", preloadHref: null } },
		])
		expect(started.model.pageCode).toEqual(PageCode.Loading({ pageId: "ReleasesList" }))
	})

	test("a route whose page code is not loaded shows the skeleton, loads it once, then enters", async () => {
		const waiting = settle(signedIn(AppRoute.Services({ search: {} })))
		expect(waiting.model.page).toBeNull()
		expect(waiting.model.pageCode).toEqual(PageCode.Loading({ pageId: "ServicesList" }))
		expect(loadArgsOf(waiting)).toEqual([{ pageId: "ServicesList", preloadHref: null }])
		// Clerk and the customer settle again while it loads: no second load.
		expect(commandsNamed(settle(waiting.model), "LoadPageCode")).toEqual([])

		const entered = update(waiting.model, await runLoad(waiting))
		expect(entered.model.page?._tag).toBe("ServicesList")
		expect(entered.model.pageCode).toEqual(PageCode.Ready())
	})

	test("leaving for an unloaded page leaves the open one and enters the new one when its code arrives", async () => {
		const first = settle(signedIn(AppRoute.Home({ search: {} })))
		const overview = update(first.model, await runLoad(first)).model
		expect(overview.page?._tag).toBe("Overview")

		const leaving = settle({ ...overview, route: AppRoute.Logs({ search: {} }) })
		expect(leaving.model.page).toBeNull()
		expect(leaving.model.pageCode).toEqual(PageCode.Loading({ pageId: "LogsList" }))
		const logs = update(leaving.model, await runLoad(leaving))
		expect(logs.model.page?._tag).toBe("LogsList")
	})

	test("a link to a page whose code is not loaded loads it first, then runs the page's preload", async () => {
		const href = `http://localhost/traces/${"a".repeat(32)}`
		const intended = update(
			signedIn(AppRoute.Logs({ search: {} })),
			Message.IntendedLink({ href, isImmediate: true }),
		)
		const [wait] = commandsNamed(intended, "WaitPreloadDelay")
		const version = Number(wait?.args?.["version"])
		const elapsed = update(intended.model, Message.ElapsedPreloadDelay({ href, version, nowMs: NOW }))
		expect(loadArgsOf(elapsed)).toEqual([{ pageId: "TraceDetail", preloadHref: href }])

		const preloaded = update(elapsed.model, await runLoad(elapsed))
		expect((preloaded.commands ?? []).map((command) => command.name)).toContain("FetchSpanHierarchy")
		expect(preloaded.model.page).toBeNull()
	})

	test("code that fails to load shows the failure and Reload loads the route again", () => {
		const waiting = settle(signedIn(AppRoute.ServiceMap({ search: {} }))).model
		const cause = new TypeError(
			"Failed to fetch dynamically imported module: /assets/implementation-x.js",
		)
		const failure = toLoadFailure(
			new PageLoadError({ message: "The ServiceMap page failed to load", pageId: "ServiceMap", cause }),
		)
		const failed = update(waiting, Message.FailedLoadPageCode({ pageId: "ServiceMap", failure })).model
		expect(failed.pageCode).toEqual(PageCode.Failed({ pageId: "ServiceMap", failure }))
		expect(commandsNamed(settle(failed), "LoadPageCode")).toEqual([])
		expect(
			(update(failed, Message.ClickedReloadPage()).commands ?? []).map(({ name, args }) => ({
				name,
				args,
			})),
		).toEqual([{ name: "LoadExternal", args: { href: "/service-map" } }])
		scene(
			{ update, view: body },
			given(failed),
			Mount.resolve(Toast.PortalToasts, Toast.Message.CompletedPortalToasts()),
			Mount.resolve(Toast.PortalToasts, Toast.Message.CompletedPortalToasts()),
			Mount.resolve(MeasureSidebarOverflow, ShellMessage.MeasuredSidebarOverflow()),
			expectView(text("Couldn't load this page")).toExist(),
			expectView(role("main", { name: "Loading" })).not.toExist(),
		)
	})

	test("the open page's Subscriptions run in slots that restart with a new instance", async () => {
		const first = settle(signedIn(AppRoute.AlertsCreate({ search: {} })))
		const editor = update(first.model, await runLoad(first)).model
		// The editor's ninth Subscription, in the ninth slot.
		const slot = subscriptions["page.8"]
		const dependencies = slot?.modelToDependencies(editor)
		expect(dependencies).toEqual({
			maybeDependencies: Option.some({
				maybeInstance: Option.some(expect.objectContaining({ page: "AlertEditor" })),
			}),
		})
		expect(slot?.keepAliveEquivalence?.(dependencies, slot.modelToDependencies(editor))).toBe(true)
		const rebuilt = { ...editor, pageInstances: editor.pageInstances + 1 }
		const reentered = settle({ ...rebuilt, page: null })
		expect(slot?.keepAliveEquivalence?.(dependencies, slot.modelToDependencies(reentered.model))).toBe(
			false,
		)
		// A page with fewer Subscriptions leaves the slot idle.
		const logs = settle({ ...editor, route: AppRoute.Logs({ search: {} }) }).model
		expect(slot?.modelToDependencies(logs)).toEqual({
			maybeDependencies: Option.some({ maybeInstance: Option.none() }),
		})
	})
})

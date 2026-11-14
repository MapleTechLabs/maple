import * as Animation from "@foldkit/ui/animation"
import { OrgId } from "@maple/domain"
import { Option, Schema } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import {
	click,
	Command,
	expect as expectView,
	given,
	Mount,
	role,
	scene,
	selector,
	text,
} from "foldkit/scene"
import { describe, expect, test, vi } from "vitest"

// The shell's favorites listener targets `window` at import; the scene never touches it.
vi.hoisted(() => Object.assign(globalThis, { window: new EventTarget() }))
import type { Message } from "./message"
import { ClerkPhase, type Model, Session } from "./model"
import * as PageHold from "./page/page-hold"
import type { PageSlot } from "./page/registry"
import { initCustomer } from "./page/onboarding/plan-gate"
import * as Preload from "./page/preload"
import * as SignIn from "./page/sign-in"
import { AppRoute } from "./route"
import * as Shell from "./shell"
import { MeasureSidebarOverflow } from "./shell/mounts"
import { Message as ShellMessage } from "./shell/message"
import * as Toast from "@maple/views/ui/toast"
import * as Dialog from "@maple/views/ui/dialog"
import { MountSuggestions, MountWhereEditor } from "./page/traces/list/command"
import { Message as TracesMessage } from "./page/traces/list/message"
import { settle, update } from "./update"
import { titleOf, view } from "./view"
import * as TooltipHost from "@maple/views/ui/tooltip-host"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const body = (model: Model, h: HtmlBuilder<Message>) => view(model, h).body

const signedIn = (): Model => ({
	route: AppRoute.Traces({ search: {} }),
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
	clerkSnapshot: null,
	customer: initCustomer(),
	knownToRenderApp: {},
	preload: Preload.init(),
	sessionTimeRange: null,
	timeZone: "UTC",
})

const tracesPage = (): Model => settle(signedIn()).model

describe("root view", () => {
	test("a shell route whose page is not up yet shows a page skeleton, never its route tag", () => {
		scene(
			{ update, view: body },
			given(signedIn()),
			Mount.resolve(Toast.PortalToasts, Toast.Message.CompletedPortalToasts()),
			Mount.resolve(Toast.PortalToasts, Toast.Message.CompletedPortalToasts()),
			Mount.resolve(MeasureSidebarOverflow, ShellMessage.MeasuredSidebarOverflow()),
			expectView(role("main", { name: "Loading" })).toExist(),
			expectView(text("Not ported yet")).not.toExist(),
			expectView(role("heading", { name: "Traces" })).not.toExist(),
		)
	})

	test("the memoized page still shows its own state: Advanced filter opens its dialog", () => {
		scene(
			{ update, view: body },
			given(tracesPage()),
			Mount.resolve(Toast.PortalToasts, Toast.Message.CompletedPortalToasts()),
			Mount.resolve(Toast.PortalToasts, Toast.Message.CompletedPortalToasts()),
			Mount.resolve(MeasureSidebarOverflow, ShellMessage.MeasuredSidebarOverflow()),
			expectView(role("dialog")).not.toExist(),
			click(role("button", { name: /Advanced filter/ })),
			expectView(role("dialog")).toExist(),
			Command.resolve(
				Animation.WaitForPaint,
				Animation.Message.CompletedWaitForPaint({ generation: 1 }),
			),
			Command.resolve(
				Animation.WaitForAnimationSettled,
				Animation.Message.EndedAnimation({ generation: 1 }),
			),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			Mount.resolve(MountWhereEditor, TracesMessage.FocusedAdvanced({ cursor: 0 })),
			Mount.resolve(MountSuggestions, TracesMessage.CompletedPlaceAdvancedCursor()),
		)
	})
})

describe("navigation hold", () => {
	const mounts = [
		Mount.resolve(Toast.PortalToasts, Toast.Message.CompletedPortalToasts()),
		Mount.resolve(Toast.PortalToasts, Toast.Message.CompletedPortalToasts()),
		Mount.resolve(MeasureSidebarOverflow, ShellMessage.MeasuredSidebarOverflow()),
	] as const
	/** The Logs page entered from Traces, under `hold`. */
	const enteredLogs = (hold: (traces: PageSlot, logs: PageSlot) => PageHold.Model): Model => {
		const traces = Option.getOrThrow(Option.fromNullishOr(tracesPage().page))
		const model = settle({ ...signedIn(), route: AppRoute.Logs({ search: {} }) }).model
		const logs = Option.getOrThrow(Option.fromNullishOr(model.page))
		return { ...model, pageHold: hold(traces, logs) }
	}

	test("while held, the page left is drawn and takes no clicks; the page entered is not drawn yet", () => {
		scene(
			{ update, view: body },
			given(
				enteredLogs((traces, logs) => ({
					_tag: "Holding",
					leaving: traces,
					instance: logs.instance,
				})),
			),
			...mounts,
			expectView(selector('[data-page-hold="held"]')).toExist(),
			expectView(role("heading", { name: "Traces" })).toExist(),
			expectView(role("heading", { name: "Logs" })).not.toExist(),
		)
	})

	test("after the hold ran out, the page entered is drawn and its skeletons skip their delay", () => {
		const traces = tracesPage()
		const instance = traces.page?.instance ?? 0
		scene(
			{ update, view: body },
			given({ ...traces, pageHold: PageHold.Model.Waited({ instance }) }),
			...mounts,
			expectView(selector('[data-page-hold="waited"]')).toExist(),
			expectView(role("heading", { name: "Traces" })).toExist(),
		)
	})
})

describe("tab title", () => {
	test("an open page names the tab, and a route with no page up yet is just Maple", () => {
		expect([
			titleOf(tracesPage()),
			titleOf(signedIn()),
			titleOf({ ...signedIn(), route: AppRoute.NotFound({ path: "/nope" }) }),
		]).toEqual(["Traces · Maple", "Maple", "Page not found · Maple"])
	})
})

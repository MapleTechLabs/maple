import * as Animation from "@foldkit/ui/animation"
import { OrgId } from "@maple/domain"
import { Effect, Option, Schema } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import { click, Command, expect as expectView, given, Mount, role, scene, text } from "foldkit/scene"
import { beforeAll, describe, test, vi } from "vitest"

// The shell's favorites listener targets `window` at import; the scene never touches it.
vi.hoisted(() => Object.assign(globalThis, { window: new EventTarget() }))
import type { Message } from "./message"
import { ClerkPhase, type Model, PageCode, Session } from "./model"
import { initCustomer } from "./page/onboarding/plan-gate"
import * as Preload from "./page/preload"
import * as SignIn from "./page/sign-in"
import { AppRoute } from "./route"
import * as Shell from "./shell"
import { MeasureSidebarOverflow } from "./shell/mounts"
import { Message as ShellMessage } from "./shell/message"
import * as Toast from "./ui/toast"
import * as Dialog from "./ui/dialog"
import { MountSuggestions, MountWhereEditor } from "./page/traces/list/command"
import { Message as TracesMessage } from "./page/traces/list/message"
import { settle, update } from "./update"
import { view } from "./view"
import { loadEveryPage } from "./page/registry"

// Pages enter only once their code is loaded (`loadPageCode`); these tests drive loaded pages.
beforeAll(() => Effect.runPromise(loadEveryPage))

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
	page: null,
	pageCode: PageCode.Ready(),
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

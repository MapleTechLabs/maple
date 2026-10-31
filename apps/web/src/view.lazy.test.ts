import { OrgId } from "@maple/domain"
import { Effect, Option, Schema } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import { Lazy } from "foldkit/test"
import { fromString } from "foldkit/url"
import { describe, expect, test, vi } from "vitest"

// The shell's favorites listener targets `window` at import; nothing here touches it.
vi.hoisted(() => Object.assign(globalThis, { window: new EventTarget() }))
import type { Message } from "./message"
import { ClerkPhase, type Model, PageCode, Session } from "./model"
import { initCustomer } from "./page/onboarding/plan-gate"
import * as Preload from "./page/preload"
import { pages, loadEveryPage } from "./page/registry"
import * as SignIn from "./page/sign-in"
import { urlToAppRoute } from "./route"
import * as Shell from "./shell"
import * as Toast from "./ui/toast"
import { settle } from "./update"
import { view } from "./view"

// Pages enter only once their code is loaded (`loadPageCode`); the sample models below are built at import.
await Effect.runPromise(loadEveryPage)

const orgId = Schema.decodeSync(OrgId)("org_acme")
const NOW = Date.parse("2026-10-01T12:00:00Z")

/** One URL per page. A page added to the registry without one fails the coverage test below. */
const SAMPLE_PATHS = [
	"/settings/ingestion/rules/new",
	"/services",
	"/",
	"/metrics",
	"/metrics/http.server.duration",
	"/errors",
	"/errors/issues/00000000-0000-4000-8000-000000000001",
	"/traces",
	"/traces/6843a8853182b32339b2dd5120d423f2",
	"/logs",
	"/logs/log_1",
	"/services/checkout",
	"/alerts",
	"/alerts/incidents/inc_1",
	"/alerts/00000000-0000-4000-8000-000000000002",
	"/alerts/create",
	"/alerts/uptime/new",
	"/alerts/uptime/upm_abc",
	"/status-pages",
	"/status-pages/new",
	"/status-pages/stp_abc",
	"/service-map",
	"/infra/hosts",
	"/infra/hosts/web-1",
	"/infra/containers",
	"/infra/containers/api",
	"/infra/kubernetes/pods",
	"/infra/kubernetes/pods/api-0",
	"/infra/kubernetes/nodes",
	"/infra/kubernetes/nodes/node-1",
	"/infra/kubernetes/workloads",
	"/infra/kubernetes/workloads/deployment/api",
	"/infra/kubernetes/services/api",
	"/infra",
	"/infra/railway",
	"/infra/railway/svc_1?environmentId=%22env_1%22",
	"/infra/supabase",
	"/infra/supabase/abcdefghijklmnop",
	"/infra/planetscale",
	"/infra/planetscale/orders",
	"/infra/gcp",
	"/infra/gcp/cloudSql/acme",
	"/infra/aws",
	"/infra/aws/ecs/payments-api?cluster=%22prod%22",
	"/infra/cloudflare",
	"/infra/cloudflare/workers/api",
	"/infra/cloudflare/example.com",
	"/dashboards",
	"/dashboards/00000000-0000-4000-8000-000000000003",
	"/dashboards/templates",
	"/dashboards/00000000-0000-4000-8000-000000000003/widgets/w1",
	"/code-review",
	"/security",
	"/security/findings",
	"/security/runs",
	"/security/runs/run_1",
	"/security/findings/00000000-0000-4000-8000-000000000005/fp_1",
	"/agent-sessions",
	"/agent-sessions/tools",
	"/agent-sessions/tools/run_sql",
	"/agent-sessions/session_1",
	"/integrations",
	"/recommendations/rec_1",
	"/anomalies",
	"/anomalies/00000000-0000-4000-8000-000000000004",
	"/releases",
	"/releases/abc123",
	"/investigations",
	"/investigations/inv_1",
	"/settings",
	"/mcp",
	"/sources",
	"/sources/new",
	"/sources/src_1",
	"/account",
	"/replays",
	"/replays/session_1",
	"/share/token_1",
	"/analytics",
]

const entered = (path: string): Model =>
	settle({
		route: urlToAppRoute(Option.getOrThrow(fromString(`http://localhost${path}`))),
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
		sessionTimeRange: { orgId, value: { timePreset: "7d" }, nowMs: NOW, isLoaded: true },
		timeZone: "UTC",
	}).model

const body = (model: Model, h: HtmlBuilder<Message>) => view(model, h).body

const ENTERED = SAMPLE_PATHS.map((path) => ({ path, model: entered(path) }))

describe("root view lazy page slot", () => {
	test("every registered page has a sample URL", () => {
		const reached = new Set(
			ENTERED.flatMap(({ model }) => (model.page === null ? [] : [model.page._tag])),
		)
		expect(pages.map((page) => page.id).filter((id) => !reached.has(id))).toEqual([])
	})

	test.each(ENTERED)("$path re-renders the root without rebuilding the page", ({ model }) => {
		Lazy.expectAllReused({ view: body, model })
	})
})

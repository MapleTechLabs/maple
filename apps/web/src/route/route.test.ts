import { END_USER_ID_MAX_LENGTH } from "@maple/domain/http"
import { Option, String as Str } from "effect"
import { fromString } from "foldkit/url"
import { describe, expect, test } from "vitest"
import { DATA_INTEGRATIONS } from "./data-integrations"
import { AppRoute, flaggedRouteRedirect, hrefOf, routeRedirect, urlToAppRoute } from "./index"

const parse = (path: string) => urlToAppRoute(Option.getOrThrow(fromString(`http://maple.test${path}`)))

describe("routes", () => {
	test("search params decode with TanStack's JSON-per-value format", () => {
		const route = parse("/traces?services=%5B%22api%22%5D&hasError=true&timePreset=7d")
		expect(route).toMatchObject({
			_tag: "Traces",
			search: { services: ["api"], hasError: true, timePreset: "7d" },
		})
	})

	test("a Cloud SQL statement peek decodes whether its digits are quoted or not", () => {
		for (const peek of ["8113412291", "%228113412291%22"]) {
			expect(parse(`/infra/gcp/cloudSql/acme%3Aorders-db?peek=${peek}`)).toMatchObject({
				_tag: "InfraGcpResource",
				search: { peek: "8113412291" },
			})
		}
	})

	test("a string param a link wrote unquoted decodes to its text", () => {
		expect(parse("/replays?userId=12345")).toMatchObject({ _tag: "Replays", search: { userId: "12345" } })
		expect(parse("/logs?search=404")).toMatchObject({ _tag: "Logs", search: { search: "404" } })
		expect(parse("/users?q=true")).toMatchObject({ _tag: "Users", search: { q: "true" } })
		expect(parse("/metrics?q=null")).toMatchObject({ _tag: "Metrics", search: { q: "null" } })
		expect(parse("/traces?httpStatusCodes=%5B404%2C%22500%22%5D")).toMatchObject({
			_tag: "Traces",
			search: { httpStatusCodes: ["404", "500"] },
		})
	})

	test("an unquoted id too long or too odd for a number keeps every character", () => {
		// Past 2^53, and exponent form: both would change when read as a number.
		expect(parse("/traces/abc?spanId=9876543210987654321")).toMatchObject({
			_tag: "Trace",
			search: { spanId: "9876543210987654321" },
		})
		expect(parse("/logs?traceId=1e5")).toMatchObject({ _tag: "Logs", search: { traceId: "1e5" } })
		// A span id is 16 hex characters, which can all be digits.
		expect(parse("/agent-sessions/s1?span=1234567890123456")).toMatchObject({
			_tag: "AgentSession",
			search: { span: "1234567890123456" },
		})
		// The one required string param.
		expect(parse("/infra/railway/svc?environmentId=42")).toMatchObject({
			_tag: "InfraRailwayService",
			search: { environmentId: "42" },
		})
	})

	test("a numeric-looking string is written quoted and reads back the same", () => {
		const route = parse("/replays?userId=12345")
		expect(hrefOf(route)).toBe("/replays?userId=%2212345%22")
		expect(parse(hrefOf(route))).toEqual(route)
	})

	test("a number param still reads a number the text does not print back as", () => {
		expect(parse("/replays?durationMin=1e3")).toMatchObject({ search: { durationMin: 1000 } })
		expect(parse("/traces?minDurationMs=1.50")).toMatchObject({ search: { minDurationMs: 1.5 } })
	})

	test("a user page takes any id the API accepts, decoded, and nothing longer", () => {
		// Cloudflare delivers an encoded `%2F` as a real slash, so the id is the rest of the path.
		const route = parse("/users/user/42%20ada")
		expect(route).toMatchObject({ _tag: "UserDetail", userId: "user/42 ada" })
		expect(hrefOf(route)).toBe("/users/user/42%20ada")
		expect(parse("/users/user%2F42%20ada")).toMatchObject({ _tag: "UserDetail", userId: "user/42 ada" })
		expect(parse(`/users/${Str.repeat(END_USER_ID_MAX_LENGTH)("u")}`)._tag).toBe("UserDetail")
		expect(parse(`/users/${Str.repeat(END_USER_ID_MAX_LENGTH + 1)("u")}`)._tag).not.toBe("UserDetail")
	})

	test("path params are percent-decoded and printed back encoded", () => {
		const route = parse("/services/checkout%20api")
		expect(route).toMatchObject({ _tag: "Service", serviceName: "checkout api" })
		expect(hrefOf(route)).toBe("/services/checkout%20api")
	})

	test("uptime routes parse ahead of a rule id and print back", () => {
		expect(parse("/alerts/uptime/new?serviceName=%22api%22")).toMatchObject({
			_tag: "AlertsUptimeNew",
			search: { serviceName: "api" },
		})
		const monitor = parse("/alerts/uptime/upm_abc")
		expect(monitor).toMatchObject({ _tag: "AlertsUptimeMonitor", monitorId: "upm_abc" })
		expect(hrefOf(monitor)).toBe("/alerts/uptime/upm_abc")
	})

	test("SLO routes parse ahead of a rule id and print back", () => {
		expect(parse("/alerts/slos/new?serviceName=%22checkout%22")).toMatchObject({
			_tag: "AlertsSloNew",
			search: { serviceName: "checkout" },
		})
		const slo = parse("/alerts/slos/slo_abc")
		expect(slo).toMatchObject({ _tag: "AlertsSlo", sloId: "slo_abc" })
		expect(hrefOf(slo)).toBe("/alerts/slos/slo_abc")
	})

	test("status page routes parse, the builder ahead of a page id, and print back", () => {
		expect(parse("/status-pages")._tag).toBe("StatusPages")
		expect(parse("/status-pages/new")._tag).toBe("StatusPageNew")
		const route = parse("/status-pages/stp_abc?view=%22settings%22")
		expect(route).toMatchObject({ _tag: "StatusPage", pageId: "stp_abc", search: { view: "settings" } })
		expect(hrefOf(route)).toBe("/status-pages/stp_abc?view=settings")
	})

	test("each Alerts section has its own path, beside the detail pages under it", () => {
		for (const section of ["rules", "uptime", "slos", "silences", "maintenance", "on-call", "routing"]) {
			const route = parse(`/alerts/${section}`)
			expect(route).toMatchObject({ _tag: "AlertsSection", section })
			expect(hrefOf(route)).toBe(`/alerts/${section}`)
		}
		expect(parse("/alerts")._tag).toBe("Alerts")
		expect(hrefOf(parse("/alerts/rules?status=firing"))).toBe("/alerts/rules?status=firing")
		expect(parse("/alerts/uptime/new")._tag).toBe("AlertsUptimeNew")
		expect(parse("/alerts/uptime/mon_1")._tag).toBe("AlertsUptimeMonitor")
		expect(parse("/alerts/slos/slo_1")._tag).toBe("AlertsSlo")
		expect(parse("/alerts/schedules/sch_1")._tag).toBe("AlertsSchedule")
		expect(parse("/alerts/incidents/inc_1")._tag).toBe("AlertIncident")
		expect(parse("/alerts/create")._tag).toBe("AlertsCreate")
		expect(parse("/alerts/rules/0199a001-0000-7000-8000-000000000001")._tag).toBe("AlertRule")
		expect(parse("/alerts/0199a001-0000-7000-8000-000000000001")._tag).toBe("AlertRuleLegacy")
		expect(parse("/alerts/nope")._tag).toBe("NotFound")
	})

	test("an old `?tab=` link replaces itself with its section's path and keeps its other params", () => {
		const redirectOf = (url: string) => Option.map(routeRedirect(parse(url)), (to) => to.url)
		expect(redirectOf("/alerts?tab=rules&status=firing")).toEqual(
			Option.some("/alerts/rules?status=firing"),
		)
		expect(redirectOf("/alerts?tab=%22silences%22&window=mw_1")).toEqual(
			Option.some("/alerts/silences?window=mw_1"),
		)
		expect(redirectOf("/alerts?tab=oncall")).toEqual(Option.some("/alerts/on-call"))
		expect(redirectOf("/alerts?tab=settings")).toEqual(Option.some("/alerts/routing"))
		expect(redirectOf("/alerts?tab=inbox&signal=anomaly")).toEqual(Option.some("/alerts?signal=anomaly"))
		expect(redirectOf("/alerts?tab=overview")).toEqual(Option.some("/alerts"))
		expect(routeRedirect(parse("/alerts?tab=uptime"))).toEqual(
			Option.some({ url: "/alerts/uptime", isReplace: true }),
		)
		// A rule's old address (notifications, the apps) opens it under Rules, keeping its tab and window.
		expect(redirectOf("/alerts/0199a001-0000-7000-8000-000000000001?tab=history&timePreset=7d")).toEqual(
			Option.some("/alerts/rules/0199a001-0000-7000-8000-000000000001?tab=history&timePreset=7d"),
		)
		expect(routeRedirect(parse("/alerts/rules/0199a001-0000-7000-8000-000000000001"))).toEqual(
			Option.none(),
		)
		expect(routeRedirect(parse("/alerts?signal=anomaly"))).toEqual(Option.none())
		expect(routeRedirect(parse("/alerts/rules"))).toEqual(Option.none())
	})

	test("the old status page links under Alerts redirect to their own section", () => {
		expect(routeRedirect(parse("/alerts?tab=%22status-pages%22"))).toEqual(
			Option.some({ url: "/status-pages", isReplace: true }),
		)
		expect(routeRedirect(parse("/alerts/status-pages/stp_abc"))).toEqual(
			Option.some({ url: "/status-pages/stp_abc", isReplace: true }),
		)
		expect(routeRedirect(parse("/alerts/status-pages/stp_abc?tab=%22json%22"))).toEqual(
			Option.some({ url: "/status-pages/stp_abc?view=json", isReplace: true }),
		)
		expect(routeRedirect(parse("/alerts/status-pages/stp_abc?tab=%22incidents%22"))).toEqual(
			Option.some({ url: "/status-pages/stp_abc", isReplace: true }),
		)
	})

	test("the anomalies list opens the Alerts Inbox's Anomalies view, carrying a service and status", () => {
		expect(routeRedirect(parse("/anomalies"))).toEqual(
			Option.some({ url: "/alerts?signal=anomaly", isReplace: true }),
		)
		const narrowed = routeRedirect(
			parse("/anomalies?services=%5B%22checkout%22%5D&status=%22resolved%22"),
		)
		expect(Option.map(narrowed, ({ url }) => parse(url))).toEqual(
			Option.some(
				AppRoute.Alerts({
					search: { signal: "anomaly", serviceName: "checkout", anomalyStatus: "resolved" },
				}),
			),
		)
		// "open" is the view's default, and several services have no one-service filter to land on.
		const several = routeRedirect(parse("/anomalies?services=%5B%22a%22%2C%22b%22%5D&status=%22open%22"))
		expect(Option.map(several, ({ url }) => parse(url))).toEqual(
			Option.some(AppRoute.Alerts({ search: { signal: "anomaly" } })),
		)
		expect(routeRedirect(parse("/anomalies/00000000-0000-4000-8000-000000000004"))).toEqual(Option.none())
	})

	test("old anomalies links with a plain or singular service still land on that service", () => {
		const landing = (path: string) => Option.map(routeRedirect(parse(path)), ({ url }) => parse(url))
		const checkout = Option.some(
			AppRoute.Alerts({ search: { signal: "anomaly", serviceName: "demo-api" } }),
		)
		expect(landing("/anomalies?services=demo-api")).toEqual(checkout)
		expect(landing("/anomalies?service=demo-api")).toEqual(checkout)
		// A value it cannot read is dropped: the view opens unfiltered instead of "Page not found".
		expect(landing("/anomalies?services=%7B%22a%22%3A1%7D&status=nope")).toEqual(
			Option.some(AppRoute.Alerts({ search: { signal: "anomaly" } })),
		)
	})

	test("the old Hazel integration link opens the Hazel chat connector", () => {
		expect(routeRedirect(parse("/integrations?integration=hazel"))).toEqual(
			Option.some({ url: "/integrations?integration=chat-hazel", isReplace: true }),
		)
		expect(routeRedirect(parse("/integrations?integration=chat-hazel"))).toEqual(Option.none())
	})

	test("an org outside the statusPages rollout is sent home from every status page route", () => {
		for (const path of ["/status-pages", "/status-pages/new", "/status-pages/stp_abc"]) {
			expect(flaggedRouteRedirect(parse(path), { statusPages: false })).toEqual(
				Option.some({ url: "/", isReplace: true }),
			)
			expect(flaggedRouteRedirect(parse(path), { statusPages: true })).toEqual(Option.none())
		}
		expect(flaggedRouteRedirect(parse("/services"), { statusPages: false })).toEqual(Option.none())
	})

	test("a literal sibling wins over a param route", () => {
		expect(parse("/infra/hosts")._tag).toBe("InfraHosts")
		expect(parse("/alerts/create")._tag).toBe("AlertsCreate")
		expect(parse("/sources/new")._tag).toBe("SourcesNew")
		expect(parse("/sources/src_abc?tab=%22setup%22")).toMatchObject({
			_tag: "Source",
			sourceId: "src_abc",
			search: { tab: "setup" },
		})
	})

	test("sign-in round-trips its redirect_url", () => {
		const href = hrefOf(AppRoute.SignIn({ search: { redirect_url: "/logs?x=1" } }))
		expect(parse(href)).toMatchObject({ _tag: "SignIn", search: { redirect_url: "/logs?x=1" } })
	})

	test("legacy beforeLoad redirects", () => {
		expect(routeRedirect(parse("/developer?tab=ingestion"))).toEqual(
			Option.some({ url: "/settings?tab=ingestion", isReplace: true }),
		)
		expect(routeRedirect(parse("/errors/issues?workflowState=done&severity=all"))).toEqual(
			Option.some({ url: "/errors?view=closed", isReplace: true }),
		)
		expect(routeRedirect(parse("/infra/discover"))).toEqual(
			Option.some({ url: "/infra", isReplace: true }),
		)
	})

	test("index paths with no page of their own redirect; their detail pages still render", () => {
		expect(routeRedirect(parse("/alerts/incidents"))).toEqual(
			Option.some({ url: "/alerts", isReplace: true }),
		)
		expect(routeRedirect(parse("/recommendations"))).toEqual(
			Option.some({ url: "/settings?tab=ingestion", isReplace: true }),
		)
		expect(parse("/alerts/incidents/inc_1")._tag).toBe("AlertIncident")
		expect(parse("/recommendations/rec_1")._tag).toBe("Recommendation")
	})

	test("a data integration's old page opens its step under Sources; chat connectors stay", () => {
		expect(routeRedirect(parse("/integrations?integration=cloudflare"))).toEqual(
			Option.some({ url: "/sources/new?integration=cloudflare", isReplace: true }),
		)
		expect(routeRedirect(parse("/connectors?tab=prometheus"))).toEqual(
			Option.some({ url: "/sources/new?integration=prometheus", isReplace: false }),
		)
		expect(routeRedirect(parse("/integrations?integration=chat-slack"))).toEqual(Option.none())
		for (const integration of DATA_INTEGRATIONS)
			expect(routeRedirect(parse(`/integrations?integration=${integration}`))).toEqual(
				Option.some({ url: `/sources/new?integration=${integration}`, isReplace: true }),
			)
		expect(routeRedirect(parse("/integrations"))).toEqual(Option.none())
	})

	test("the Security Center's sources, run and finding pages parse to their own routes", () => {
		expect(parse("/security/code")._tag).toBe("SecurityCode")
		expect(parse("/security/code/findings?rejected=true")).toMatchObject({
			_tag: "SecurityCodeFindings",
			search: { rejected: true },
		})
		expect(parse("/security/code/runs")._tag).toBe("SecurityCodeRuns")
		expect(parse("/security/exposure")._tag).toBe("SecurityExposure")
		expect(parse("/security/runtimes")._tag).toBe("SecurityRuntimes")
		expect(parse("/security/dependencies")._tag).toBe("SecurityDependencies")
		expect(parse("/security/dependencies?repo=repo_1")).toMatchObject({
			_tag: "SecurityDependencies",
			search: { repo: "repo_1" },
		})
		expect(parse("/security/code/runs/run_9f3c2a1e7b")).toMatchObject({
			_tag: "SecurityRun",
			runId: "run_9f3c2a1e7b",
		})
		const finding = parse("/security/code/findings/5ec0a0d1-0000-4000-8000-000000000001/exports%2Ftenant")
		expect(finding).toMatchObject({ _tag: "SecurityFinding", fingerprint: "exports/tenant" })
		expect(hrefOf(finding)).toBe(
			"/security/code/findings/5ec0a0d1-0000-4000-8000-000000000001/exports%2Ftenant",
		)
	})

	test("the code audit's old links open the same page under /security/code", () => {
		const redirectOf = (path: string) => Option.map(routeRedirect(parse(path)), ({ url }) => url)
		expect(redirectOf("/security")).toEqual(Option.some("/security/code"))
		expect(redirectOf("/security/findings")).toEqual(Option.some("/security/code/findings"))
		expect(redirectOf("/security/findings?status=%22all%22&q=%22tenant%22")).toEqual(
			Option.some(hrefOf(AppRoute.SecurityCodeFindings({ search: { status: "all", q: "tenant" } }))),
		)
		expect(redirectOf("/security/runs?target=%22tgt_1%22")).toEqual(
			Option.some(hrefOf(AppRoute.SecurityCodeRuns({ search: { target: "tgt_1" } }))),
		)
		expect(redirectOf("/security/runs/run_9f3c2a1e7b")).toEqual(
			Option.some("/security/code/runs/run_9f3c2a1e7b"),
		)
		expect(
			redirectOf("/security/findings/5ec0a0d1-0000-4000-8000-000000000001/exports%2Ftenant"),
		).toEqual(
			Option.some("/security/code/findings/5ec0a0d1-0000-4000-8000-000000000001/exports%2Ftenant"),
		)
		expect(routeRedirect(parse("/security/code"))).toEqual(Option.none())
		expect(routeRedirect(parse("/security/exposure"))).toEqual(Option.none())
	})

	test("an unknown path is NotFound", () => {
		expect(parse("/nope/nope")).toEqual(AppRoute.NotFound({ path: "/nope/nope" }))
	})
})

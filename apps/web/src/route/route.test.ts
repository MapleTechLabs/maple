import { Option } from "effect"
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

	test("status page routes parse, the builder ahead of a page id, and print back", () => {
		expect(parse("/status-pages")._tag).toBe("StatusPages")
		expect(parse("/status-pages/new")._tag).toBe("StatusPageNew")
		const route = parse("/status-pages/stp_abc?view=%22settings%22")
		expect(route).toMatchObject({ _tag: "StatusPage", pageId: "stp_abc", search: { view: "settings" } })
		expect(hrefOf(route)).toBe("/status-pages/stp_abc?view=settings")
	})

	test("the old status page links under Alerts redirect to their own section", () => {
		expect(routeRedirect(parse("/alerts?tab=%22status-pages%22"))).toEqual(
			Option.some({ url: "/status-pages", isReplace: true }),
		)
		expect(routeRedirect(parse("/alerts?tab=%22uptime%22"))).toEqual(Option.none())
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

import { Option } from "effect"
import { fromString } from "foldkit/url"
import { describe, expect, test } from "vitest"
import { DATA_INTEGRATIONS } from "./data-integrations"
import { AppRoute, hrefOf, routeRedirect, urlToAppRoute } from "./index"

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

	test("the Security Center's tabs, run and finding pages parse to their own routes", () => {
		expect(parse("/security")._tag).toBe("Security")
		expect(parse("/security/findings?rejected=true")).toMatchObject({
			_tag: "SecurityFindings",
			search: { rejected: true },
		})
		expect(parse("/security/runs")._tag).toBe("SecurityRuns")
		expect(parse("/security/runs/run_9f3c2a1e7b")).toMatchObject({
			_tag: "SecurityRun",
			runId: "run_9f3c2a1e7b",
		})
		const finding = parse("/security/findings/5ec0a0d1-0000-4000-8000-000000000001/exports%2Ftenant")
		expect(finding).toMatchObject({ _tag: "SecurityFinding", fingerprint: "exports/tenant" })
		expect(hrefOf(finding)).toBe(
			"/security/findings/5ec0a0d1-0000-4000-8000-000000000001/exports%2Ftenant",
		)
	})

	test("an unknown path is NotFound", () => {
		expect(parse("/nope/nope")).toEqual(AppRoute.NotFound({ path: "/nope/nope" }))
	})
})

import { Option } from "effect"
import { fromString } from "foldkit/url"
import { describe, expect, test } from "vitest"
import { AppRoute, hrefOf, routeRedirect, urlToAppRoute } from "./index"

const parse = (path: string) =>
	urlToAppRoute(Option.getOrThrow(fromString(`http://maple.test${path}`)))

describe("routes", () => {
	test("search params decode with TanStack's JSON-per-value format", () => {
		const route = parse('/traces?services=%5B%22api%22%5D&hasError=true&timePreset=7d')
		expect(route).toMatchObject({ _tag: "Traces", search: { services: ["api"], hasError: true, timePreset: "7d" } })
	})

	test("path params are percent-decoded and printed back encoded", () => {
		const route = parse("/services/checkout%20api")
		expect(route).toMatchObject({ _tag: "Service", serviceName: "checkout api" })
		expect(hrefOf(route)).toBe("/services/checkout%20api")
	})

	test("a literal sibling wins over a param route", () => {
		expect(parse("/infra/hosts")._tag).toBe("InfraHosts")
		expect(parse("/alerts/create")._tag).toBe("AlertsCreate")
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
		expect(routeRedirect(parse("/infra/discover"))).toEqual(Option.some({ url: "/infra", isReplace: true }))
	})

	test("an unknown path is NotFound", () => {
		expect(parse("/nope/nope")).toEqual(AppRoute.NotFound({ path: "/nope/nope" }))
	})
})

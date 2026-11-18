import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { redactUrlCredentials, redactWholeUrlSecrets, urlHoldsRedaction } from "./url-redaction"

describe("redactUrlCredentials", () => {
	const redact = (url: string) => redactUrlCredentials(url, "[redacted]")

	it("leaves a URL with nothing to hide as it is", () => {
		expect(redact("https://api.example.com/health")).toBe("https://api.example.com/health")
	})

	it("drops the userinfo and the fragment and hides every query value", () => {
		expect(redact("https://user:p4ss@api.example.com:8443/v1/orders?api_key=s3cret&page=2#frag")).toBe(
			"https://api.example.com:8443/v1/orders?api_key=[redacted]&page=[redacted]",
		)
	})

	it("hides a query part with no name, which may itself be the token", () => {
		expect(redact("https://api.example.com/hook?s3cret")).toBe("https://api.example.com/hook?[redacted]")
	})

	it("keeps the variables of a template, in the path and as the host", () => {
		expect(redact("https://api.example.com/orders/{{order_id}}?token={{token}}")).toBe(
			"https://api.example.com/orders/{{order_id}}?token=[redacted]",
		)
		expect(redact("https://{{host}}/orders?key=abc")).toBe("https://{{host}}/orders?key=[redacted]")
		expect(redact("{{next_url}}")).toBe("{{next_url}}")
	})
})

describe("urlHoldsRedaction", () => {
	const holds = (url: string) => urlHoldsRedaction(url, "[redacted]")

	it("finds the marker a redacted URL carries, plain or percent-encoded", () => {
		expect(holds(redactUrlCredentials("https://api.example.com/health?token=abc", "[redacted]"))).toBe(
			true,
		)
		expect(holds("https://api.example.com/health?token=%5Bredacted%5D&page=2")).toBe(true)
		// However the marker is encoded, it is still the marker and not a token.
		expect(holds("https://api.example.com/health?token=%5bredacted%5d")).toBe(true)
		expect(holds("https://api.example.com/health?token=%5Bredacte%64%5D")).toBe(true)
		expect(holds("https://api.example.com/health?page=2&%5bredacted%5d")).toBe(true)
		expect(holds("https://{{host}}/items?key=[redacted]")).toBe(true)
	})

	it("leaves a real URL alone, the marker in a path included", () => {
		expect(holds("https://api.example.com/health?token=abc")).toBe(false)
		expect(holds("https://api.example.com/[redacted]/health")).toBe(false)
		expect(holds("https://api.example.com/health")).toBe(false)
		// A value whose percent-encoding is malformed is compared as written.
		expect(holds("https://api.example.com/health?token=%E0%A4%A")).toBe(false)
	})
})

describe("redactWholeUrlSecrets", () => {
	it("cuts a bare URL with userinfo, a query or a fragment to scheme, host and path", () => {
		expect(redactWholeUrlSecrets("https://metrics.example.com/metrics?token=s3cret")).toBe(
			"https://metrics.example.com/metrics",
		)
		expect(redactWholeUrlSecrets("https://user:p4ss@db.example.com:9090/m")).toBe(
			"https://db.example.com:9090/m",
		)
		expect(redactWholeUrlSecrets(" http://a.example.com/x#t0k\n")).toBe("http://a.example.com/x")
		expect(redactWholeUrlSecrets("https://{{host}}/orders?key=abc")).toBe("https://{{host}}/orders")
		// One that does not parse cannot be cut, so none of it is kept.
		expect(redactWholeUrlSecrets("https://[::1/orders?key=abc")).toBe("<invalid-url>")
	})

	it("leaves text that only starts with, or contains, a URL exactly as it is", () => {
		const unchanged = [
			"https://docs.example.com/a?b=c\n\n## Steps\n1. Open the page\n2. Check the header",
			"see https://docs.example.com/a?b=c for details",
			"https://metrics.example.com/metrics",
			"status = 500 AND path = '/checkout?step=2'",
			"ftp://user:p4ss@files.example.com/a?b=c",
			"",
		]
		expect(Arr.map(unchanged, redactWholeUrlSecrets)).toEqual(unchanged)
	})
})

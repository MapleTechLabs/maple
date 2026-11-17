import { describe, expect, it } from "vitest"
import { redactUrlCredentials } from "./url-redaction"

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

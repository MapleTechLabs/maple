import { describe, expect, it } from "vitest"
import { isIngestRefusal, summarizeUpstreamBody } from "./upstream-body"

describe("summarizeUpstreamBody", () => {
	it("reduces an HTML challenge page to its title and ray id", () => {
		const page =
			'<!DOCTYPE html>\n<html class="no-js" lang="en-US"><head>\n<title>Just a moment...</title>' +
			"<script>window._cf_chl_opt={}</script></head><body><div>challenge</div></body></html>"
		expect(summarizeUpstreamBody(page, { "cf-ray": "abc123-IAD" })).toBe(
			'HTML response "Just a moment..." (cf-ray abc123-IAD)',
		)
	})

	it("never returns markup for HTML without a title", () => {
		expect(summarizeUpstreamBody("<html><body><h1>Forbidden</h1></body></html>", {})).toBe(
			"HTML response",
		)
	})

	it("keeps a short text body and truncates a long one", () => {
		expect(summarizeUpstreamBody('{"error":"invalid key"}', {})).toBe('{"error":"invalid key"}')
		const summary = summarizeUpstreamBody("x".repeat(5000), {})
		expect(summary.length).toBeLessThan(200)
		expect(summary.endsWith("...")).toBe(true)
	})

	it("names an empty body", () => {
		expect(summarizeUpstreamBody("  \n", {})).toBe("empty body")
	})
})

describe("isIngestRefusal", () => {
	it("treats billing and key refusals as refusals, not transient errors", () => {
		expect([401, 402, 403].every(isIngestRefusal)).toBe(true)
		expect([400, 429, 500, 503].some(isIngestRefusal)).toBe(false)
	})
})

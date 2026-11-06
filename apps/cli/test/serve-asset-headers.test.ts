import { describe, it } from "@effect/vitest"
import { strictEqual } from "node:assert"
import { type AssetResolver, serveAsset } from "@maple/local-server/serve"
import { Option, Array as Arr, String as Str } from "effect"

// The local server hands out the dashboard shell; it must not be frameable or run injected script.
const assets: AssetResolver = (path) =>
	path === "index.html"
		? { body: "<html></html>", contentType: "text/html" }
		: path === "assets/app.js"
			? { body: "export {}", contentType: "text/javascript" }
			: undefined

describe("serveAsset", () => {
	Arr.forEach(["/", "/assets/app.js", "/traces/abc"], (path) =>
		it(`sends the security headers for ${path}`, () => {
			const headers = serveAsset(assets, path).headers
			strictEqual(headers.get("x-frame-options"), "DENY")
			strictEqual(headers.get("x-content-type-options"), "nosniff")
			const csp = headers.get("content-security-policy")
			strictEqual(csp !== null && Str.includes("frame-ancestors 'none'")(csp), true)
			const scriptSrc =
				csp === null
					? undefined
					: Option.getOrUndefined(
							Arr.findFirst(Str.split("; ")(csp), (directive) =>
								Str.startsWith("script-src ")(directive),
							),
						)
			// Same-origin scripts only, plus WebAssembly compilation for the code highlighter.
			strictEqual(scriptSrc, "script-src 'self' 'wasm-unsafe-eval'")
		}),
	)

	it("keeps each asset's own content type", () => {
		strictEqual(serveAsset(assets, "/assets/app.js").headers.get("content-type"), "text/javascript")
		strictEqual(serveAsset(assets, "/traces/abc").headers.get("content-type"), "text/html")
	})
})

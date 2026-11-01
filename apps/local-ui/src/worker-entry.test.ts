import { describe, expect, test } from "vitest"
import worker from "./worker-entry"

// Serves `/index.html` and 404s everything else, like the ASSETS binding for a client route.
const assets = {
	fetch: (request: Request): Promise<Response> =>
		Promise.resolve(
			new URL(request.url).pathname === "/index.html"
				? new Response("<html></html>", { headers: { "content-type": "text/html" } })
				: new Response(null, { status: 404 }),
		),
}

const scriptSrc = (response: Response): string | undefined =>
	response.headers
		.get("content-security-policy")
		?.split("; ")
		.find((directive) => directive.startsWith("script-src "))

describe("local-ui worker", () => {
	;["https://local.maple.dev/index.html", "https://local.maple.dev/traces/abc"].forEach((url) =>
		test(`allows same-origin scripts and WebAssembly only for ${url}`, async () => {
			const response = await worker.fetch(new Request(url), { ASSETS: assets })
			expect(response.headers.get("content-type")).toBe("text/html")
			// The code highlighter compiles a WebAssembly lexer at start-up.
			expect(scriptSrc(response)).toBe("script-src 'self' 'wasm-unsafe-eval'")
		}),
	)
})

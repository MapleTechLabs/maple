import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { sourceSnippets } from "./snippets"

describe("sourceSnippets", () => {
	it("gives the browser SDK snippet the service name init() requires, slugged from the source", () => {
		const [browser] = sourceSnippets("browser", "maple_pk_test", "Marketing Site")
		expect(browser?.code).toContain('serviceName: "marketing-site"')
		expect(browser?.code).toContain('ingestKey: "maple_pk_test"')
	})

	it("gives a Python source everything to start sending: env over HTTP, the install, then the run", () => {
		const snippets = sourceSnippets("python", "maple_src_test", "Billing API")
		expect(Arr.map(snippets, (snippet) => snippet.id)).toEqual(["env", "install", "sdk"])
		const [env, install, run] = snippets
		expect(env?.code).toContain('OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"')
		expect(env?.code).toContain('OTEL_SERVICE_NAME="billing-api"')
		expect(install?.code).toContain("opentelemetry-distro")
		expect(run?.code).toContain("opentelemetry-instrument")
	})
})

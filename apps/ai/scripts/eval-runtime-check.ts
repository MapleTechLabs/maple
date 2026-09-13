/**
 * Validates the full-execution eval wiring WITHOUT an LLM: builds the eval
 * runtime, installs the fake warehouse, and runs `inspect_trace` end-to-end
 * against the 150-span fixture, asserting the bounded-overview note renders.
 *
 *   bun run scripts/eval-runtime-check.ts
 *
 * Exits non-zero on failure. Keep it as a dev utility — the LLM path
 * (execution.eval.ts) only adds tool *selection* on top of what this exercises.
 */
import { installFakeWarehouse, restoreWarehouse } from "@/mcp/__evals__/fake-warehouse"
import { makeEvalRuntime, runToolDirect } from "@/mcp/__evals__/eval-runtime"
import { FIXTURES } from "@/mcp/__evals__/utils"
import { LARGE_TRACE_SPAN_COUNT } from "@/mcp/__evals__/fixtures"

const main = async () => {
	installFakeWarehouse()
	const rt = makeEvalRuntime()
	try {
		const result = await runToolDirect(rt, "inspect_trace", { trace_id: FIXTURES.traceId })
		const text: string = (result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n")

		const expected = `of ${LARGE_TRACE_SPAN_COUNT} spans (errors and longest first)`
		const checks: Array<[string, boolean]> = [
			["renders Showing note", text.includes("Showing")],
			[`reports "${expected}"`, text.includes(expected)],
			["surfaces span ids", text.includes("span=")],
			["not an error result", result?.isError !== true],
		]

		console.log(text.split("\n").slice(0, 12).join("\n"))
		console.log("\n--- checks ---")
		let ok = true
		for (const [label, passed] of checks) {
			console.log(`${passed ? "✓" : "✗"} ${label}`)
			ok &&= passed
		}
		if (!ok) {
			console.error("\neval-runtime-check FAILED")
			process.exitCode = 1
		} else {
			console.log("\neval-runtime-check OK")
		}
	} finally {
		restoreWarehouse()
		await rt.dispose()
	}
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})

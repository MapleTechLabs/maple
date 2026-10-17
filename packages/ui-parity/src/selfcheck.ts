import { chromium } from "playwright"
import { BROWSER_LAUNCH_OPTIONS, type CaptureVariant, captureTarget } from "./capture.ts"
import type { FixtureBackend } from "./contract.ts"
import { compareRun, isUnhealthy } from "./report.ts"

/**
 * Captures one build twice and diffs the two: anything not identical (or sub-perceptual `pass`)
 * is flakiness in the harness or the app, and a flaky scenario cannot tell whether a port is right.
 */
export const selfcheck = async (input: {
	readonly build: string
	readonly run: string
	readonly variants: ReadonlyArray<CaptureVariant>
	readonly backend: FixtureBackend | null
}) => {
	const browser = await chromium.launch(BROWSER_LAUNCH_OPTIONS)
	const capture = (label: string) =>
		captureTarget({
			build: input.build,
			label,
			run: input.run,
			variants: input.variants,
			backend: input.backend,
			browser,
		})
	const first = await capture(`${input.build}-1`)
	const second = await capture(`${input.build}-2`)
	await browser.close()
	const summary = compareRun({
		run: input.run,
		baselineLabel: `${input.build}-1`,
		candidateLabel: `${input.build}-2`,
		variants: input.variants,
		baselineResults: first,
		candidateResults: second,
	})
	// Pixel flakiness only: an unhealthy capture is reported below, not as nondeterminism.
	const flaky = summary.variants.filter(
		({ comparison }) => comparison.visualStatus === "fail" || comparison.visualStatus === "missing",
	)
	const behaviorFlaky = summary.variants.filter(({ comparison }) => comparison.behavior.length > 0)
	const unhealthy = [...first, ...second].filter(isUnhealthy)
	console.log(
		flaky.length
			? `\nFLAKY: ${flaky.map((entry) => entry.variant.id).join(", ")}`
			: `\nAll ${summary.variants.length} variants deterministic.`,
	)
	if (behaviorFlaky.length)
		console.log(
			`call logs differ between runs: ${behaviorFlaky.map((entry) => entry.variant.id).join(", ")}`,
		)
	for (const result of unhealthy)
		console.log(
			`unhealthy ${result.variantId}: ${[
				result.error,
				...result.consoleErrors.slice(0, 2),
				result.unmocked.length ? `unmocked ${result.unmocked.slice(0, 4).join(", ")}` : undefined,
			]
				.filter(Boolean)
				.join(" | ")}`,
		)
	return {
		deterministic: flaky.length === 0 && behaviorFlaky.length === 0,
		healthy: unhealthy.length === 0,
	}
}

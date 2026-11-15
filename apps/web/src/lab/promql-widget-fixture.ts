import type { PromqlQueryResult } from "@maple/query-engine"
import { Array as Arr } from "effect"

// Request rate per service over the last hour at a 30s step, as the engine returns a range query.

const STEP_MS = 30_000
const STEPS = 121

const SERVICES = [
	{ job: "checkout", base: 42, swing: 9, phase: 0 },
	{ job: "api-gateway", base: 118, swing: 22, phase: 1.3 },
	{ job: "payments", base: 17, swing: 5, phase: 2.1 },
] as const

export const promqlLabResult = (nowMs: number): PromqlQueryResult => {
	const endMs = Math.floor(nowMs / STEP_MS) * STEP_MS
	const startMs = endMs - (STEPS - 1) * STEP_MS
	return {
		resultType: "matrix",
		result: Arr.map(SERVICES, ({ job, base, swing, phase }) => ({
			labels: { job, instance: `${job}-0` },
			points: Arr.makeBy(STEPS, (i) => ({
				t: startMs + i * STEP_MS,
				v:
					Math.round(
						(base + swing * Math.sin(i / 9 + phase) + (swing / 3) * Math.sin(i / 2.3)) * 100,
					) / 100,
			})),
		})),
	}
}

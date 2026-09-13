// oxlint-disable effecttsgo/strict-effect-provide -- Offline benchmark entry point.
/** A concurrent flush fixture; export CPU is measured separately from span creation. */
import { Effect } from "effect"
import { make } from "../../../../packages/effect-sdk/src/cloudflare/index"
export const prepare = async (count = 200) => {
	const telemetry = make({ serviceName: "cpu-probe" })
	const env = { MAPLE_INGEST_KEY: "offline", MAPLE_ENDPOINT: "https://collector.invalid" }
	for (let i = 0; i < count; i++) {
		await Effect.runPromise(
			Effect.void.pipe(Effect.withSpan(`probe-${i}`), Effect.provide(telemetry.layer)),
		)
	}
	return () => Promise.all(Array.from({ length: count }, () => telemetry.flush(env)))
}
export default {}

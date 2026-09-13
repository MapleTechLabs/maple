import { Effect } from "effect"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"

/**
 * Which telemetry signals this org is actually sending.
 *
 * A module-level singleton on purpose: nearly every view can ask for this, and they must share one
 * fetch. It is also the cheapest read in the app — traces, logs and metrics come from an hourly
 * rollup — so the cost of it being everywhere is close to nothing.
 *
 * Not polled. Presence changes once, when a user finishes wiring a signal up, and the surfaces that
 * care about that moment (the Connect panel, the setup checklist) run their own live poll. Everything
 * else reads the answer that was true when the page loaded, which is the right answer for advice.
 */
export const telemetrySignalsAtom = MapleApiV2AtomClient.runtime.atom(
	Effect.gen(function* () {
		const client = yield* MapleApiV2AtomClient
		return yield* client.telemetrySignals.retrieve()
	}),
)

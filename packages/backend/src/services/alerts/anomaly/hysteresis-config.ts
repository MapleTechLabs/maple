// Hysteresis tuning for the zero-config anomaly detector.
//
// The mechanic lives in `@maple/alerting-core/hysteresis`. A detector nobody
// opted into needs a re-open cooldown that user rules, whose thresholds a human
// chose, do not.

import type { AnomalySignalType } from "@maple/domain/http"

import type { HysteresisConfig } from "@maple/alerting-core/hysteresis"

const DEFAULT_HYSTERESIS_CONFIG: HysteresisConfig = {
	breachesToOpen: 2,
	healthyToResolve: 3,
	cooldownMs: 60 * 60 * 1000,
}

/**
 * Per-signal overrides. Throughput outages need an extra breaching tick (15
 * min sustained), but resolve as soon as traffic returns. The one-hour
 * cooldown still prevents an edge-of-threshold series from flapping.
 */
const OVERRIDES: Partial<Record<AnomalySignalType, Partial<HysteresisConfig>>> = {
	throughput: { breachesToOpen: 3, healthyToResolve: 1 },
} satisfies Partial<Record<AnomalySignalType, Partial<HysteresisConfig>>>

/**
 * Each reopen adds one more resolve window, up to three: an incident that keeps
 * flapping stays open through short dips instead of resolving and reopening
 * (and paging) every hour. Capped below the no-data sweep's hour, which
 * resolves an incident with no breach in the last 60 minutes.
 */
const MAX_RESOLVE_MULTIPLIER = 3

export const hysteresisConfigFor = (signalType: AnomalySignalType, reopenCount: number): HysteresisConfig => {
	const config = { ...DEFAULT_HYSTERESIS_CONFIG, ...OVERRIDES[signalType] }
	return {
		...config,
		healthyToResolve: config.healthyToResolve * Math.min(1 + reopenCount, MAX_RESOLVE_MULTIPLIER),
	}
}

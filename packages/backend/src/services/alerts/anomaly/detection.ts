// Anomaly detection math — pure functions, no I/O.
//
// Baseline model: seasonal-naive. The current observation is the last 60 minutes;
// each baseline sample is that window on one of the 7 previous days, shifted -1/0/+1
// hour (`windowBaseline`). Robust bands via median/MAD with a sigma floor.
//
// Error/latency breaches require statistical, ratio, absolute-delta, and
// volume guards. Throughput is deliberately stricter: only a near-total loss
// of a historically continuous traffic stream is service-health evidence.

import type { AnomalyIncidentSeverity, AnomalySensitivity, AnomalySignalType } from "@maple/domain/http"
import { Array as Arr, DateTime, String as Str } from "effect"

export interface AnomalyEvaluation {
	readonly detectorKey: string
	readonly signalType: AnomalySignalType
	readonly serviceName: string
	readonly deploymentEnv: string
	readonly fingerprintHash: string | null
	readonly status: "breached" | "healthy" | "skipped"
	readonly value: number
	readonly baselineMedian: number
	readonly baselineSigma: number
	readonly threshold: number
	/**
	 * Always an integer. Volume counts are sample-weighted (`sum(SampleRate)`), so
	 * they arrive fractional from the warehouse — and `anomaly_detector_states`
	 * / `anomaly_incidents` store them in `integer` columns, which rejects
	 * `6102857.511138143` outright. Rounded at every construction site below so
	 * the invariant holds for every consumer, not just the ones that remember.
	 */
	readonly sampleCount: number
	readonly severity: AnomalyIncidentSeverity
}

export interface SensitivityConfig {
	/** Robust z multiplier on the MAD-derived sigma. */
	readonly k: number
	/** Multiplicative ratio guard vs the baseline median. */
	readonly ratio: number
}

export const SENSITIVITY: Record<AnomalySensitivity, SensitivityConfig> = {
	low: { k: 6, ratio: 3.0 },
	normal: { k: 4, ratio: 2.0 },
	high: { k: 3, ratio: 1.5 },
} satisfies Record<AnomalySensitivity, SensitivityConfig>

/** Minimum sealed baseline samples before a series is evaluated at all. */
const MIN_BASELINE_SAMPLES = 6

const MAD_TO_SIGMA = 1.4826

const HOUR_MS = 60 * 60 * 1000

export function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	const upper = sorted[mid]
	if (upper === undefined) return 0
	const lower = sorted[mid - 1]
	return sorted.length % 2 === 0 && lower !== undefined ? (lower + upper) / 2 : upper
}

export function mad(values: readonly number[], m: number): number {
	if (values.length === 0) return 0
	return median(Arr.map(values, (v) => Math.abs(v - m)))
}

/**
 * MAD-derived sigma with absolute and relative floors. A constant series has
 * MAD = 0; without the floor any uptick would breach the statistical bound.
 */
export function robustSigma(
	values: readonly number[],
	m: number,
	epsilonAbs: number,
	epsilonRel: number,
): number {
	return Math.max(MAD_TO_SIGMA * mad(values, m), epsilonAbs, epsilonRel * m)
}

/** One maintenance window's hold on baselines, as plain data so this module stays I/O-free. */
export interface BaselineExclusion {
	/** Whether the window covers this (service, environment) series. */
	readonly covers: (serviceName: string, deploymentEnv: string) => boolean
	/** Epoch-ms [start, end) occurrences; a baseline hour overlapping one is dropped. */
	readonly ranges: ReadonlyArray<{ readonly startsAtMs: number; readonly endsAtMs: number }>
}

export interface BaselineHourRow {
	readonly hourMs: number
	readonly serviceName: string
	readonly deploymentEnv: string
}

export const isBaselineHourExcluded = (
	exclusions: ReadonlyArray<BaselineExclusion>,
	row: BaselineHourRow,
): boolean =>
	Arr.some(
		exclusions,
		(exclusion) =>
			exclusion.covers(row.serviceName, row.deploymentEnv) &&
			Arr.some(
				exclusion.ranges,
				(range) => row.hourMs < range.endsAtMs && range.startsAtMs < row.hourMs + HOUR_MS,
			),
	)

/** Drops sealed baseline hours under maintenance; a series left too thin is skipped as usual. */
export const excludeMaintenanceHours = <R extends BaselineHourRow>(
	rows: ReadonlyArray<R>,
	exclusions: ReadonlyArray<BaselineExclusion>,
): ReadonlyArray<R> =>
	exclusions.length === 0 ? rows : Arr.filter(rows, (row) => !isBaselineHourExcluded(exclusions, row))

const NON_PRODUCTION_TOKENS = new Set([
	"dev",
	"develop",
	"development",
	"local",
	"localhost",
	"test",
	"testing",
	"qa",
	"uat",
	"staging",
	"stage",
	"stg",
	"pre",
	"preprod",
	"preview",
	"review",
	"sandbox",
	"demo",
	"debug",
	"ci",
	"e2e",
])

/**
 * Whether a `deployment.environment` name reads as non-production (`staging`, `dev-eu`, `pr-123`...).
 * An empty or unrecognised name counts as production: many apps never set the attribute.
 */
export function isNonProductionEnvironment(deploymentEnv: string): boolean {
	const tokens = Str.split(Str.toLowerCase(deploymentEnv), /[^a-z0-9]+/)
	return Arr.some(
		tokens,
		(token, i) =>
			NON_PRODUCTION_TOKENS.has(token) ||
			/^pr\d+$/.test(token) ||
			(token === "pr" && /^\d+$/.test(tokens[i + 1] ?? "")),
	)
}

/** Whether the detector evaluates `deploymentEnv`, given the org's opted-in environments (case-insensitive). */
export const isWatchedEnvironment = (deploymentEnv: string, included: ReadonlyArray<string>): boolean =>
	!isNonProductionEnvironment(deploymentEnv) ||
	Arr.some(included, (name) => Str.toLowerCase(name) === Str.toLowerCase(deploymentEnv))

/** Hour-of-day values the blended baseline reads for the window ending at `nowMs`. */
export function baselineHoursOfDay(nowMs: number): readonly number[] {
	const h = DateTime.getPartUtc(DateTime.makeUnsafe(nowMs), "hour")
	return [(h + 22) % 24, (h + 23) % 24, h, (h + 1) % 24]
}

export interface BaselineWindows<S> {
	/** The window on each of the previous 7 days, shifted by -1, 0 and +1 hour (≤21). */
	readonly all: S[]
	/** The unshifted window on each of the previous 7 days (≤7): what this time of day usually looks like. */
	readonly sameTime: S[]
}

/**
 * Baseline windows for the 60 minutes ending at `nowMs`, each blended from the two sealed hourly rows
 * it straddles. A window counts only when both hours had traffic.
 */
export function windowBaseline<T, S>(
	hours: ReadonlyMap<number, T>,
	nowMs: number,
	blend: (earlier: T, later: T, f: number) => S,
): BaselineWindows<S> {
	const hourStart = Math.floor(nowMs / HOUR_MS) * HOUR_MS
	const f = (nowMs - hourStart) / HOUR_MS
	const all: S[] = []
	const sameTime: S[] = []
	for (let day = 1; day <= 7; day++) {
		for (const shift of [-1, 0, 1]) {
			const later = hourStart + (shift - day * 24) * HOUR_MS
			const a = hours.get(later - HOUR_MS)
			const b = hours.get(later)
			if (a === undefined || b === undefined) continue
			const sample = blend(a, b, f)
			all.push(sample)
			if (shift === 0) sameTime.push(sample)
		}
	}
	return { all, sameTime }
}

export interface GoldenHour {
	readonly requestCount: number
	readonly errorCount: number
	readonly p95Ms: number
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f

/** Share of the previous hour that the 60-minute window ending at `nowMs` still covers. */
const previousHourShare = (nowMs: number) => 1 - (nowMs % HOUR_MS) / HOUR_MS

/** Counts blend by the window's share of each hour; a p95 cannot be averaged, so it is the hour with most of the window's requests. */
export const blendGoldenHours = (a: GoldenHour, b: GoldenHour, f: number): GoldenHour => ({
	requestCount: lerp(a.requestCount, b.requestCount, f),
	errorCount: lerp(a.errorCount, b.errorCount, f),
	p95Ms: a.requestCount * (1 - f) > b.requestCount * f ? a.p95Ms : b.p95Ms,
})

/** The last 60 minutes from hourly rows: the in-progress hour plus the covered share of the previous one. */
export const goldenWindowFromHours = (
	previous: GoldenHour | undefined,
	inProgress: GoldenHour | undefined,
	nowMs: number,
): GoldenHour => {
	const share = previousHourShare(nowMs)
	return {
		requestCount: (previous?.requestCount ?? 0) * share + (inProgress?.requestCount ?? 0),
		errorCount: (previous?.errorCount ?? 0) * share + (inProgress?.errorCount ?? 0),
		// The hour holding most of the window's requests; percentiles do not average.
		p95Ms:
			previous === undefined ||
			(inProgress !== undefined && inProgress.requestCount >= previous.requestCount * share)
				? (inProgress?.p95Ms ?? 0)
				: previous.p95Ms,
	}
}

export const logWindowFromHours = (
	previous: { readonly errorLogCount: number } | undefined,
	inProgress: { readonly errorLogCount: number } | undefined,
	nowMs: number,
): { readonly errorLogCount: number } => ({
	errorLogCount:
		(previous?.errorLogCount ?? 0) * previousHourShare(nowMs) + (inProgress?.errorLogCount ?? 0),
})

export const blendLogHours = (
	a: { readonly errorLogCount: number },
	b: { readonly errorLogCount: number },
	f: number,
): { readonly errorLogCount: number } => ({ errorLogCount: lerp(a.errorLogCount, b.errorLogCount, f) })

// Input shapes (rows already split into current vs baseline by the caller)

export interface GoldenSignalSeries {
	readonly serviceName: string
	readonly deploymentEnv: string
	/** Aggregates over the last {@link CURRENT_WINDOW_MINUTES} minutes. */
	readonly current: { requestCount: number; errorCount: number; p95Ms: number }
	/** One entry per baseline window (see `windowBaseline`). */
	readonly baseline: ReadonlyArray<{ requestCount: number; errorCount: number; p95Ms: number }>
	/** The unshifted windows of `baseline`: this time of day on previous days. */
	readonly sameTime: ReadonlyArray<{ requestCount: number; errorCount: number; p95Ms: number }>
}

export interface LogVolumeSeries {
	readonly serviceName: string
	readonly deploymentEnv: string
	/** Error logs over the last {@link CURRENT_WINDOW_MINUTES} minutes. */
	readonly current: { errorLogCount: number }
	readonly baseline: ReadonlyArray<{ errorLogCount: number }>
	readonly sameTime: ReadonlyArray<{ errorLogCount: number }>
}

/**
 * Bound per-org work to the busiest log series — the same rule the golden
 * path applies inline. The input arrives in ClickHouse GROUP BY order, which
 * is arbitrary: slicing it unsorted would drop busy (or already-anomalous)
 * series nondeterministically, and a dropped open series never refreshes
 * `lastTriggeredAt`, so the no-data sweep would falsely resolve it.
 */
export const capBusiestLogSeries = (
	series: ReadonlyArray<LogVolumeSeries>,
	max: number,
): ReadonlyArray<LogVolumeSeries> =>
	[...series]
		.sort(
			(a, b) =>
				Math.max(b.current.errorLogCount, b.baseline.length) -
				Math.max(a.current.errorLogCount, a.baseline.length),
		)
		.slice(0, max)

export interface ErrorSpikeObservation {
	readonly fingerprintHash: string
	readonly serviceName: string
	readonly deploymentEnv: string
	/** Occurrences in the current 30-minute window. */
	readonly count: number
}

export interface ErrorSpikeBaseline {
	readonly totalCount: number
}

export interface DetectionConfig {
	readonly sensitivity: SensitivityConfig
}

/** Length of the current observation window, in minutes. */
export const CURRENT_WINDOW_MINUTES = 60

const detectorKeyFor = (signalType: AnomalySignalType, deploymentEnv: string, subject: string): string =>
	`${signalType}:${deploymentEnv}:${subject}`

const skipped = (
	signalType: AnomalySignalType,
	serviceName: string,
	deploymentEnv: string,
	value: number,
	sampleCount: number,
	fingerprintHash: string | null = null,
): AnomalyEvaluation => ({
	detectorKey: detectorKeyFor(signalType, deploymentEnv, fingerprintHash ?? serviceName),
	signalType,
	serviceName,
	deploymentEnv,
	fingerprintHash,
	status: "skipped",
	value,
	baselineMedian: 0,
	baselineSigma: 0,
	threshold: 0,
	sampleCount: Math.round(sampleCount),
	severity: "warning",
})

/** Minimum weighted request count in the current window before evaluating. */
const GOLDEN_MIN_VOLUME = 50
/** Same-time-of-day windows needed to raise a threshold: a daily job's spike is the series' normal. */
const SAME_TIME_MIN_SAMPLES = 4
/** An error-rate breach needs this many errors in the window, not only a rate: 2 of 50 is 4%. */
const ERROR_RATE_MIN_ERRORS = 5
/** A p95 rise smaller than this is not a health problem, however large the ratio. */
const LATENCY_MIN_RISE_MS = 100
/** A latency anomaly is critical only when p95 is 4x the baseline and this much slower. */
const LATENCY_CRITICAL_RISE_MS = 500
/** Minimum baseline requests per minute before a drop is evaluable: below it an empty hour looks quiet. */
const THROUGHPUT_MIN_BASELINE_RPM = 1
/**
 * A missing hourly aggregate means the service had no traffic in that hour;
 * it is not emitted as a zero-valued row. Require coverage across at least
 * two-thirds of the 21 matched baseline hours before treating a service as
 * continuously active and therefore eligible for outage detection.
 */
const THROUGHPUT_MIN_BASELINE_SAMPLES = 14
/** Only a near-total loss of an established traffic stream is a health issue. */
const THROUGHPUT_OUTAGE_FRACTION = 0.05

interface Band {
	readonly median: number
	readonly sigma: number
	readonly threshold: number
}

interface BandSpec {
	readonly sigmaFloorAbs: number
	readonly sigmaFloorRel: number
	readonly thresholdOf: (median: number, sigma: number) => number
}

const bandOf = (values: number[], spec: BandSpec): Band => {
	const m = median(values)
	const sigma = robustSigma(values, m, spec.sigmaFloorAbs, spec.sigmaFloorRel)
	return { median: m, sigma, threshold: spec.thresholdOf(m, sigma) }
}

/** The full baseline's band, its threshold raised to what this time of day on previous days allows. */
const seasonalBand = (all: number[], sameTime: number[], spec: BandSpec): Band => {
	const band = bandOf(all, spec)
	return sameTime.length < SAME_TIME_MIN_SAMPLES
		? band
		: { ...band, threshold: Math.max(band.threshold, bandOf(sameTime, spec).threshold) }
}

type GoldenRows = GoldenSignalSeries["baseline"]
const errorRates = (rows: GoldenRows): number[] =>
	Arr.map(
		Arr.filter(rows, (b) => b.requestCount > 0),
		(b) => b.errorCount / b.requestCount,
	)
const latencies = (rows: GoldenRows): number[] =>
	Arr.map(
		Arr.filter(rows, (b) => b.requestCount > 0),
		(b) => b.p95Ms,
	)

export function evaluateGoldenSignals(
	series: GoldenSignalSeries,
	config: DetectionConfig,
): AnomalyEvaluation[] {
	const { serviceName, deploymentEnv, current, baseline, sameTime } = series
	const { k, ratio } = config.sensitivity
	const evaluations: AnomalyEvaluation[] = []

	const makeEval = (
		signalType: AnomalySignalType,
		value: number,
		m: number,
		sigma: number,
		threshold: number,
		breached: boolean,
		severity: AnomalyIncidentSeverity,
		sampleCount: number,
	): AnomalyEvaluation => ({
		detectorKey: detectorKeyFor(signalType, deploymentEnv, serviceName),
		signalType,
		serviceName,
		deploymentEnv,
		fingerprintHash: null,
		status: breached ? "breached" : "healthy",
		value,
		baselineMedian: m,
		baselineSigma: sigma,
		threshold,
		sampleCount: Math.round(sampleCount),
		severity,
	})

	const insufficientBaseline = baseline.length < MIN_BASELINE_SAMPLES
	const currentCount = current.requestCount

	{
		const signal: AnomalySignalType = "error_rate"
		if (insufficientBaseline || currentCount < GOLDEN_MIN_VOLUME) {
			evaluations.push(
				skipped(
					signal,
					serviceName,
					deploymentEnv,
					currentCount > 0 ? current.errorCount / currentCount : 0,
					currentCount,
				),
			)
		} else {
			const rates = errorRates(baseline)
			if (rates.length < MIN_BASELINE_SAMPLES) {
				evaluations.push(skipped(signal, serviceName, deploymentEnv, 0, currentCount))
			} else {
				const value = current.errorCount / currentCount
				const {
					median: m,
					sigma,
					threshold,
				} = seasonalBand(rates, errorRates(sameTime), {
					sigmaFloorAbs: 0.005,
					sigmaFloorRel: 0.25,
					thresholdOf: (mx, sx) => Math.max(mx + k * sx, mx * ratio, mx + 0.02, 0.01),
				})
				const breached = value > threshold && current.errorCount >= ERROR_RATE_MIN_ERRORS
				const severity: AnomalyIncidentSeverity =
					value >= Math.max(3 * m, m + 0.1) ? "critical" : "warning"
				evaluations.push(
					makeEval(signal, value, m, sigma, threshold, breached, severity, currentCount),
				)
			}
		}
	}

	{
		const signal: AnomalySignalType = "latency_p95"
		if (insufficientBaseline || currentCount < GOLDEN_MIN_VOLUME) {
			evaluations.push(skipped(signal, serviceName, deploymentEnv, current.p95Ms, currentCount))
		} else {
			const p95s = latencies(baseline)
			if (p95s.length < MIN_BASELINE_SAMPLES) {
				evaluations.push(skipped(signal, serviceName, deploymentEnv, current.p95Ms, currentCount))
			} else {
				const value = current.p95Ms
				const {
					median: m,
					sigma,
					threshold,
				} = seasonalBand(p95s, latencies(sameTime), {
					sigmaFloorAbs: 5,
					sigmaFloorRel: 0.1,
					thresholdOf: (mx, sx) =>
						Math.max(mx + k * sx, mx * (1 + (ratio - 1) / 2), mx + LATENCY_MIN_RISE_MS),
				})
				const breached = value > threshold
				const severity: AnomalyIncidentSeverity =
					m > 0 && value >= 4 * m && value - m >= LATENCY_CRITICAL_RISE_MS ? "critical" : "warning"
				evaluations.push(
					makeEval(signal, value, m, sigma, threshold, breached, severity, currentCount),
				)
			}
		}
	}

	{
		const signal: AnomalySignalType = "throughput"
		const ratePerMin = currentCount / CURRENT_WINDOW_MINUTES
		const rates = Arr.map(baseline, (b) => b.requestCount / 60)
		const m = median(rates)
		const sigma = robustSigma(rates, m, 0.5, 0.1)
		const threshold = m * THROUGHPUT_OUTAGE_FRACTION
		const hasContinuousBaseline = baseline.length >= THROUGHPUT_MIN_BASELINE_SAMPLES
		const hasEnoughExpectedTraffic = m >= THROUGHPUT_MIN_BASELINE_RPM
		const breached = hasContinuousBaseline && hasEnoughExpectedTraffic && ratePerMin < threshold

		// An ineligible series is healthy for this signal, not skipped, so an
		// incident opened under stricter-looking data can still recover.
		evaluations.push(makeEval(signal, ratePerMin, m, sigma, threshold, breached, "warning", currentCount))
	}

	return evaluations
}

// Log volume (error-class severities)

const LOG_MIN_VOLUME = 30

export function evaluateLogVolume(series: LogVolumeSeries, config: DetectionConfig): AnomalyEvaluation {
	const signal: AnomalySignalType = "log_volume"
	const { serviceName, deploymentEnv, current, baseline, sameTime } = series
	const { k, ratio } = config.sensitivity

	const ratePerMin = current.errorLogCount / CURRENT_WINDOW_MINUTES

	if (baseline.length < MIN_BASELINE_SAMPLES || current.errorLogCount < LOG_MIN_VOLUME) {
		return skipped(signal, serviceName, deploymentEnv, ratePerMin, current.errorLogCount)
	}

	const perMinute = (rows: LogVolumeSeries["baseline"]) => Arr.map(rows, (b) => b.errorLogCount / 60)
	const {
		median: m,
		sigma,
		threshold,
	} = seasonalBand(perMinute(baseline), perMinute(sameTime), {
		sigmaFloorAbs: 0.5,
		sigmaFloorRel: 0.25,
		thresholdOf: (mx, sx) => Math.max(mx + k * sx, mx * ratio, mx + LOG_MIN_VOLUME / 60),
	})
	const breached = ratePerMin > threshold

	return {
		detectorKey: detectorKeyFor(signal, deploymentEnv, serviceName),
		signalType: signal,
		serviceName,
		deploymentEnv,
		fingerprintHash: null,
		status: breached ? "breached" : "healthy",
		value: ratePerMin,
		baselineMedian: m,
		baselineSigma: sigma,
		threshold,
		sampleCount: Math.round(current.errorLogCount),
		severity: "warning",
	}
}

// Error fingerprint spikes (Poisson-flavored — counts are small)

/** Half-hour windows in 7 days. */
const HALF_HOURS_PER_WEEK = 336
export const ERROR_SPIKE_MIN_COUNT = 20
/** Fingerprints younger than this stay with ErrorsService first_seen handling. */
const SPIKE_MIN_ISSUE_AGE_MS = 24 * 60 * 60 * 1000

export interface ErrorSpikeConfig {
	readonly sensitivity: SensitivityConfig
	/** firstSeenAt (epoch ms) per fingerprintHash, from error_issues. */
	readonly issueFirstSeenAt: ReadonlyMap<string, number>
	readonly nowMs: number
}

export function evaluateErrorSpike(
	observation: ErrorSpikeObservation,
	baseline: ErrorSpikeBaseline | undefined,
	config: ErrorSpikeConfig,
): AnomalyEvaluation {
	const signal: AnomalySignalType = "error_spike"
	const { fingerprintHash, serviceName, deploymentEnv, count } = observation

	const firstSeenAt = config.issueFirstSeenAt.get(fingerprintHash)
	const tooYoung = firstSeenAt !== undefined && config.nowMs - firstSeenAt < SPIKE_MIN_ISSUE_AGE_MS
	if (baseline === undefined || tooYoung || count < ERROR_SPIKE_MIN_COUNT) {
		return skipped(signal, serviceName, deploymentEnv, count, count, fingerprintHash)
	}

	// Spike ratio guard scales with sensitivity: 4× at normal (ratio 2.0).
	const ratioGuard = config.sensitivity.ratio * 2
	const lambda = baseline.totalCount / HALF_HOURS_PER_WEEK
	const threshold = Math.max(
		lambda + Math.max(3 * Math.sqrt(lambda), ERROR_SPIKE_MIN_COUNT),
		lambda * ratioGuard,
		ERROR_SPIKE_MIN_COUNT,
	)
	const breached = count > threshold

	return {
		detectorKey: detectorKeyFor(signal, deploymentEnv, fingerprintHash),
		signalType: signal,
		serviceName,
		deploymentEnv,
		fingerprintHash,
		status: breached ? "breached" : "healthy",
		value: count,
		baselineMedian: lambda,
		baselineSigma: Math.sqrt(Math.max(lambda, 1)),
		threshold,
		sampleCount: Math.round(count),
		severity: count >= threshold * 3 ? "critical" : "warning",
	}
}

/**
 * Recovery evaluation for a fingerprint that already owns an open incident.
 *
 * The absolute event floor is an opening/noise guard, not evidence that an
 * existing incident is still firing. Once the fingerprint drops below the
 * floor (including disappearing from the current query entirely), emit a
 * healthy evaluation so normal hysteresis can resolve it.
 */
export function healthyErrorSpikeRecovery(
	observation: ErrorSpikeObservation,
	baselineMedian: number,
	config: Pick<ErrorSpikeConfig, "sensitivity">,
): AnomalyEvaluation {
	const ratioGuard = config.sensitivity.ratio * 2
	const threshold = Math.max(
		baselineMedian + Math.max(3 * Math.sqrt(baselineMedian), ERROR_SPIKE_MIN_COUNT),
		baselineMedian * ratioGuard,
		ERROR_SPIKE_MIN_COUNT,
	)

	return {
		detectorKey: detectorKeyFor("error_spike", observation.deploymentEnv, observation.fingerprintHash),
		signalType: "error_spike",
		serviceName: observation.serviceName,
		deploymentEnv: observation.deploymentEnv,
		fingerprintHash: observation.fingerprintHash,
		status: "healthy",
		value: observation.count,
		baselineMedian,
		baselineSigma: Math.sqrt(Math.max(baselineMedian, 1)),
		threshold,
		sampleCount: Math.round(observation.count),
		severity: "warning",
	}
}

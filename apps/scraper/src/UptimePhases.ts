import { Context, Effect, Array as Arr, Record as Rec } from "effect"
import type { UptimeCertificate } from "@maple/domain/uptime"

/** Where an HTTP check spent its time, in ms; null for a phase that never happened (TLS on http://). */
export interface PhaseTimings {
	readonly dnsMs: number | null
	readonly connectMs: number | null
	readonly tlsMs: number | null
	readonly ttfbMs: number | null
	readonly transferMs: number | null
}

export const NO_PHASES: PhaseTimings = {
	dnsMs: null,
	connectMs: null,
	tlsMs: null,
	ttfbMs: null,
	transferMs: null,
}

const plus = (a: number | null, b: number | null | undefined): number | null =>
	b === null || b === undefined ? a : (a ?? 0) + b

/** Phases summed across hops, so a redirect's DNS, connect and wait count toward the check. */
export const addPhases = (total: PhaseTimings, hop: Partial<PhaseTimings>): PhaseTimings => ({
	dnsMs: plus(total.dnsMs, hop.dnsMs),
	connectMs: plus(total.connectMs, hop.connectMs),
	tlsMs: plus(total.tlsMs, hop.tlsMs),
	ttfbMs: plus(total.ttfbMs, hop.ttfbMs),
	transferMs: plus(total.transferMs, hop.transferMs),
})

export const hasPhases = (timings: PhaseTimings): boolean =>
	Arr.some(Rec.values(timings), (value) => value !== null)

/**
 * Where the resolver and the transport report a hop's phases. The HTTP probe provides one per
 * check; outside a check the phases go nowhere.
 */
export const PhaseRecorder = Context.Reference<(phases: Partial<PhaseTimings>) => Effect.Effect<void>>(
	"@maple/scraper/PhaseRecorder",
	{ defaultValue: () => () => Effect.void },
)

export const recordPhases = Effect.fnUntraced(function* (phases: Partial<PhaseTimings>) {
	const record = yield* PhaseRecorder
	yield* record(phases)
})

/**
 * Where the transport reports the certificate each completed TLS handshake presented, null when its
 * expiry was unreadable. The HTTP probe provides one per check and keeps the first hop's, the
 * configured URL's own host, so an unreadable one is not replaced by a redirect target's.
 */
export const CertificateRecorder = Context.Reference<
	(certificate: UptimeCertificate | null) => Effect.Effect<void>
>(
	"@maple/scraper/CertificateRecorder",
	{ defaultValue: () => () => Effect.void },
)

export const recordCertificate = Effect.fnUntraced(function* (certificate: UptimeCertificate | null) {
	const record = yield* CertificateRecorder
	yield* record(certificate)
})

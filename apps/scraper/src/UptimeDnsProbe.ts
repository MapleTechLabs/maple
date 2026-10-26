import { Resolver } from "node:dns/promises"
import { Clock, Context, Duration, Effect, Layer, Result, Schema } from "effect"
import type { UptimeDnsConfig, UptimeDnsRecordType } from "@maple/domain/uptime"
import { errorCodeOf, failed, formatSeconds, type ProbeOutcome, succeeded } from "./UptimeProbe"

export type DnsProbeConfig = Schema.Schema.Type<typeof UptimeDnsConfig>

export class DnsQueryError extends Schema.TaggedError<DnsQueryError>()("@maple/scraper/DnsQueryError", {
	message: Schema.String,
	/** The resolver's code: `ENOTFOUND` (NXDOMAIN), `ENODATA`, `ETIMEOUT`, `ESERVFAIL`... */
	code: Schema.NullOr(Schema.String),
}) {}

/** Answers as text: MX is the exchange, TXT its chunks joined. */
export type DnsLookup = (
	hostname: string,
	recordType: UptimeDnsRecordType,
	timeoutMs: number,
) => Effect.Effect<ReadonlyArray<string>, DnsQueryError>

const query = (resolver: Resolver, hostname: string, recordType: UptimeDnsRecordType) => {
	switch (recordType) {
		case "A":
			return resolver.resolve4(hostname)
		case "AAAA":
			return resolver.resolve6(hostname)
		case "CNAME":
			return resolver.resolveCname(hostname)
		case "NS":
			return resolver.resolveNs(hostname)
		case "MX":
			return resolver.resolveMx(hostname).then((records) => records.map((record) => record.exchange))
		case "TXT":
			return resolver.resolveTxt(hostname).then((records) => records.map((chunks) => chunks.join("")))
	}
}

/** The system's configured nameservers, one try, cancelled on interruption. */
export const systemDnsLookup: DnsLookup = (hostname, recordType, timeoutMs) =>
	Effect.suspend(() => {
		const resolver = new Resolver({ timeout: timeoutMs, tries: 1 })
		return Effect.tryPromise({
			try: () => query(resolver, hostname, recordType),
			catch: (cause) =>
				new DnsQueryError({
					message: cause instanceof Error ? cause.message : String(cause),
					code: errorCodeOf(cause),
				}),
		}).pipe(Effect.onInterrupt(() => Effect.sync(() => resolver.cancel())))
	})

/** The resolver the DNS probe uses; the system one unless a test swaps it. */
export const DnsLookupService = Context.Reference<DnsLookup>("@maple/scraper/DnsLookup", {
	defaultValue: () => systemDnsLookup,
})

const NAME_TYPES: ReadonlySet<UptimeDnsRecordType> = new Set(["CNAME", "MX", "NS", "AAAA"])

/** Names compare case-insensitively and without the root dot; A and TXT compare exactly. */
const normalize = (recordType: UptimeDnsRecordType, value: string): string => {
	if (!NAME_TYPES.has(recordType)) return value.trim()
	const lower = value.trim().toLowerCase()
	return lower.endsWith(".") ? lower.slice(0, -1) : lower
}

const describeQueryFailure = (config: DnsProbeConfig, error: DnsQueryError): string => {
	switch (error.code) {
		case "ENOTFOUND":
			return `${config.hostname} does not exist (NXDOMAIN)`
		case "ENODATA":
			return `${config.hostname} has no ${config.recordType} records`
		case "ETIMEOUT":
			return `DNS query timed out after ${formatSeconds(config.timeoutMs)}`
		default:
			return `DNS lookup for ${config.hostname} failed (${error.code ?? error.message})`
	}
}

const MAX_LISTED_ANSWERS = 3

export interface UptimeDnsProbeApi {
	/** Query one record type. Up when it resolves and, with `expected`, any answer equals it. */
	readonly probe: (config: DnsProbeConfig) => Effect.Effect<ProbeOutcome>
}

export class UptimeDnsProbe extends Context.Service<UptimeDnsProbe, UptimeDnsProbeApi>()(
	"@maple/scraper/UptimeDnsProbe",
	{
		make: Effect.gen(function* () {
			const lookup = yield* DnsLookupService

			const probe = (config: DnsProbeConfig) =>
				Effect.gen(function* () {
					const startedAt = yield* Clock.currentTimeMillis
					const result = yield* lookup(config.hostname, config.recordType, config.timeoutMs).pipe(
						Effect.timeout(Duration.millis(config.timeoutMs)),
						Effect.result,
					)
					const durationMs = (yield* Clock.currentTimeMillis) - startedAt
					if (Result.isFailure(result)) {
						const error = result.failure
						return error._tag === "TimeoutError" || error.code === "ETIMEOUT"
							? failed(
									durationMs,
									"timeout",
									`DNS query timed out after ${formatSeconds(config.timeoutMs)}`,
								)
							: failed(durationMs, "dns", describeQueryFailure(config, error))
					}
					const answers = result.success
					if (answers.length === 0) {
						return failed(
							durationMs,
							"dns",
							`${config.hostname} has no ${config.recordType} records`,
						)
					}
					if (config.expected === undefined) return succeeded(durationMs)
					const expected = normalize(config.recordType, config.expected)
					if (answers.some((answer) => normalize(config.recordType, answer) === expected)) {
						return succeeded(durationMs)
					}
					const listed = answers.slice(0, MAX_LISTED_ANSWERS).join(", ")
					const more =
						answers.length > MAX_LISTED_ANSWERS
							? ` and ${answers.length - MAX_LISTED_ANSWERS} more`
							: ""
					return failed(
						durationMs,
						"assertion",
						`${config.recordType} records for ${config.hostname} are ${listed}${more}, expected ${config.expected}`,
					)
				})

			return { probe } satisfies UptimeDnsProbeApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}

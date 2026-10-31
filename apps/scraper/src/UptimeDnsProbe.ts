import { Resolver } from "node:dns/promises"
import { Clock, Context, Duration, Effect, Layer, Result, Schema } from "effect"
import type { UptimeDnsConfig, UptimeDnsRecordType } from "@maple/domain/uptime"
import { isPrivateAddress, parseExternalUrl } from "@maple/safe-fetch"
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

const NAME_TYPES: ReadonlySet<UptimeDnsRecordType> = new Set(["CNAME", "MX", "NS"])
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/u

/** `2001:DB8:0::1` and `2001:db8::1` are one address: compare the URL parser's canonical spelling. */
const canonicalIpv6 = (value: string): string => {
	const bare = value.replace(/^\[|\]$/gu, "")
	return URL.canParse(`http://[${bare}]/`) ? new URL(`http://[${bare}]/`).hostname : bare.toLowerCase()
}

/** Addresses compare as addresses, names case-insensitively without the root dot, TXT exactly. */
const normalize = (recordType: UptimeDnsRecordType, value: string): string => {
	const trimmed = value.trim()
	if (recordType === "A") return IPV4.test(trimmed) ? trimmed.split(".").map(Number).join(".") : trimmed
	if (recordType === "AAAA") return canonicalIpv6(trimmed)
	if (!NAME_TYPES.has(recordType)) return trimmed
	const lower = trimmed.toLowerCase()
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

/** An answer a failure sentence may quote: no private or reserved address, no internal-only name. */
const isQuotable = (recordType: UptimeDnsRecordType, answer: string): boolean => {
	switch (recordType) {
		case "A":
		case "AAAA":
			return !isPrivateAddress(answer)
		case "TXT":
			return true
		case "CNAME":
		case "MX":
		case "NS":
			return Result.isSuccess(parseExternalUrl(`http://${answer.trim().replace(/\.$/u, "")}/`))
	}
}

/** The mismatch sentence, quoting only public answers. */
const describeMismatch = (
	config: DnsProbeConfig,
	expected: string,
	answers: ReadonlyArray<string>,
): string => {
	const quotable = answers.filter((answer) => isQuotable(config.recordType, answer))
	if (quotable.length === 0) {
		const records = answers.length === 1 ? "record" : "records"
		return `${config.hostname} resolved to ${answers.length} ${config.recordType} ${records}, none matched ${expected}`
	}
	const listed = quotable.slice(0, MAX_LISTED_ANSWERS)
	const unlisted = answers.length - listed.length
	const more = unlisted > 0 ? ` and ${unlisted} more` : ""
	return `${config.recordType} records for ${config.hostname} are ${listed.join(", ")}${more}, expected ${expected}`
}

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
					// A private address never confirms a check, or a monitor could map internal names.
					const isAddress = config.recordType === "A" || config.recordType === "AAAA"
					const confirms = (answer: string) =>
						!(isAddress && isPrivateAddress(answer.trim())) &&
						normalize(config.recordType, answer) === expected
					if (answers.some(confirms)) {
						return succeeded(durationMs)
					}
					return failed(durationMs, "assertion", describeMismatch(config, config.expected, answers))
				})

			return { probe } satisfies UptimeDnsProbeApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}

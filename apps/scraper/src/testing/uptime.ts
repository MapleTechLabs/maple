import { Effect, Schema } from "effect"
import { UptimeProbeTarget } from "@maple/domain/uptime"
import { HostResolutionError } from "@maple/safe-fetch"

export const MONITOR_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
export const MONITOR_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

const decodeTarget = Schema.decodeUnknownSync(UptimeProbeTarget)

export const httpConfig = (overrides: Record<string, unknown> = {}) => ({
	_tag: "http",
	url: "https://api.example.com/checkout/health",
	method: "GET",
	headers: {},
	assertions: [],
	timeoutMs: 10_000,
	...overrides,
})

export const mkUptimeTarget = (
	options: {
		readonly id?: string
		readonly intervalSeconds?: number
		readonly serviceName?: string | null
		readonly ingestKey?: string
		readonly name?: string
		readonly config?: Record<string, unknown>
	} = {},
): UptimeProbeTarget =>
	decodeTarget({
		id: options.id ?? MONITOR_A,
		orgId: "org_test",
		name: options.name ?? "Checkout health",
		serviceName: options.serviceName === undefined ? "checkout" : options.serviceName,
		intervalSeconds: options.intervalSeconds ?? 30,
		config: options.config ?? httpConfig(),
		ingestKey: options.ingestKey ?? "maple_pk_test",
	})

/** A fixed DNS: no test reaches a real resolver. Unknown names fail like NXDOMAIN. */
export const fixedResolver =
	(records: ReadonlyMap<string, ReadonlyArray<string>>) =>
	(hostname: string): Effect.Effect<ReadonlyArray<string>, HostResolutionError> => {
		const addresses = records.get(hostname)
		return addresses === undefined
			? Effect.fail(new HostResolutionError({ message: `NXDOMAIN ${hostname}`, hostname }))
			: Effect.succeed(addresses)
	}

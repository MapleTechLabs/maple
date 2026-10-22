import { lookup } from "node:dns/promises"
import { Context, Effect } from "effect"
import { HostResolutionError, type ResolveHost } from "./index"

/** `ResolveHost` over the system resolver, every A and AAAA answer. Node and Bun only. */
export const systemResolveHost: ResolveHost = (hostname) =>
	Effect.tryPromise({
		try: () => lookup(hostname, { all: true, verbatim: true }),
		catch: (cause) =>
			new HostResolutionError({
				message: `could not resolve ${hostname}: ${cause instanceof Error ? cause.message : String(cause)}`,
				hostname,
			}),
	}).pipe(Effect.map((answers) => answers.map((answer) => answer.address)))

/** The resolver `guardPinned` callers use; the system one unless a test swaps it. */
export const HostResolver = Context.Reference<ResolveHost>("@maple/safe-fetch/HostResolver", {
	defaultValue: () => systemResolveHost,
})

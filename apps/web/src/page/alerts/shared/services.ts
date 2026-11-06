import { getTracesFacets } from "@maple/web-data/warehouse/traces"
import { Array as Arr, Effect } from "effect"
import { currentWindow } from "../../../data/time-range"

// The org's services for the alert forms' Service pickers.

/** The services traced in the last day, from the traces facets; empty when the read fails. */
export const recentServiceNames = currentWindow({ preset: "24h", snap: true }).pipe(
	Effect.flatMap((window) => getTracesFacets({ data: window })),
	Effect.map((response) => Arr.map(response.data.services, (row) => row.name)),
	Effect.orElseSucceed((): ReadonlyArray<string> => []),
)

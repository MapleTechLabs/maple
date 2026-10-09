import { Schema } from "effect"

import { Atom } from "@/lib/effect-atom"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"

/**
 * A connection that was disconnected before its cleanup script was seen to run. Kept so the
 * script stays reachable across reloads until the admin dismisses it. The script comes from the
 * delete response, which carries no secret.
 */
const RemovedGcpConnector = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	hostProjectId: Schema.String,
	cleanupScript: Schema.String,
})
export type RemovedGcpConnector = Schema.Schema.Type<typeof RemovedGcpConnector>

export const removedGcpConnectorsAtomFamily = Atom.family((orgId: string) =>
	Atom.kvs({
		runtime: localStorageRuntime,
		key: `maple.gcp.removed-connectors.${orgId}`,
		schema: Schema.Array(RemovedGcpConnector),
		defaultValue: (): ReadonlyArray<RemovedGcpConnector> => [],
	}),
)

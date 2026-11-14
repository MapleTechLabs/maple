import { Effect } from "effect"
import { CURRENT_LOCAL_SCHEMA } from "./schema-identity"
import { type ServerStateFileError, stateFileError } from "./store-errors"
import {
	checkStoreCompatible,
	isSchemaIdentityStale,
	isStoreDirty,
	newerStoreSchemaVersion,
} from "./store-version"

/** Why chDB must not open a store as it is. */
export type StoreBlocker =
	| { readonly kind: "newer-schema"; readonly storeSchemaVersion: number }
	| { readonly kind: "incompatible"; readonly found: string; readonly current: string }
	| { readonly kind: "dirty" }
	| { readonly kind: "schema-stale" }

const blocked = (blocker: StoreBlocker): StoreBlocker => blocker

/**
 * The first reason `maple start` and the embedded runtime refuse a store, or
 * `undefined` when it is safe to open. A downgrade is checked before the
 * chDB-build gate, whose remedy (a reset) would destroy it.
 */
export const storeBlocker = (
	dataDir: string,
): Effect.Effect<StoreBlocker | undefined, ServerStateFileError> =>
	Effect.gen(function* () {
		const newerSchema = yield* Effect.try({
			try: () => newerStoreSchemaVersion(dataDir, CURRENT_LOCAL_SCHEMA.version),
			catch: stateFileError(dataDir, "read store schema for"),
		})
		if (newerSchema !== undefined)
			return blocked({ kind: "newer-schema", storeSchemaVersion: newerSchema })
		const compatibility = yield* Effect.try({
			try: () => checkStoreCompatible(dataDir),
			catch: stateFileError(dataDir, "read store identity for"),
		})
		if (!compatibility.compatible)
			return blocked({
				kind: "incompatible",
				found: compatibility.found,
				current: compatibility.current,
			})
		const dirty = yield* Effect.try({
			try: () => isStoreDirty(dataDir),
			catch: stateFileError(dataDir, "read open marker for"),
		})
		if (dirty) return blocked({ kind: "dirty" })
		const stale = yield* Effect.try({
			try: () => isSchemaIdentityStale(dataDir, CURRENT_LOCAL_SCHEMA),
			catch: stateFileError(dataDir, "read schema identity for"),
		})
		return stale ? blocked({ kind: "schema-stale" }) : undefined
	})

import { Atom } from "@/lib/effect-atom"
import { Schema } from "effect"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"

export type LogsDensity = "compact" | "comfortable"

/** Wrap long log bodies across all rows instead of truncating to one line. */
export const logsWrapAtom = Atom.kvs({
	runtime: localStorageRuntime,
	key: "maple.logs.wrap",
	schema: Schema.Boolean,
	defaultValue: () => false,
})

/** Row density for the logs stream. */
export const logsDensityAtom = Atom.kvs({
	runtime: localStorageRuntime,
	key: "maple.logs.density",
	schema: Schema.Literals(["compact", "comfortable"]),
	defaultValue: () => "compact" as LogsDensity,
})

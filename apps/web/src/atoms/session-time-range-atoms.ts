import { Schema } from "effect"

import { Atom } from "@/lib/effect-atom"
import { sessionStorageRuntime } from "@/lib/services/common/storage-runtime"

/**
 * The time window the user last chose on any time-filtered page, kept for the
 * life of the tab so the next page opens on the same window instead of its own
 * default. Mirrors `TimeRangeSearchFields`: a preset, or an absolute pair.
 */
export const SessionTimeRangeSchema = Schema.Struct({
	startTime: Schema.optionalKey(Schema.String),
	endTime: Schema.optionalKey(Schema.String),
	timePreset: Schema.optionalKey(Schema.String),
})

export type SessionTimeRange = Schema.Schema.Type<typeof SessionTimeRangeSchema>

const sessionTimeRangeAtomFamily = Atom.family((orgId: string) =>
	Atom.kvs({
		runtime: sessionStorageRuntime,
		key: `maple.time-range.session.${orgId}`,
		schema: SessionTimeRangeSchema,
		defaultValue: (): SessionTimeRange => ({}),
	}),
)

// Inert while there is no org: mounting a kvs atom for a placeholder key would
// write its default into sessionStorage under that placeholder.
const noOrgSessionTimeRangeAtom = Atom.make<SessionTimeRange>({})

export const sessionTimeRangeAtomFor = (orgId: string | null | undefined) =>
	orgId ? sessionTimeRangeAtomFamily(orgId) : noOrgSessionTimeRangeAtom

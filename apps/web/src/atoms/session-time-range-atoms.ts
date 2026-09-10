import { Schema } from "effect"

import { Atom } from "@/lib/effect-atom"
import { sessionStorageRuntime } from "@/lib/services/common/storage-runtime"

/**
 * The time window the user last chose on any time-filtered page, kept for the
 * life of the tab so the next page opens on the same window instead of its own
 * default. Mirrors `TimeRangeSearchFields` with `optionalKey` instead of
 * `optional`: this is a JSON value we write ourselves, so a key is either there
 * or absent, whereas the router hands search params present-but-undefined.
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

// A kvs atom writes its default into storage on the first read of a missing
// key — fine for a real org (`{}` reads back as "nothing remembered"), but with
// no org that would mint a placeholder entry, so that case gets an inert atom.
const noOrgSessionTimeRangeAtom = Atom.make<SessionTimeRange>({})

export const sessionTimeRangeAtomFor = (orgId: string | null | undefined) =>
	orgId ? sessionTimeRangeAtomFamily(orgId) : noOrgSessionTimeRangeAtom

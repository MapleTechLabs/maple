import type { Option } from "effect"
import type { PresenceResult } from "../../data/signal-presence"
import type { PageContext } from "../contract"

/** What the view reads from the root: data only, as Block view inputs carry no callbacks. */
export type ServiceMapViewInputs = Readonly<{
	context: PageContext
	/** The shared signal presence read (`useSignalPresence`): none while loading or unreadable. */
	maybePresence: Option.Option<PresenceResult>
	/** The server's last ingest, for `useNewDataSince`'s "New data" pill. */
	lastIngestAtMs: Option.Option<number>
}>

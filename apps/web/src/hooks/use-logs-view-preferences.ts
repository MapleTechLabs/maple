import { useAtom } from "@/lib/effect-atom"
import { logsDensityAtom, logsWrapAtom, type LogsDensity } from "@/atoms/logs-preferences-atoms"

export type { LogsDensity }

/**
 * Per-user logs stream view preferences (wrap + density), persisted to
 * localStorage via `Atom.kvs`. Shared by the table (presentation) and the
 * toolbar (controls) so both read/write the same source.
 */
export function useLogsViewPreferences() {
	const [wrap, setWrap] = useAtom(logsWrapAtom)
	const [density, setDensity] = useAtom(logsDensityAtom)

	return {
		wrap,
		setWrap,
		density: density as LogsDensity,
		setDensity: (value: LogsDensity) => setDensity(value),
	}
}

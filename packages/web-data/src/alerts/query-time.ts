/** A query time for people: "5 s", "7.8 s", "15 s", and "under 0.1 s" rather than "0.0 s". */
export const formatQuerySeconds = (ms: number): string => {
	if (ms < 50) return "under 0.1 s"
	const seconds = ms / 1000
	return `${Number.isInteger(seconds) || seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1)} s`
}

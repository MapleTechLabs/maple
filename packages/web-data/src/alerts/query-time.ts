/** A query time for people: "5 s", "7.8 s", "15 s". */
export const formatQuerySeconds = (ms: number): string => {
	const seconds = ms / 1000
	return `${Number.isInteger(seconds) || seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1)} s`
}

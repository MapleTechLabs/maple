/**
 * Failure message `getQueryBuilderTimeseries` raises when the queries ran
 * fine but matched nothing in the requested window. Defined here (pure
 * module) so both the server fn and the alert preview hook can share it
 * without test files pulling in server-fn imports.
 */
export const NO_QUERY_DATA_MESSAGE = "No query data found in selected time range"

/**
 * Maps a builder-query preview failure message to UI state: the no-data
 * failure renders as the friendly empty chart (null), anything else is a
 * real error to surface.
 */
export function mapBuilderChartFailure(message: string): string | null {
	return message === NO_QUERY_DATA_MESSAGE ? null : message
}

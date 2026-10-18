import type { DataSourceEndpoint } from "@/components/dashboard-builder/types"
import {
	getWidgetServerFunction,
	widgetServerFunctions,
	type WidgetServerFunction,
} from "@maple/web-data/warehouse/widget-data-sources"

/**
 * The widget data sources, one warehouse server function per stored `endpoint`. The table lives
 * in `@maple/web-data` so the Foldkit app runs the same one; this checks it stays total over the
 * web app's own `DataSourceEndpoint` union.
 */
export const serverFunctionMap: Record<DataSourceEndpoint, WidgetServerFunction> = widgetServerFunctions

/**
 * Looks up a data-source server function by endpoint name. Accepts an
 * arbitrary string (e.g. an endpoint coming from a JSON-decoded widget config
 * whose type is only `string`) and returns `undefined` for unknown endpoints.
 */
export const getServerFunction = getWidgetServerFunction

// `toWidgetRequest` moved to `@maple/widgets/dashboard` so the share API lowers
// a stored data source through the exact function the browser does. Re-exported
// here because this file is where the web app has always looked for it.
export { toWidgetRequest } from "@maple/widgets/dashboard"

import { Schema } from "effect"
import { Base64Url } from "effect/encoding"
import type { DashboardDocument } from "@maple/domain/http"
import { dataSourceRawSql, isQueryDataSource } from "@maple/widgets/dashboard"
import type { AlertsCreateSearch } from "../../../route/search"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

// The widget actions: which actions a
// tile's menu offers, and the alert prefill it hands /alerts/create.

type Widget = DashboardDocument["widgets"][number]

/** Query and raw-SQL tiles can seed an alert. */
export const isAlertable = (widget: Widget): boolean =>
	isQueryDataSource(widget.dataSource) || dataSourceRawSql(widget.dataSource) !== null

// `toBase64Url` (unpadded UTF-8 base64url) and `encodeAlertChartToSearchParam`.
const toBase64Url = (input: string): string => Base64Url.encode(input)

/** Keeps the encoded param well under practical URL limits (`MAX_ENCODED_LENGTH`). */
const MAX_ENCODED_LENGTH = 12_000

const encodeAlertChart = (dashboardId: string, widget: Widget): string | undefined => {
	const encoded = toBase64Url(
		encodeJson({
			dashboardId,
			widget: {
				id: widget.id,
				visualization: widget.visualization,
				dataSource: widget.dataSource,
				display: { title: widget.display.title },
			},
		}),
	)
	return encoded.length > MAX_ENCODED_LENGTH ? undefined : encoded
}

/** "Create alert": the live widget snapshot rides in `chart`. */
export const createAlertSearch = (dashboardId: string, widget: Widget): typeof AlertsCreateSearch.Type => {
	const chart = encodeAlertChart(dashboardId, widget)
	return { dashboardId, widgetId: widget.id, ...(chart === undefined ? undefined : { chart }) }
}

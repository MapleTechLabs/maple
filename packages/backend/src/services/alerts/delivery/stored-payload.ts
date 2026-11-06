/**
 * The JSON an `alert_delivery_events` row carries: what the event saw, snapshotted when it was
 * queued. Read by the dispatcher, and by the chat card refresh to redraw a card it posted.
 */
import { AlertNotificationTemplate } from "@maple/domain/http"
import { Schema } from "effect"

export const StoredDeliveryPayloadSchema = Schema.StructWithRest(
	Schema.Struct({
		event: Schema.optionalKey(Schema.Unknown),
		eventType: Schema.optionalKey(Schema.String),
		incidentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
		incidentStatus: Schema.optionalKey(Schema.String),
		dedupeKey: Schema.optionalKey(Schema.String),
		rule: Schema.optionalKey(
			Schema.Struct({
				id: Schema.optionalKey(Schema.String),
				name: Schema.optionalKey(Schema.String),
				signalType: Schema.optionalKey(Schema.String),
				severity: Schema.optionalKey(Schema.String),
				groupKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
				comparator: Schema.optionalKey(Schema.String),
				threshold: Schema.optionalKey(Schema.Number),
				thresholdUpper: Schema.optionalKey(Schema.NullOr(Schema.Number)),
				windowMinutes: Schema.optionalKey(Schema.Number),
				severities: Schema.optionalKey(Schema.Array(Schema.String)),
			}),
		),
		peakSeverity: Schema.optionalKey(Schema.NullOr(Schema.String)),
		observed: Schema.optionalKey(
			Schema.Struct({
				value: Schema.optionalKey(Schema.NullOr(Schema.Number)),
				sampleCount: Schema.optionalKey(Schema.NullOr(Schema.Number)),
				detail: Schema.optionalKey(Schema.NullOr(Schema.String)),
			}),
		),
		template: Schema.optionalKey(Schema.NullOr(AlertNotificationTemplate)),
		linkUrl: Schema.optionalKey(Schema.String),
		chatUrl: Schema.optionalKey(Schema.String),
		chart: Schema.optionalKey(
			Schema.NullOr(
				Schema.Struct({
					sparkline: Schema.optionalKey(Schema.String),
					url: Schema.optionalKey(Schema.String),
				}),
			),
		),
	}),
	[Schema.Record(Schema.String, Schema.Unknown)],
)

export type StoredDeliveryPayload = Schema.Schema.Type<typeof StoredDeliveryPayloadSchema>

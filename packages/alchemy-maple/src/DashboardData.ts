import { Option, Schema } from "effect"
import {
	V2DashboardCreateParams,
	V2DashboardWidget,
	V2DashboardVariable,
	V2DashboardSection,
	V2TimeRange,
} from "@maple/domain/http/v2/dashboard-data"

// Codec<T> erases constructor input to unknown. Preserve typed `.make` calls
// while keeping the implementation's schema fields out of public signatures.
interface DashboardSchema<in out T> extends Schema.Codec<T> {
	readonly "~type.make.in": T
}

// Keep decoder-side validation (notably native query drafts) while returning
// the original snake_case data rather than the API's decoded storage shape.
const nativeWire = <S extends Schema.Codec<unknown, unknown>>(schema: S): DashboardSchema<S["Encoded"]> =>
	Schema.toEncoded(schema).check(
		Schema.makeFilter((value) => Option.isSome(Schema.decodeUnknownOption(schema)(value)), {
			description: "valid native v2 dashboard data",
		}),
	)

/** Native v2 dashboard data, in its public snake_case wire representation. */
export interface DashboardData extends Schema.Codec.Encoded<typeof V2DashboardCreateParams> {}
export const DashboardData: DashboardSchema<DashboardData> = nativeWire(V2DashboardCreateParams)

export interface DashboardWidget extends Schema.Codec.Encoded<typeof V2DashboardWidget> {}
export const DashboardWidget: DashboardSchema<DashboardWidget> = nativeWire(V2DashboardWidget)

export type DashboardVariable = Schema.Codec.Encoded<typeof V2DashboardVariable>
export const DashboardVariable: DashboardSchema<DashboardVariable> = nativeWire(V2DashboardVariable)

export interface DashboardSection extends Schema.Codec.Encoded<typeof V2DashboardSection> {}
export const DashboardSection: DashboardSchema<DashboardSection> = nativeWire(V2DashboardSection)

export type DashboardTimeRange = Schema.Codec.Encoded<typeof V2TimeRange>
export const DashboardTimeRange: DashboardSchema<DashboardTimeRange> = nativeWire(V2TimeRange)

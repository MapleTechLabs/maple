import { Schema, type Types } from "effect"
import { WarehouseResponseLimitError } from "./response-limits"

/**
 * Where a driver failure came from. `server` means the database answered with an
 * error; `transport` means it never did (DNS, TLS, reset, abort); `protocol` means
 * it answered with something the driver could not decode; `config` means the driver
 * refused to run at all. `unknown` is reserved for values thrown by Promise-based
 * drivers that carry no such structure — classification falls back to the message.
 */
export const WarehouseDriverFailureReason = Schema.Literals(["server", "transport", "protocol", "config", "unknown"])
export type WarehouseDriverFailureReason = typeof WarehouseDriverFailureReason.Type

/**
 * The one failure a `WarehouseSqlClient` can report. Adapters normalise their
 * transport's errors into this shape at the boundary, so `mapWarehouseError`
 * classifies structured fields — HTTP status, ClickHouse code and type — instead
 * of sniffing a thrown value.
 */
export class WarehouseDriverError extends Schema.TaggedError<WarehouseDriverError>()(
	"@maple/query-engine/execution/WarehouseDriverError",
	{
		message: Schema.String,
		reason: WarehouseDriverFailureReason,
		status: Schema.optionalKey(Schema.Number),
		code: Schema.optionalKey(Schema.String),
		type: Schema.optionalKey(Schema.String),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {
	/**
	 * Boundary for Promise-based drivers: lifts whatever they threw, keeping the
	 * `status`/`statusCode`, `code` and `type` fields SDK errors conventionally carry.
	 */
	static fromUnknown(cause: unknown): WarehouseDriverError {
		if (cause instanceof WarehouseDriverError) return cause
		const record = isRecord(cause) ? cause : undefined
		const fields: Types.Mutable<ConstructorParameters<typeof WarehouseDriverError>[0]> = {
			message: unknownMessage(cause),
			reason: cause instanceof SyntaxError ? "protocol" : "unknown",
			cause,
		}
		const status = record?.status ?? record?.statusCode
		if (typeof status === "number") fields.status = status
		const code = optionalString(record?.code)
		if (code !== undefined) fields.code = code
		if (typeof record?.type === "string") fields.type = record.type
		return new WarehouseDriverError(fields)
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null

const optionalString = (value: unknown): string | undefined =>
	typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined

const unknownMessage = (error: unknown): string => {
	if (typeof error === "string") return error
	if (error instanceof Error) return error.message
	if (isRecord(error) && typeof error.message === "string") return error.message
	return "Warehouse driver request failed"
}

/** Response limits retain their identity so they cannot enter the transient retry path. */
export const warehouseDriverFailure = (cause: unknown): WarehouseDriverError | WarehouseResponseLimitError =>
	cause instanceof WarehouseResponseLimitError ? cause : WarehouseDriverError.fromUnknown(cause)

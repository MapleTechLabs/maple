// Brands for ids read back from warehouse rows. The warehouse only holds values
// that passed these schemas on the way in, so a failure here is a defect.
import { Schema } from "effect"
import { ServiceName, SpanId, TraceId } from "@maple/domain/http"

export const decodeTraceId = Schema.decodeSync(TraceId)
export const decodeSpanId = Schema.decodeSync(SpanId)
export const decodeServiceName = Schema.decodeSync(ServiceName)

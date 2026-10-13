// Runtime-agnostic: nothing here touches the DOM at import time, so the Effect
// SDK's server and Workers presets can bundle it. DOM collectors live behind
// the `./browser/*` subpaths.
export { asError, stackWithCauses } from "./errors"
export type { ErrorFilter, ErrorFilterHint, ErrorFilterOptions, ErrorSource } from "./error-filters"
export { frameUrls, makeErrorFilter } from "./error-filters"
export type { HeaderCapture, HeaderCaptureOptions } from "./http-headers"
export { filterHeaderAttribute, resolveHeaderCapture } from "./http-headers"
export type { AttributeValue, HttpStatusRange, ReadAttribute } from "./http-status"
export { DEFAULT_ERROR_STATUS, httpErrorType, inStatusRanges, responseStatus } from "./http-status"
export type { EmitLog, LogAttributeValue, SignalLogRecord, SpanLink } from "./log-record"
export { Severity, severityOf } from "./log-record"
export type {
	ConsoleLevel,
	ReplayOptions,
	ResolvedReplayOptions,
	ResolvedSignalOptions,
	SignalOptions,
	TracingSignalOptions,
} from "./options"
export { resolveReplayOptions, resolveSignalOptions } from "./options"
export type { PageSignal } from "./page"
export {
	claimPageSignal,
	markReported,
	notifyErrorRecorded,
	onErrorRecorded,
	resetPageForTests,
	wasReported,
} from "./page"
export type { SamplingDecision } from "./sampling"
export {
	randomnessValue,
	rejectionThreshold,
	resolveSampleRate,
	sampleSession,
	sessionRoll,
} from "./sampling"

import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html } from "foldkit/html"
import type { ApplicationViewBuilder } from "../composition"
import { presenceOf } from "../data/signal-presence"
import type { Model } from "../model"
import {
	ErrorsBinding,
	LogsBinding,
	MetricDetailBinding,
	MetricsBinding,
	pageContextOf,
	QueryBinding,
	ServiceDetailBinding,
	ServiceMapBinding,
	ServicesBinding,
	SessionDetailBinding,
	SessionsBinding,
	TraceDetailBinding,
	TracesBinding,
} from "./registry"

// The open page in the root view. `h` is the root Composition's builder, which registers every
// page Binding (with its OutMessage policy).

/** The open page, embedded with what it reads from the root. */
export const viewPage = (h: ApplicationViewBuilder, model: Model): Html => {
	const { page } = model
	const context = pageContextOf(model)
	const maybePresence = AsyncData.getData(model.presence)
	const lastIngestAtMs = Option.flatMap(model.maybeServer, (server) =>
		Option.fromNullishOr(server.lastIngestAtMs),
	)
	/** The root's latest clock read (each server probe). */
	const clockMs = Option.match(model.maybeServer, {
		onNone: () => 0,
		onSome: (server) => server.checkedAtMs,
	})
	const listInputs = { context, maybePresence, lastIngestAtMs }
	if (page._tag === "TracesPage")
		return h.block(
			TracesBinding.embedView({ slotId: "page:traces", model: page, viewInputs: listInputs }),
		)
	if (page._tag === "TraceDetailPage")
		return h.block(
			TraceDetailBinding.embedView({
				slotId: "page:trace-detail",
				model: page,
				viewInputs: { context, lastIngestAtMs },
			}),
		)
	if (page._tag === "LogsPage")
		return h.block(LogsBinding.embedView({ slotId: "page:logs", model: page, viewInputs: listInputs }))
	if (page._tag === "MetricsPage")
		return h.block(
			MetricsBinding.embedView({
				slotId: "page:metrics",
				model: page,
				viewInputs: { context, presence: maybePresence, lastIngestAtMs },
			}),
		)
	if (page._tag === "MetricDetailPage")
		return h.block(
			MetricDetailBinding.embedView({
				slotId: "page:metric-detail",
				model: page,
				viewInputs: { context, clockMs, lastIngestAtMs },
			}),
		)
	if (page._tag === "ServicesPage")
		return h.block(
			ServicesBinding.embedView({ slotId: "page:services", model: page, viewInputs: listInputs }),
		)
	if (page._tag === "ServiceDetailPage")
		return h.block(
			ServiceDetailBinding.embedView({
				slotId: "page:service-detail",
				model: page,
				viewInputs: { context, lastIngestAtMs },
			}),
		)
	if (page._tag === "ServiceMapPage")
		return h.block(
			ServiceMapBinding.embedView({ slotId: "page:service-map", model: page, viewInputs: listInputs }),
		)
	if (page._tag === "ErrorsPage")
		return h.block(
			ErrorsBinding.embedView({
				slotId: "page:errors",
				model: page,
				viewInputs: { context, clockMs, lastIngestAtMs, maybePresence },
			}),
		)
	if (page._tag === "SessionsPage")
		return h.block(
			SessionsBinding.embedView({
				slotId: "page:sessions",
				model: page,
				viewInputs: {
					context,
					presenceOf: (signal) => presenceOf(maybePresence, signal),
					presenceNowMs: Option.match(maybePresence, {
						onNone: () => 0,
						onSome: (result) => result.nowMs,
					}),
					clockMs,
					hasNewDataSince: (sinceMs) =>
						sinceMs > 0 && Option.exists(lastIngestAtMs, (last) => last > sinceMs),
				},
			}),
		)
	if (page._tag === "SessionDetailPage")
		return h.block(
			SessionDetailBinding.embedView({
				slotId: "page:session-detail",
				model: page,
				viewInputs: { context, clockMs, lastIngestAtMs },
			}),
		)
	if (page._tag === "QueryPage")
		return h.block(QueryBinding.embedView({ slotId: "page:query", model: page, viewInputs: { context } }))
	return h.div([], [])
}

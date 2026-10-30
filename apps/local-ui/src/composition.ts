import * as ToastView from "@maple/web/ui/toast-view"
import { Tuple } from "effect"
import type { Block } from "foldkit"
import { ApplicationDefinition } from "./page/application-definition"
import { ErrorsBlock } from "./page/errors"
import { LogsBlock } from "./page/logs"
import { MetricDetailBlock } from "./page/metric-detail"
import { MetricsBlock } from "./page/metrics"
import { QueryBlock } from "./page/query"
import {
	ErrorsBinding,
	LogsBinding,
	MetricDetailBinding,
	MetricsBinding,
	QueryBinding,
	ServiceDetailBinding,
	ServiceMapBinding,
	ServicesBinding,
	SessionDetailBinding,
	SessionsBinding,
	TraceDetailBinding,
	TracesBinding,
} from "./page/registry"
import { ServiceDetailBlock } from "./page/service-detail"
import { ServiceMapPageBlock } from "./page/service-map"
import { ServicesBlock } from "./page/services"
import { SessionDetailBlock } from "./page/session-detail"
import { SessionsBlock } from "./page/sessions"
import { TraceDetailBlock } from "./page/trace-detail"
import { TracesBlock } from "./page/traces"
import { ConnectPopoverBinding, FilterDrawerBinding, InstallTabsBinding } from "./shell/bindings"
import { pageOutHandlers } from "./update-page"

// The root's child graph: every page on the `page` slot (its OutMessages folded by the root),
// the shell's popover, tabs and drawer, and the toast stack.

const { makeNoopStep, makeOutMessageFold } = ApplicationDefinition

/** The app's toasts; nothing in Maple Local adds one yet, the regions stay mounted. */
export const ToastsBinding = ApplicationDefinition.makeBinding(ToastView.ToastBlock, {
	field: "toasts",
	init: { contextToArgs: () => Tuple.make("toasts") },
}).withOutMessagePolicy({
	fold: makeOutMessageFold(ToastView.ToastBlock, {
		ClickedToastAction: makeNoopStep,
		RemovedToast: makeNoopStep,
	}),
})

export const ApplicationComposition = ApplicationDefinition.makeComposition({
	bindings: [
		TracesBinding.withOutMessagePolicy({ fold: makeOutMessageFold(TracesBlock, pageOutHandlers) }),
		TraceDetailBinding.withOutMessagePolicy({ fold: makeOutMessageFold(TraceDetailBlock, pageOutHandlers) }),
		LogsBinding.withOutMessagePolicy({ fold: makeOutMessageFold(LogsBlock, pageOutHandlers) }),
		MetricsBinding.withOutMessagePolicy({ fold: makeOutMessageFold(MetricsBlock, pageOutHandlers) }),
		MetricDetailBinding.withOutMessagePolicy({ fold: makeOutMessageFold(MetricDetailBlock, pageOutHandlers) }),
		ServicesBinding.withOutMessagePolicy({ fold: makeOutMessageFold(ServicesBlock, pageOutHandlers) }),
		ServiceDetailBinding.withOutMessagePolicy({ fold: makeOutMessageFold(ServiceDetailBlock, pageOutHandlers) }),
		ServiceMapBinding.withOutMessagePolicy({ fold: makeOutMessageFold(ServiceMapPageBlock, pageOutHandlers) }),
		ErrorsBinding.withOutMessagePolicy({ fold: makeOutMessageFold(ErrorsBlock, pageOutHandlers) }),
		SessionsBinding.withOutMessagePolicy({ fold: makeOutMessageFold(SessionsBlock, pageOutHandlers) }),
		SessionDetailBinding.withOutMessagePolicy({ fold: makeOutMessageFold(SessionDetailBlock, pageOutHandlers) }),
		QueryBinding.withOutMessagePolicy({ fold: makeOutMessageFold(QueryBlock, pageOutHandlers) }),
		ConnectPopoverBinding,
		InstallTabsBinding,
		FilterDrawerBinding,
		ToastsBinding,
	],
})
export type ApplicationViewBuilder = Block.ViewBuilderFor<typeof ApplicationComposition>

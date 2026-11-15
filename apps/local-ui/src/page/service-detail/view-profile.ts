import { formatNumber } from "@maple/ui/lib/format"
import { failureWithoutData } from "@maple/views/data/keyed"
import {
	formatProfileValue,
	topFunctionsTable,
	view as flamegraphView,
} from "@maple/views/profiles/profile-flamegraph-view"
import { errorState } from "@maple/views/ui/error-state"
import { heading } from "@maple/views/ui/heading"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "./message"
import type { Model, ServiceProfile } from "./model"

// The service detail page's profile section: where the service spent CPU in the window, as a
// flame graph and the functions that used the most. Absent until the service sends profiles.

const TOP_FUNCTIONS = 15

/** The profile's total and stack count. Only CPU time reads as time on CPU and average cores. */
const summary = (profile: NonNullable<ServiceProfile>): string => {
	const stacks = `${formatNumber(profile.totalStacks)} distinct stacks`
	const value = formatProfileValue(profile.totalValue, profile.sampleUnit)
	if (profile.sampleType !== "cpu") return `${value}, ${stacks}`
	if (profile.sampleUnit !== "nanoseconds" || profile.durationNano === 0)
		return `${value} on CPU, ${stacks}`
	const cores = profile.totalValue / profile.durationNano
	return `${value} on CPU, ${cores.toFixed(2)} cores on average, ${stacks}`
}

const loaded = (h: HtmlBuilder<Message>, model: Model, profile: NonNullable<ServiceProfile>): Html => {
	const input = { stacks: profile.stacks, totalValue: profile.totalValue }
	return h.section(
		[h.Class("space-y-3")],
		[
			hstack(h, { align: "baseline", justify: "between", gap: "3" }, [
				heading(h, { level: 3, variant: "subsection" }, [`Profile: ${profile.sampleType}`]),
				typography(h, { size: "xs", tone: "muted", numeric: true }, [summary(profile)]),
			]),
			flamegraphView(h, model.flamegraph, { input, unit: profile.sampleUnit }, (message) =>
				Message.GotFlamegraphMessage({ message }),
			),
			heading(h, { level: 3, variant: "subsection" }, ["Top functions"]),
			topFunctionsTable(h, input, {
				unit: profile.sampleUnit,
				limit: TOP_FUNCTIONS,
				scope: model.flamegraph.scope,
			}),
		],
	)
}

/** Nothing while the service has no profiles: the page reads as it did before profiling. */
export const serviceProfile = (h: HtmlBuilder<Message>, model: Model): ReadonlyArray<Html> => {
	const failure = failureWithoutData(model.profile)
	if (Option.isSome(failure))
		return [
			errorState(h, {
				failure: failure.value,
				title: "Couldn't load the profile",
				onRetry: Message.ClickedRetryProfile(),
			}),
		]
	const profile = Option.getOrNull(AsyncData.getData(model.profile.data))
	return profile === null ? [] : [loaded(h, model, profile)]
}

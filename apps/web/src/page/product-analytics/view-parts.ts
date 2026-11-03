import type { FunnelKeyBy } from "@maple/query-model"
import { pluralize } from "@maple/ui/lib/format"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { empty, emptyDescription, emptyHeader, emptyTitle } from "@maple/views/ui/empty"
import { panel } from "@maple/views/ui/panel"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import type { StepSuggestion } from "../kit/funnel-steps"
import type { Message } from "./message"
import type { EventRow, Model } from "./model"

// What the three tabs share: their control bar, their empty panel and the step inputs' suggestions.

type H = HtmlBuilder<Message>

/** A labelled segmented control in a tab's control bar. */
export const labelledSegment = <T extends string>(
	h: H,
	options: Readonly<{
		label: string
		value: T
		options: ReadonlyArray<{ value: T; label: string }>
		onChange: (value: T) => Message
	}>,
	extra: ReadonlyArray<Html> = [],
): Html =>
	hstack(h, { gap: "2" }, [
		typography(h, { size: "xs", tone: "muted", className: "shrink-0" }, [options.label]),
		segmentedSelect(h, {
			options: options.options,
			value: options.value,
			onChange: options.onChange,
			size: "xs",
			ariaLabel: options.label,
		}),
		...extra,
	])

/** The ruled row of controls under an editor. */
export const controlsBar = (h: H, children: ReadonlyArray<Html>): Html =>
	hstack(h, { wrap: true, className: "gap-x-5 gap-y-2 border-t px-3 py-2.5" }, children)

/** A panel holding one empty state: a title and what to do about it. */
export const emptyPanel = (h: H, title: string, description: ReadonlyArray<Html | string>): Html =>
	panel(h, {}, [empty(h, [emptyHeader(h, [emptyTitle(h, [title]), emptyDescription(h, description)])])])

const eventRowsOf = (model: Model): ReadonlyArray<EventRow> =>
	Option.getOrElse(AsyncData.getData(model.events.data), () => [])

/** The window's event names, most reached first, for the step inputs. */
export const eventSuggestions = (model: Model): ReadonlyArray<StepSuggestion> =>
	eventRowsOf(model)
		.toSorted((a, b) => b.persons - a.persons)
		.map((row) => ({ name: row.eventName, count: row.persons }))

/** The window's entry pages, for page steps. */
export const pageSuggestions = (model: Model): ReadonlyArray<StepSuggestion> =>
	Option.getOrElse(
		Option.map(AsyncData.getData(model.breakdowns.data), (breakdowns) => breakdowns.entryPaths),
		() => [],
	)

/** What a funnel or path counts, as people read it: "1 person", "12 sessions". */
export const countNoun = (keyBy: FunnelKeyBy, count: number): string => {
	switch (keyBy) {
		case "person":
			return pluralize(count, "person", "people")
		case "visitor":
			return pluralize(count, "visitor")
		case "user":
			return pluralize(count, "user")
		case "session":
			return pluralize(count, "session")
	}
}

/** A table column header for the same count. */
export const countHeader = (keyBy: FunnelKeyBy): string =>
	({ person: "People", visitor: "Visitors", user: "Users", session: "Sessions" })[keyBy]

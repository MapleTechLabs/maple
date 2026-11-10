import { Option, Array as Arr } from "effect"
import { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Select from "@maple/views/ui/select"
import * as SelectView from "@maple/views/ui/select-view"

// The environment switcher the overview, the service map and a service's page share. Each page keeps
// its own sentinel for "All environments", its URL key and its default rule (the selected value).

/** The switcher's entries: "All environments" under the page's `allValue`, then each environment. */
export const environmentEntries = (
	allValue: string,
	environments: ReadonlyArray<string>,
): ReadonlyArray<SelectView.SelectEntry> => [
	{ _tag: "Item", item: { value: allValue, label: "All environments" } },
	...Arr.map(environments, (name): SelectView.SelectEntry => ({
		_tag: "Item",
		item: { value: name, label: name },
	})),
]

/** An entry's label, or the raw value when it is not among the entries (facets not loaded). */
export const entryLabel = (entries: ReadonlyArray<SelectView.SelectEntry>, value: string): string =>
	Option.match(
		Arr.findFirst(SelectView.optionsOf(entries), (option) => option.value === value),
		{ onNone: () => value, onSome: (option) => option.label },
	)

export type Step<M> = Readonly<{
	select: Select.Model
	commands: ReadonlyArray<Command.Command<M>>
	/** The pick, when this step made one: the chosen value as the page's URL takes it. */
	picked: Option.Option<string | undefined>
}>

/**
 * One switcher step: a pick of `allValue` reads as `undefined` (it leaves the URL) unless
 * `keepAllInUrl`, so the explicit choice sticks.
 */
export const stepEnvironmentSelect = <M>(
	select: Select.Model,
	message: Select.Message,
	options: Readonly<{
		toMessage: (message: Select.Message) => M
		allValue: string
		keepAllInUrl: boolean
	}>,
): Step<M> => {
	const next = Select.update(select, message)
	return {
		select: next.model,
		commands: Command.mapMessages(next.commands ?? [], options.toMessage),
		picked: Option.map(Option.fromUndefinedOr(next.outMessage), ({ value }) =>
			value === options.allValue && !options.keepAllInUrl ? undefined : value,
		),
	}
}

/** The switcher's Select, showing `value` (the URL and the page's default), not the last pick. */
export const environmentSwitcher = <M>(
	h: HtmlBuilder<M>,
	config: Readonly<{
		select: Select.Model
		value: string
		entries: ReadonlyArray<SelectView.SelectEntry>
		toMessage: (message: Select.Message) => M
		toView: (parts: ReadonlyArray<Html>) => Html
		ariaLabel?: string
		className?: string
		renderValue?: (value: string) => ReadonlyArray<Html | string>
	}>,
): Html =>
	h.submodel({
		slotId: "environment-select",
		model: { ...config.select, value: config.value },
		view: SelectView.view,
		toParentMessage: config.toMessage,
		viewInputs: {
			entries: config.entries,
			size: "sm",
			ariaLabel: config.ariaLabel,
			className: config.className,
			renderValue: config.renderValue,
			toView: config.toView,
		},
	})

import { Clock, Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as DependenciesPage from "../../page/security/dependencies/model"
import * as DependenciesUpdate from "../../page/security/dependencies/update"
import { view as dependenciesView } from "../../page/security/dependencies/view"
import * as FindingPage from "../../page/security/finding/model"
import * as FindingUpdate from "../../page/security/finding/update"
import { breadcrumbsOf as findingCrumbs, view as findingView } from "../../page/security/finding/view"
import { breadcrumbsOf as tabsCrumbs } from "../../page/security/kit/layout"
import * as RunPage from "../../page/security/run/model"
import * as RunUpdate from "../../page/security/run/update"
import { breadcrumbsOf as runCrumbs, view as runView } from "../../page/security/run/view"
import * as TabsPage from "../../page/security/tabs/model"
import * as TabsUpdate from "../../page/security/tabs/update"
import { view as tabsView } from "../../page/security/tabs/view"
import * as TelemetryPage from "../../page/security/telemetry/model"
import * as TelemetryUpdate from "../../page/security/telemetry/update"
import { view as telemetryView } from "../../page/security/telemetry/view"
import { build, context, isLocalCommand, Scenario } from "../security-lab/scenarios"
import { defineShellLab } from "../shell-lab"

// `/lab/security?state=<scenario>`: every Security Center page and state over fixtures, in the
// real shell. API Commands are dropped, so nothing leaves the browser.

const Model = Schema.Struct({
	scenario: Scenario,
	tabs: Schema.NullOr(TabsPage.Model),
	run: Schema.NullOr(RunPage.Model),
	finding: Schema.NullOr(FindingPage.Model),
	telemetry: Schema.NullOr(TelemetryPage.Model),
	dependencies: Schema.NullOr(DependenciesPage.Model),
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
	GotTabsMessage: { message: TabsPage.Message },
	GotRunMessage: { message: RunPage.Message },
	GotFindingMessage: { message: FindingPage.Message },
	GotTelemetryMessage: { message: TelemetryPage.Message },
	GotDependenciesMessage: { message: DependenciesPage.Message },
})
type Message = typeof Message.Type

const Flags = Schema.Struct({ nowMs: Schema.Finite, scenario: Scenario })

const isScenario = Schema.is(Scenario)

const flags = Effect.all({
	nowMs: Clock.currentTimeMillis,
	scenario: Effect.sync(() => {
		const state = Option.getOrNull(
			Option.fromNullishOr(new URLSearchParams(window.location.search).get("state")),
		)
		return isScenario(state) ? state : "overview"
	}),
})

const init = (input: typeof Flags.Type) => {
	const built = build(input.scenario, input.nowMs)
	const empty: Model = {
		scenario: input.scenario,
		tabs: null,
		run: null,
		finding: null,
		telemetry: null,
		dependencies: null,
	}
	switch (built._tag) {
		case "Tabs":
			return {
				model: { ...empty, tabs: built.step.model },
				commands: Command.mapMessages(built.step.commands, (message) =>
					Message.GotTabsMessage({ message }),
				),
			}
		case "Run":
			return {
				model: { ...empty, run: built.step.model },
				commands: Command.mapMessages(built.step.commands, (message) =>
					Message.GotRunMessage({ message }),
				),
			}
		case "Finding":
			return {
				model: { ...empty, finding: built.step.model },
				commands: Command.mapMessages(built.step.commands, (message) =>
					Message.GotFindingMessage({ message }),
				),
			}
		case "Telemetry":
			return {
				model: { ...empty, telemetry: built.step.model },
				commands: Command.mapMessages(built.step.commands, (message) =>
					Message.GotTelemetryMessage({ message }),
				),
			}
		case "Dependencies":
			return {
				model: { ...empty, dependencies: built.step.model },
				commands: Command.mapMessages(built.step.commands, (message) =>
					Message.GotDependenciesMessage({ message }),
				),
			}
	}
}

const update = (model: Model, message: Message) =>
	Message.match(message, {
		GotTabsMessage: ({ message: inner }) => {
			if (model.tabs === null) return { model }
			const next = TabsUpdate.update(model.tabs, inner, context)
			return {
				model: { ...model, tabs: next.model },
				commands: Command.mapMessages((next.commands ?? []).filter(isLocalCommand), (child) =>
					Message.GotTabsMessage({ message: child }),
				),
			}
		},
		GotRunMessage: ({ message: inner }) => {
			if (model.run === null) return { model }
			const next = RunUpdate.update(model.run, inner, context)
			return {
				model: { ...model, run: next.model },
				commands: Command.mapMessages((next.commands ?? []).filter(isLocalCommand), (child) =>
					Message.GotRunMessage({ message: child }),
				),
			}
		},
		GotFindingMessage: ({ message: inner }) => {
			if (model.finding === null) return { model }
			const next = FindingUpdate.update(model.finding, inner, context)
			return {
				model: { ...model, finding: next.model },
				commands: Command.mapMessages((next.commands ?? []).filter(isLocalCommand), (child) =>
					Message.GotFindingMessage({ message: child }),
				),
			}
		},
		GotTelemetryMessage: ({ message: inner }) => {
			if (model.telemetry === null) return { model }
			const next = TelemetryUpdate.update(model.telemetry, inner, context)
			return {
				model: { ...model, telemetry: next.model },
				commands: Command.mapMessages((next.commands ?? []).filter(isLocalCommand), (child) =>
					Message.GotTelemetryMessage({ message: child }),
				),
			}
		},
		GotDependenciesMessage: ({ message: inner }) => {
			if (model.dependencies === null) return { model }
			const next = DependenciesUpdate.update(model.dependencies, inner, context)
			return {
				model: { ...model, dependencies: next.model },
				commands: Command.mapMessages((next.commands ?? []).filter(isLocalCommand), (child) =>
					Message.GotDependenciesMessage({ message: child }),
				),
			}
		},
	})

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	model.tabs !== null
		? h.submodel({
				slotId: "security-lab-tabs",
				model: model.tabs,
				view: tabsView,
				viewInputs: { context },
				toParentMessage: (message) => Message.GotTabsMessage({ message }),
			})
		: model.run !== null
			? h.submodel({
					slotId: "security-lab-run",
					model: model.run,
					view: runView,
					viewInputs: { context },
					toParentMessage: (message) => Message.GotRunMessage({ message }),
				})
			: model.finding !== null
				? h.submodel({
						slotId: "security-lab-finding",
						model: model.finding,
						view: findingView,
						viewInputs: { context },
						toParentMessage: (message) => Message.GotFindingMessage({ message }),
					})
				: model.telemetry !== null
					? h.submodel({
							slotId: "security-lab-telemetry",
							model: model.telemetry,
							view: telemetryView,
							viewInputs: { context },
							toParentMessage: (message) => Message.GotTelemetryMessage({ message }),
						})
					: model.dependencies !== null
						? h.submodel({
								slotId: "security-lab-dependencies",
								model: model.dependencies,
								view: dependenciesView,
								viewInputs: { context },
								toParentMessage: (message) => Message.GotDependenciesMessage({ message }),
							})
						: h.empty

export const lab = defineShellLab("Security Center", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/security/code",
	breadcrumbs: (model: Model) =>
		model.tabs !== null
			? tabsCrumbs("code", model.tabs.tab)
			: model.run !== null
				? runCrumbs(model.run)
				: model.finding !== null
					? findingCrumbs(model.finding)
					: model.telemetry !== null
						? tabsCrumbs(model.telemetry.tab)
						: model.dependencies !== null
							? tabsCrumbs("dependencies")
							: [],
})

import { Clock, Effect, Option, Schema, Array as Arr } from "effect"
import { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as AuditLogPage from "../../page/security/audit-log/model"
import * as AuditLogUpdate from "../../page/security/audit-log/update"
import { view as auditLogView } from "../../page/security/audit-log/view"
import * as DependenciesPage from "../../page/security/dependencies/model"
import * as DetectionFormPage from "../../page/security/detection-form/model"
import * as DetectionFormUpdate from "../../page/security/detection-form/update"
import { view as detectionFormView } from "../../page/security/detection-form/view"
import * as DetectionsPage from "../../page/security/detections/model"
import * as DetectionsUpdate from "../../page/security/detections/update"
import { view as detectionsView } from "../../page/security/detections/view"
import * as DependenciesUpdate from "../../page/security/dependencies/update"
import { view as dependenciesView } from "../../page/security/dependencies/view"
import * as FindingPage from "../../page/security/finding/model"
import * as FindingUpdate from "../../page/security/finding/update"
import { breadcrumbsOf as findingCrumbs, view as findingView } from "../../page/security/finding/view"
import { breadcrumbsOf as tabsCrumbs, detectionFormCrumbs } from "../../page/security/kit/layout"
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
	auditLog: Schema.NullOr(AuditLogPage.Model),
	detections: Schema.NullOr(DetectionsPage.Model),
	detectionForm: Schema.NullOr(DetectionFormPage.Model),
	dependencies: Schema.NullOr(DependenciesPage.Model),
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
	GotTabsMessage: { message: TabsPage.Message },
	GotRunMessage: { message: RunPage.Message },
	GotFindingMessage: { message: FindingPage.Message },
	GotTelemetryMessage: { message: TelemetryPage.Message },
	GotAuditLogMessage: { message: AuditLogPage.Message },
	GotDetectionsMessage: { message: DetectionsPage.Message },
	GotDetectionFormMessage: { message: DetectionFormPage.Message },
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
		auditLog: null,
		detections: null,
		detectionForm: null,
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
		case "AuditLog":
			return {
				model: { ...empty, auditLog: built.step.model },
				commands: Command.mapMessages(built.step.commands, (message) =>
					Message.GotAuditLogMessage({ message }),
				),
			}
		case "Detections":
			return {
				model: { ...empty, detections: built.step.model },
				commands: Command.mapMessages(built.step.commands, (message) =>
					Message.GotDetectionsMessage({ message }),
				),
			}
		case "DetectionForm":
			return {
				model: { ...empty, detectionForm: built.step.model },
				commands: Command.mapMessages(built.step.commands, (message) =>
					Message.GotDetectionFormMessage({ message }),
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
				commands: Command.mapMessages(Arr.filter(next.commands ?? [], isLocalCommand), (child) =>
					Message.GotTabsMessage({ message: child }),
				),
			}
		},
		GotRunMessage: ({ message: inner }) => {
			if (model.run === null) return { model }
			const next = RunUpdate.update(model.run, inner, context)
			return {
				model: { ...model, run: next.model },
				commands: Command.mapMessages(Arr.filter(next.commands ?? [], isLocalCommand), (child) =>
					Message.GotRunMessage({ message: child }),
				),
			}
		},
		GotFindingMessage: ({ message: inner }) => {
			if (model.finding === null) return { model }
			const next = FindingUpdate.update(model.finding, inner, context)
			return {
				model: { ...model, finding: next.model },
				commands: Command.mapMessages(Arr.filter(next.commands ?? [], isLocalCommand), (child) =>
					Message.GotFindingMessage({ message: child }),
				),
			}
		},
		GotTelemetryMessage: ({ message: inner }) => {
			if (model.telemetry === null) return { model }
			const next = TelemetryUpdate.update(model.telemetry, inner, context)
			return {
				model: { ...model, telemetry: next.model },
				commands: Command.mapMessages(Arr.filter(next.commands ?? [], isLocalCommand), (child) =>
					Message.GotTelemetryMessage({ message: child }),
				),
			}
		},
		GotAuditLogMessage: ({ message: inner }) => {
			if (model.auditLog === null) return { model }
			const next = AuditLogUpdate.update(model.auditLog, inner, context)
			return {
				model: { ...model, auditLog: next.model },
				commands: Command.mapMessages(Arr.filter(next.commands ?? [], isLocalCommand), (child) =>
					Message.GotAuditLogMessage({ message: child }),
				),
			}
		},
		GotDetectionsMessage: ({ message: inner }) => {
			if (model.detections === null) return { model }
			const next = DetectionsUpdate.update(model.detections, inner, context)
			return {
				model: { ...model, detections: next.model },
				commands: Command.mapMessages(Arr.filter(next.commands ?? [], isLocalCommand), (child) =>
					Message.GotDetectionsMessage({ message: child }),
				),
			}
		},
		GotDetectionFormMessage: ({ message: inner }) => {
			if (model.detectionForm === null) return { model }
			const next = DetectionFormUpdate.update(model.detectionForm, inner, context)
			return {
				model: { ...model, detectionForm: next.model },
				commands: Command.mapMessages(Arr.filter(next.commands ?? [], isLocalCommand), (child) =>
					Message.GotDetectionFormMessage({ message: child }),
				),
			}
		},
		GotDependenciesMessage: ({ message: inner }) => {
			if (model.dependencies === null) return { model }
			const next = DependenciesUpdate.update(model.dependencies, inner, context)
			return {
				model: { ...model, dependencies: next.model },
				commands: Command.mapMessages(Arr.filter(next.commands ?? [], isLocalCommand), (child) =>
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
						: model.detections !== null
							? h.submodel({
									slotId: "security-lab-detections",
									model: model.detections,
									view: detectionsView,
									viewInputs: { context },
									toParentMessage: (message) => Message.GotDetectionsMessage({ message }),
								})
							: model.detectionForm !== null
								? h.submodel({
										slotId: "security-lab-detection-form",
										model: model.detectionForm,
										view: detectionFormView,
										viewInputs: { context },
										toParentMessage: (message) =>
											Message.GotDetectionFormMessage({ message }),
									})
								: model.auditLog !== null
									? h.submodel({
											slotId: "security-lab-audit-log",
											model: model.auditLog,
											view: auditLogView,
											viewInputs: { context },
											toParentMessage: (message) =>
												Message.GotAuditLogMessage({ message }),
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
							: model.auditLog !== null
								? tabsCrumbs("auditLog")
								: model.detections !== null
									? tabsCrumbs("detections")
									: model.detectionForm !== null
										? detectionFormCrumbs()
										: [],
})

import type { V2GcpConnector } from "@maple/domain/http/v2"
import { Command, type Update } from "foldkit"
import { initConfigure } from "../../page/integrations/gcp-configure"
import type { ConfigureModel } from "../../page/integrations/gcp-configure-schema"
import { Message as IntegrationsMessage } from "../../page/integrations/message"
import type { Resources } from "../../platform/resources"
import * as Dialog from "../../ui/dialog"
import * as ToggleGroup from "../../ui/toggle-group"
import { type GcpLabFlags, hubOf, hubStep } from "../gcp-host"
import { fixturesAt, LAB_STATES, type LabState } from "./fixture"
import { Message, type Model } from "./model"

export type Return = Update.Return<Model, Message, Resources>

const toHub = (message: IntegrationsMessage): Message => Message.GotHubMessage({ message })

type Staged = Readonly<{
	connectors: ReadonlyArray<V2GcpConnector>
	configure: ConfigureModel
	pinnedScripts: Model["pinnedScripts"]
}>

/** The wizard each state mounts: a new connection, a connection's Data step, or a run fixture. */
const staged = (nowMs: number, state: LabState): Staged => {
	const fixtures = fixturesAt(nowMs)
	switch (state) {
		case "new":
			return {
				connectors: [],
				configure: initConfigure({ _tag: "New" }, [], true),
				pinnedScripts: null,
			}
		case "configure": {
			const connector = fixtures.configured
			const target = { _tag: "Connection", id: connector.id, stage: "choose" } as const
			return {
				connectors: [connector],
				configure: initConfigure(target, [connector], true),
				pinnedScripts: null,
			}
		}
		default: {
			const fixture = fixtures.apply[state]
			const connector = fixture.connector
			const target = { _tag: "Connection", id: connector.id, stage: "apply" } as const
			return {
				connectors: [connector],
				configure: {
					...initConfigure(target, [connector], true),
					newTitle: "Connect Google Cloud",
					created: fixture.created ? connector : null,
					filter: fixture.filter,
					opened: fixture.opened,
					scripts: fixture.scripts,
				},
				pinnedScripts: fixture.scripts,
			}
		}
	}
}

/** `show(next)`: the state's dialog, remounted from its first step and open. */
const show = (model: Model, state: LabState): Return => {
	const { connectors, configure, pinnedScripts } = staged(model.nowMs, state)
	const shown = Dialog.open(configure.dialog)
	const hub = hubOf(model.nowMs, connectors)
	return {
		model: {
			...model,
			state,
			stateGroup: { ...model.stateGroup, values: [state] },
			pinnedScripts,
			hub: { ...hub, gcpCard: { ...hub.gcpCard, configure: { ...configure, dialog: shown.model } } },
		},
		commands: Command.mapMessages(shown.commands ?? [], (message) =>
			toHub(IntegrationsMessage.GotGcpConfigureDialogMessage({ message })),
		),
	}
}

export const init = (flags: GcpLabFlags): Return =>
	show(
		{
			nowMs: flags.nowMs,
			timeZone: flags.timeZone,
			state: "new",
			stateGroup: ToggleGroup.init({ label: "", values: ["new"] }),
			hub: hubOf(flags.nowMs, []),
			pinnedScripts: null,
		},
		"new",
	)

/** A run fixture's Back and "Try again" are legacy's `noop`s. */
const isFixtureNoop = (message: IntegrationsMessage): boolean =>
	message._tag === "ClickedGcpRunEdit" || message._tag === "ClickedGcpConfigureScriptRetry"

const hubMessage = (model: Model, message: IntegrationsMessage): Return => {
	const pinned = model.pinnedScripts
	if (pinned !== null && isFixtureNoop(message)) return { model }
	const next = hubStep(model.hub, message)
	const configure = next.hub.gcpCard.configure
	// A run fixture keeps its script, whatever the step would read: legacy passes it as a prop.
	const hub =
		pinned === null || configure === null
			? next.hub
			: { ...next.hub, gcpCard: { ...next.hub.gcpCard, configure: { ...configure, scripts: pinned } } }
	const commands =
		pinned === null
			? next.commands
			: next.commands.filter((command) => command.name !== "LoadGcpConfigureScripts")
	return { model: { ...model, hub }, commands: Command.mapMessages(commands, toHub) }
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		// Legacy's group is multiple: pressing the current state again changes nothing.
		GotStateGroupMessage: ({ message: inner }) => {
			const step = ToggleGroup.update(model.stateGroup, inner)
			const commands = Command.mapMessages(step.commands ?? [], (child) =>
				Message.GotStateGroupMessage({ message: child }),
			)
			const next = LAB_STATES.find(
				(state) => state !== model.state && step.model.values.includes(state),
			)
			if (next === undefined)
				return { model: { ...model, stateGroup: { ...step.model, values: [model.state] } }, commands }
			const shown = show({ ...model, stateGroup: step.model }, next)
			return { ...shown, commands: [...commands, ...(shown.commands ?? [])] }
		},
		ClickedReopen: () => show(model, model.state),
		GotHubMessage: ({ message: inner }) => hubMessage(model, inner),
	})

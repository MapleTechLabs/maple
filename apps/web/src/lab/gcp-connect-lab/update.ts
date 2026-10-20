import type { V2GcpConnector } from "@maple/domain/http/v2"
import { Command, type Update } from "foldkit"
import { initConfigure } from "../../page/integrations/gcp-configure"
import type { ConfigureModel } from "../../page/integrations/gcp-configure-schema"
import { Message as IntegrationsMessage } from "../../page/integrations/message"
import type { Resources } from "../../platform/resources"
import * as Dialog from "../../ui/dialog"
import * as ToggleGroup from "../../ui/toggle-group"
import { type GcpLabFlags, hubOf, hubStep } from "../gcp-host"
import { fixturesAt, LAB_STATES, type LabState, type MethodApplyState } from "./fixture"
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
		case "method":
		case "method-code": {
			const { connector, method } = fixtures.method[state]
			const target = { _tag: "Connection", id: connector.id, stage: "apply" } as const
			const base = initConfigure(target, [connector], true)
			return {
				connectors: [connector],
				configure: {
					...base,
					newTitle: "Connect Google Cloud",
					created: connector,
					connectionStage: "method",
					method,
					flavourGroup: { ...base.flavourGroup, values: [method === "alchemy" ? "alchemy" : "terraform"] },
				},
				pinnedScripts: null,
			}
		}
		default: {
			const fixture = isMethodApplyState(state) ? fixtures.methodApply[state] : fixtures.apply[state]
			const method = isMethodApplyState(state) ? fixtures.methodApply[state].method : "script"
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
					method,
					sinkExisted: connector.applied_logs_enabled === true,
				},
				pinnedScripts: fixture.scripts,
			}
		}
	}
}

const METHOD_APPLY_STATES: ReadonlyArray<LabState> = [
	"manual-project",
	"manual-org",
	"manual-failed",
	"manual-removal",
	"terraform",
	"terraform-removal",
	"alchemy",
	"alchemy-org",
	"method-confirmed",
]
const isMethodApplyState = (state: LabState): state is MethodApplyState => METHOD_APPLY_STATES.includes(state)

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

/** A run fixture's Back, "Try again" and "I've removed them" do nothing. */
const isFixtureNoop = (message: IntegrationsMessage): boolean =>
	message._tag === "ClickedGcpRunEdit" ||
	message._tag === "ClickedGcpConfigureScriptRetry" ||
	message._tag === "ClickedGcpConfirmRemoval"

const isMethodState = (state: LabState): boolean => state === "method" || state === "method-code"

const hubMessage = (model: Model, message: IntegrationsMessage): Return => {
	const pinned = model.pinnedScripts
	if (pinned !== null && isFixtureNoop(message)) return { model }
	// `MethodLab`: Back is a `noop`, Continue closes.
	if (isMethodState(model.state) && message._tag === "ClickedGcpRunEdit") return { model }
	if (isMethodState(model.state) && message._tag === "ClickedGcpMethodContinue")
		return hubMessage(model, IntegrationsMessage.ClosedGcpConfigure())
	const next = hubStep(model.hub, message)
	const configure = next.hub.gcpCard.configure
	// A run fixture keeps its script, whatever the step would read.
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
		// The group is multiple: pressing the current state again changes nothing.
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

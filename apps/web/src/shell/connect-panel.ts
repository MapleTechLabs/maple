import { getServiceOverview } from "@maple/web-data/warehouse/services"
import { Effect, Layer, Schema } from "effect"
import { Block, Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { currentWindow, TimeWindow } from "../data/time-range"
import { MapleApiV2Client } from "../platform/api-clients"
import { readEffectiveTimeZone } from "../platform/time-zone"
import * as CopyButton from "../ui/copy-button"
import * as Popover from "../ui/popover"

// The Connect button: the top bar's popover with
// the ingest endpoint and keys, the live connection pill and the MCP card.

export const POPOVER_ID = "shell-connect"

/** `retainedQueryV2("ingestKeys", "retrieve")`: both keys from one admin-only read. */
export const Keys = Schema.Union([
	Schema.TaggedStruct("Loading", {}),
	Schema.TaggedStruct("Ready", { publicKey: Schema.String, privateKey: Schema.String }),
	Schema.TaggedStruct("Failed", {}),
])
export type Keys = typeof Keys.Type

export const ServiceRow = Schema.Struct({ serviceName: Schema.String, spanCount: Schema.Number })

export const Model = Schema.Struct({
	popover: Popover.PopoverBlock.Model,
	/** The org the keys and overview were read for; another org's late answer is dropped. */
	orgId: Schema.NullOr(Schema.String),
	keys: Keys,
	/** `useIngestConnection`'s last-hour overview; empty until it lands, kept when a poll fails. */
	services: Schema.Array(ServiceRow),
	/** `useEffectiveTimeRange(.., "1h")`: resolved on open and again on each 15 s poll. */
	window: Schema.NullOr(TimeWindow),
	/** An overview read is out: a poll waits for it, so a slow answer still lands. */
	isOverviewInFlight: Schema.Boolean,
	/** The last overview read failed: the pill says the status is unknown until one succeeds. */
	isOverviewFailed: Schema.Boolean,
	/** The overview read sent last, across openings; only its answer counts. */
	overviewRequest: Schema.Number,
	/** Each copy button's own status: the endpoint, both keys, the skill command, the MCP endpoint. */
	copyEndpoint: CopyButton.CopyButtonBlock.Model,
	copyPublicKey: CopyButton.CopyButtonBlock.Model,
	copyPrivateKey: CopyButton.CopyButtonBlock.Model,
	copySkill: CopyButton.CopyButtonBlock.Model,
	copyMcp: CopyButton.CopyButtonBlock.Model,
	/** `CopyableField masked`: each key's reveal toggle, reset when the panel unmounts. */
	isPublicKeyVisible: Schema.Boolean,
	isPrivateKeyVisible: Schema.Boolean,
})
export type Model = typeof Model.Type

const initialModel = (): Model => ({
	popover: Popover.init(POPOVER_ID, { align: "end" }),
	orgId: null,
	keys: { _tag: "Loading" },
	services: [],
	window: null,
	isOverviewInFlight: false,
	isOverviewFailed: false,
	overviewRequest: 0,
	copyEndpoint: CopyButton.CopyButtonBlock.init().model,
	copyPublicKey: CopyButton.CopyButtonBlock.init().model,
	copyPrivateKey: CopyButton.CopyButtonBlock.init().model,
	copySkill: CopyButton.CopyButtonBlock.init().model,
	copyMcp: CopyButton.CopyButtonBlock.init().model,
	isPublicKeyVisible: false,
	isPrivateKeyVisible: false,
})

export const Message = defineMessageUnion({
	/** The Connect button: it opens the popover (and the panel's reads) or closes it. */
	ClickedTrigger: {},
	/** The panel left the popover: it closed, whatever closed it. */
	UnmountedPanel: {},
	SucceededLoadKeys: { orgId: Schema.String, publicKey: Schema.String, privateKey: Schema.String },
	FailedLoadKeys: { orgId: Schema.String },
	ResolvedWindow: { orgId: Schema.String, window: TimeWindow },
	SucceededLoadOverview: {
		orgId: Schema.String,
		request: Schema.Number,
		services: Schema.Array(ServiceRow),
	},
	FailedLoadOverview: { orgId: Schema.String, request: Schema.Number },
	/** `useIntervalRefresh(refresh, { intervalMs: 15000 })` while the panel is open and the tab shown. */
	TickedPoll: {},
	ClickedRevealPublicKey: {},
	ClickedRevealPrivateKey: {},
})
export type Message = typeof Message.Type

export const ConnectPanelDefinition = Block.makeDefinition("ConnectPanel", { Model, Message })
const { makeStep } = ConnectPanelDefinition

export const FetchKeys = ConnectPanelDefinition.makeCommand("FetchConnectIngestKeys", {
	args: { orgId: Schema.String },
	messages: [Message.SucceededLoadKeys, Message.FailedLoadKeys],
	handler: function* () {
		return ({ orgId }) =>
			Effect.flatMap(MapleApiV2Client, (client) => client.ingestKeys.retrieve()).pipe(
				Effect.map((keys) =>
					Message.SucceededLoadKeys({
						orgId,
						publicKey: keys.public_key,
						privateKey: keys.private_key,
					}),
				),
				Effect.orElseSucceed(() => Message.FailedLoadKeys({ orgId })),
			)
	},
})

/** The effective zone's last hour, snapped as a mounted `useEffectiveTimeRange` resolves it. */
export const ResolveWindow = ConnectPanelDefinition.makeCommand("ResolveConnectWindow", {
	args: { orgId: Schema.String },
	messages: [Message.ResolvedWindow],
	handler: function* () {
		return ({ orgId }) =>
			Effect.flatMap(readEffectiveTimeZone, (timeZone) =>
				currentWindow({ preset: "1h", snap: true, timeZone }),
			).pipe(Effect.map((window) => Message.ResolvedWindow({ orgId, window })))
	},
})

/** `getServiceOverviewResultAtom({ data: { startTime, endTime } })`, the pin applied ("top"). */
export const FetchOverview = ConnectPanelDefinition.makeCommand("FetchConnectOverview", {
	args: {
		orgId: Schema.String,
		window: TimeWindow,
		request: Schema.Number,
		pinnedNamespace: Schema.NullOr(Schema.String),
	},
	messages: [Message.SucceededLoadOverview, Message.FailedLoadOverview],
	handler: function* () {
		return ({ orgId, window, request, pinnedNamespace }) =>
			getServiceOverview({
				data: pinnedNamespace === null ? window : { ...window, namespaces: [pinnedNamespace] },
			}).pipe(
				Effect.map((response) =>
					Message.SucceededLoadOverview({
						orgId,
						request,
						services: response.data.map((row) => ({
							serviceName: String(row.serviceName),
							spanCount: row.spanCount ?? 0,
						})),
					}),
				),
				Effect.orElseSucceed(() => Message.FailedLoadOverview({ orgId, request })),
			)
	},
})

// UPDATE

/** The signed-in org and its namespace pin, which the overview read applies. */
export type Context = Readonly<{ orgId: string | null; pinnedNamespace: string | null }>

type StepReturn = Readonly<{
	model: Model
	commands?: ReadonlyArray<ReturnType<typeof FetchKeys> | ReturnType<typeof ResolveWindow>>
}>

/** The popover's own init builds the field; its open and close are this Block's to ask for. */
export const PopoverBinding = ConnectPanelDefinition.makeBinding(Popover.PopoverBlock, {
	field: "popover",
	init: false,
})
export const CopyEndpointBinding = ConnectPanelDefinition.makeBinding(CopyButton.CopyButtonBlock, {
	field: "copyEndpoint",
	init: false,
})
export const CopyPublicKeyBinding = ConnectPanelDefinition.makeBinding(CopyButton.CopyButtonBlock, {
	field: "copyPublicKey",
	init: false,
})
export const CopyPrivateKeyBinding = ConnectPanelDefinition.makeBinding(CopyButton.CopyButtonBlock, {
	field: "copyPrivateKey",
	init: false,
})
export const CopySkillBinding = ConnectPanelDefinition.makeBinding(CopyButton.CopyButtonBlock, {
	field: "copySkill",
	init: false,
})
export const CopyMcpBinding = ConnectPanelDefinition.makeBinding(CopyButton.CopyButtonBlock, {
	field: "copyMcp",
	init: false,
})

export const ConnectPanelComposition = ConnectPanelDefinition.makeComposition({
	bindings: [
		PopoverBinding,
		CopyEndpointBinding,
		CopyPublicKeyBinding,
		CopyPrivateKeyBinding,
		CopySkillBinding,
		CopyMcpBinding,
	],
})
export type ConnectPanelViewBuilder = Block.ViewBuilderFor<typeof ConnectPanelComposition>

/** `{open && <ConnectPanel />}` unmounting: the panel's state goes; the org's keys and request count stay. */
const unmounted = (model: Model): Model => ({
	...initialModel(),
	popover: model.popover,
	orgId: model.orgId,
	keys: model.keys,
	overviewRequest: model.overviewRequest,
})

/** Opening mounts the panel's reads; the retained keys answer a reopen in the same org. */
const opened = (model: Model, context: Context): StepReturn => {
	if (context.orgId === null) return { model }
	const orgId = context.orgId
	const isSameOrg = model.orgId === orgId
	// A failure or another org reads the keys again.
	const keys: Keys = isSameOrg ? model.keys : { _tag: "Loading" }
	return {
		model: {
			...model,
			orgId,
			keys,
			services: [],
			window: null,
			isOverviewInFlight: false,
			isOverviewFailed: false,
		},
		commands: [...(keys._tag === "Ready" ? [] : [FetchKeys({ orgId })]), ResolveWindow({ orgId })],
	}
}

const isCurrent = (model: Model, orgId: string, request: number) =>
	model.orgId === orgId && model.overviewRequest === request

export const init = ConnectPanelComposition.makeInit(() => ({ model: initialModel() }))

export const update = ConnectPanelComposition.makeUpdate.withContext((context: Context) => ({
	ClickedTrigger: (model) =>
		model.popover.isOpen
			? Update.combineSteps(model, [
					makeStep(() => ({ model: unmounted(model) })),
					PopoverBinding.requestClose(),
				])
			: Update.combineSteps(model, [
					makeStep(() => opened(model, context)),
					PopoverBinding.requestOpen({ isPressOpened: true }),
				]),
	UnmountedPanel: (model) => ({ model: unmounted(model) }),
	SucceededLoadKeys: (model, { orgId, publicKey, privateKey }) =>
		model.orgId === orgId
			? { model: { ...model, keys: { _tag: "Ready", publicKey, privateKey } } }
			: { model },
	FailedLoadKeys: (model, { orgId }) =>
		model.orgId === orgId ? { model: { ...model, keys: { _tag: "Failed" } } } : { model },
	// The open read and every poll: the overview follows the clock, not the window at open.
	ResolvedWindow: (model, { orgId, window }) =>
		model.orgId === orgId && model.popover.isOpen
			? {
					model: {
						...model,
						window,
						isOverviewInFlight: true,
						overviewRequest: model.overviewRequest + 1,
					},
					commands: [
						FetchOverview({
							orgId,
							window,
							request: model.overviewRequest + 1,
							pinnedNamespace: context.pinnedNamespace,
						}),
					],
				}
			: { model },
	SucceededLoadOverview: (model, { orgId, request, services }) =>
		isCurrent(model, orgId, request)
			? { model: { ...model, services, isOverviewInFlight: false, isOverviewFailed: false } }
			: { model },
	// One failed poll keeps the services already found, so the pill does not un-detect them.
	FailedLoadOverview: (model, { orgId, request }) =>
		isCurrent(model, orgId, request)
			? { model: { ...model, isOverviewInFlight: false, isOverviewFailed: true } }
			: { model },
	TickedPoll: (model) =>
		model.popover.isOpen && model.window !== null && model.orgId !== null && !model.isOverviewInFlight
			? { model, commands: [ResolveWindow({ orgId: model.orgId })] }
			: { model },
	ClickedRevealPublicKey: (model) => ({
		model: { ...model, isPublicKeyVisible: !model.isPublicKeyVisible },
	}),
	ClickedRevealPrivateKey: (model) => ({
		model: { ...model, isPrivateKeyVisible: !model.isPrivateKeyVisible },
	}),
}))

/** Parent-initiated: the 15 s poll's tick. */
export const operations = { informOfPollTick: Message.TickedPoll }

export const EffectsLayer = Layer.mergeAll(FetchKeys.layer, ResolveWindow.layer, FetchOverview.layer)

/** The 15 s poll runs while the panel is open on a resolved window. */
export const isPolling = (model: Model): boolean => model.popover.isOpen && model.window !== null

// DERIVED (`useIngestConnection`)

/** The org's own services: the seeded `demo-` ones do not count as a connection. */
export const realServices = (model: Model): ReadonlyArray<typeof ServiceRow.Type> =>
	model.services.filter((row) => !row.serviceName.startsWith("demo-"))

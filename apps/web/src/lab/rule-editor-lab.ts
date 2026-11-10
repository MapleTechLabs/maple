import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { AlertRulePreviewResponse } from "@maple/domain/http"
import { Clock, Effect, Option, Result, Schema, Array as Arr, String as Str } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { PageContext } from "../page/contract"
import { chainDestinations, chainUuid, populatedChains } from "../page/alerts/shared/escalation-test-fixtures"
import { scopedAnomalyRuleRow } from "../page/alerts/shared/anomaly-test-fixtures"
import { DESTINATION_ID, destinationRow, ORG, ruleId, ruleRow } from "../page/kit/alert-test-rows"
import { windowMsOf } from "../page/alerts/editor/derive-rows"
import { RuleCard } from "../page/alerts/editor/form"
import { init as editorInit } from "../page/alerts/editor/init"
import { Message as EditorMessage } from "../page/alerts/editor/message"
import { Model as EditorModel } from "../page/alerts/editor/model"
import { update as editorUpdate } from "../page/alerts/editor/update"
import { view as editorView } from "../page/alerts/editor/view"
import type { Resources } from "../platform/resources"

// `/lab/rule-editor`: the alert rule editor over fixture rows, no API needed. `?variant=` picks a
// saved rule (`populated`), a blank new rule (`new`) or a scoped anomaly rule (`anomaly`);
// `?open=condition,notify` opens cards.

export const Variant = Schema.Literals(["populated", "new", "anomaly"])
export type Variant = typeof Variant.Type

export const Flags = Schema.Struct({ nowMs: Schema.Number, variant: Variant, open: Schema.Array(RuleCard) })
export type Flags = typeof Flags.Type

const decodeVariant = Schema.decodeUnknownOption(Variant)
const decodeCard = Schema.decodeUnknownOption(RuleCard)
const searchParams = Effect.sync(() => new URLSearchParams(window.location.search))

/**
 * The boot clock, `?variant=` and `?open=` (the cards opened for editing, comma-separated; a saved
 * rule opens on its summaries). `?theme=light|dark` sets the theme class as `index.html` does.
 */
export const flags: Effect.Effect<Flags> = Effect.all({
	nowMs: Clock.currentTimeMillis,
	variant: Effect.sync(() => {
		const params = new URLSearchParams(window.location.search)
		const theme = params.get("theme")
		if (theme === "light" || theme === "dark") {
			document.documentElement.classList.remove("light", "dark")
			document.documentElement.classList.add(theme)
			document.documentElement.style.colorScheme = theme
		}
		return Option.getOrElse(decodeVariant(params.get("variant")), (): Variant => "populated")
	}),
	open: Effect.map(searchParams, (params) =>
		Arr.flatMap(Str.split(params.get("open") ?? "", ","), (card) => Option.toArray(decodeCard(card))),
	),
})

export const Model = Schema.Struct({ variant: Variant, editor: EditorModel })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotEditorMessage: { message: EditorMessage } })
export type Message = typeof Message.Type

const LAB_CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)(ORG),
	pinnedNamespace: null,
	timeZone: "UTC",
}

const run = (model: EditorModel, messages: ReadonlyArray<EditorMessage>): EditorModel =>
	Arr.reduce(messages, model, (current, message) => editorUpdate(current, message, LAB_CONTEXT).model)

const DRAFT_ID = "6f1c2e3a-0000-4000-8000-000000000001"
const MIN = 60_000

const CHAT_DESTINATION = destinationRow({
	name: "Checkout on-call",
	type: "chat",
	config_json: { summary: "Slack · acme", channelLabel: "#checkout-oncall" },
})

/** A saved error rate rule on checkout-api, two tiers, the critical one starting a chain. */
const ERROR_RATE_RULE = ruleRow(2, {
	name: "Checkout error rate",
	notes: "Pages the checkout team. Runbook: wiki/checkout/errors",
	signal_type: "error_rate",
	service_names_json: ["checkout-api"],
	environments_json: ["production"],
	tags_json: ["checkout", "tier-1"],
	severity: "warning",
	threshold: 0.05,
	thresholds_json: [
		{
			severity: "warning",
			value: 0.05,
			upper: null,
			recoveryValue: null,
			destinationIds: [DESTINATION_ID],
		},
		{
			severity: "critical",
			value: 0.1,
			upper: null,
			recoveryValue: null,
			destinationIds: [],
			escalationChainId: chainUuid(1),
		},
	],
	consecutive_breaches_required: 3,
})

const decodePreview = Schema.decodeUnknownSync(AlertRulePreviewResponse)

/** The preview window's error rate around 2%, with two bursts over the 5% line. */
const previewOf = (window: Readonly<{ min: number; max: number }>): AlertRulePreviewResponse => {
	const bucketMs = 30 * MIN
	const count = Math.max(1, Math.floor((window.max - window.min) / bucketMs))
	const at = (share: number) => Math.round(count * share)
	const bursts = [
		{ from: at(0.36), to: at(0.38) },
		{ from: at(0.75), to: at(0.76) },
	]
	const points = Arr.map(Arr.range(0, count - 1), (i) => {
		const isBurst = Arr.some(bursts, (burst) => i >= burst.from && i < burst.to)
		const value = isBurst ? 0.072 + Math.sin(i) * 0.008 : 0.02 + Math.sin(i * 0.7) * 0.006
		const point = { bucket: new Date(window.min + i * bucketMs).toISOString(), value, sampleCount: 300 }
		return value > 0.05
			? { ...point, status: "breached", level: "warning" }
			: { ...point, status: "healthy" }
	})
	return decodePreview({
		bucketSeconds: bucketMs / 1000,
		windowMinutes: 5,
		threshold: 0.05,
		thresholdUpper: null,
		thresholds: [
			{ severity: "warning", value: 0.05, upper: null, recoveryValue: null, destinationIds: [] },
		],
		comparator: "gt",
		truncatedToStart: null,
		series: [{ groupKey: "all", points }],
		wouldFire: Arr.map(bursts, (burst) => ({
			groupKey: "all",
			start: new Date(window.min + burst.from * bucketMs).toISOString(),
			end: new Date(window.min + burst.to * bucketMs).toISOString(),
			severity: "warning",
		})),
	})
}

const opened = (search: EditorModel["search"], nowMs: number, rules: ReadonlyArray<typeof ERROR_RATE_RULE>) =>
	run(editorInit({ _tag: "AlertsCreate", search }, LAB_CONTEXT).model, [
		EditorMessage.GeneratedDraftId({ id: DRAFT_ID }),
		EditorMessage.CompletedReadClock({ nowMs }),
		EditorMessage.CompletedReadGrants({ grants: Policy.allPermissions }),
		EditorMessage.UpdatedDestinations({ orgId: ORG, rows: [CHAT_DESTINATION, ...chainDestinations] }),
		EditorMessage.UpdatedRules({ orgId: ORG, rows: rules }),
		EditorMessage.CompletedFetchEscalationChains({ chains: populatedChains([]) }),
	])

/** The preview the lab's "API" answers with: the fixture series, or no data for a new rule's org. */
const previewAnswer = (variant: Variant, model: EditorModel): EditorMessage =>
	EditorMessage.CompletedFetchPreview({
		key: model.preview.key ?? "",
		isSaved: false,
		result:
			variant === "new" ? Result.fail({ message: null }) : Result.succeed(previewOf(windowMsOf(model))),
	})

type EditorCommands = ReadonlyArray<Command.Command<EditorMessage, never, Resources>>
type Step = Readonly<{ model: EditorModel; commands: EditorCommands }>

/** A user action on the seeded page: unlike the setup reads, its commands run (a dialog's exit). */
const act = (step: Step, message: EditorMessage): Step => {
	const next = editorUpdate(step.model, message, LAB_CONTEXT)
	return { model: next.model, commands: [...step.commands, ...(next.commands ?? [])] }
}

const seed = (variant: Variant, open: ReadonlyArray<RuleCard>, nowMs: number): Step => {
	const loaded =
		variant === "new"
			? opened({}, nowMs, [])
			: variant === "anomaly"
				? opened({ ruleId: ruleId(8) }, nowMs, [scopedAnomalyRuleRow()])
				: opened({ ruleId: ruleId(2) }, nowMs, [ERROR_RATE_RULE])
	const answered: Step = { model: run(loaded, [previewAnswer(variant, loaded)]), commands: [] }
	// "Start blank" closes the templates dialog: its exit transition has to run, or it stays mounted.
	const started = variant === "new" ? act(answered, EditorMessage.ClickedStartBlank()) : answered
	return Arr.reduce(open, started, (step, card) => act(step, EditorMessage.ClickedExpandCard({ card })))
}

// Reads and writes need a session; the lab keeps the editor's local commands (chart, focus, menus).
const BLOCKED = /^(FetchAlert|RunAlert|SaveAlert|TrackAlert|ReloadAlert|ReadAlertEditorGrants|GenerateAlert)/
const isPreviewFetch = (command: Readonly<{ name: string }>) => command.name === "FetchAlertEditorPreview"

const toLab = (commands: ReadonlyArray<Command.Command<EditorMessage, never, Resources>> | undefined) =>
	Command.mapMessages(
		Arr.filter(commands ?? [], (command) => !BLOCKED.test(command.name)),
		(message) => Message.GotEditorMessage({ message }),
	)

export const init = (labFlags: Flags): Update.Return<Model, Message, Resources> => {
	const started = editorInit({ _tag: "AlertsCreate", search: {} }, LAB_CONTEXT)
	const seeded = seed(labFlags.variant, labFlags.open, labFlags.nowMs)
	return {
		model: { variant: labFlags.variant, editor: seeded.model },
		commands: toLab([...(started.commands ?? []), ...seeded.commands]),
	}
}

export const update = (model: Model, message: Message): Update.Return<Model, Message, Resources> => {
	const next = editorUpdate(model.editor, message.message, LAB_CONTEXT)
	// An edit that asks for a new preview gets the lab's answer at once, in place of the API's.
	const editor = Arr.some(next.commands ?? [], isPreviewFetch)
		? run(next.model, [previewAnswer(model.variant, next.model)])
		: next.model
	return { model: { ...model, editor }, commands: toLab(next.commands) }
}

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("flex h-dvh flex-col bg-background")],
		[
			h.submodel({
				slotId: "rule-editor-lab",
				model: model.editor,
				view: editorView,
				viewInputs: { context: LAB_CONTEXT },
				toParentMessage: (message) => Message.GotEditorMessage({ message }),
			}),
		],
	)

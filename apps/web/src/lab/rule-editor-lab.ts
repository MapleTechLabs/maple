import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { AlertRulePreviewResponse } from "@maple/domain/http"
import { Clock, Effect, Option, Result, Schema, Array as Arr } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { PageContext } from "../page/contract"
import { chainDestinations, chainUuid, populatedChains } from "../page/alerts/shared/escalation-test-fixtures"
import { scopedAnomalyRuleRow } from "../page/alerts/shared/anomaly-test-fixtures"
import { DESTINATION_ID, destinationRow, ORG, ruleId, ruleRow } from "../page/alerts/shared/test-rows"
import { init as editorInit } from "../page/alerts/editor/init"
import { Message as EditorMessage } from "../page/alerts/editor/message"
import { Model as EditorModel } from "../page/alerts/editor/model"
import { update as editorUpdate } from "../page/alerts/editor/update"
import { view as editorView } from "../page/alerts/editor/view"
import type { Resources } from "../platform/resources"

// `/lab/rule-editor`: the alert rule editor over fixture rows, no API needed. `?variant=` picks a
// saved rule (`populated`), a blank new rule (`new`) or a scoped anomaly rule (`anomaly`).

export const Variant = Schema.Literals(["populated", "new", "anomaly"])
export type Variant = typeof Variant.Type

export const Flags = Schema.Struct({ nowMs: Schema.Number, variant: Variant })
export type Flags = typeof Flags.Type

const decodeVariant = Schema.decodeUnknownOption(Variant)

/** The boot clock and `?variant=`; `?theme=light|dark` sets the theme class as `index.html` does. */
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

/** A week of error rate around 2%, with two bursts over the 5% line. */
const previewOf = (nowMs: number): AlertRulePreviewResponse => {
	const bucketMs = 30 * MIN
	const start = nowMs - 7 * 24 * 60 * MIN
	const count = Math.floor((nowMs - start) / bucketMs)
	const burst = (i: number) => (i > 120 && i < 128) || (i > 250 && i < 255)
	const points = Arr.map(Arr.range(0, count - 1), (i) => {
		const value = burst(i) ? 0.072 + Math.sin(i) * 0.008 : 0.02 + Math.sin(i * 0.7) * 0.006
		const point = { bucket: new Date(start + i * bucketMs).toISOString(), value, sampleCount: 300 }
		return value > 0.05
			? { ...point, status: "breached", level: "warning" }
			: { ...point, status: "healthy" }
	})
	const span = (from: number, to: number) => ({
		groupKey: "all",
		start: new Date(start + from * bucketMs).toISOString(),
		end: new Date(start + to * bucketMs).toISOString(),
		severity: "warning",
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
		wouldFire: [span(123, 128), span(252, 255)],
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

const withPreview = (model: EditorModel, nowMs: number): EditorModel =>
	run(model, [
		EditorMessage.CompletedFetchPreview({
			key: model.preview.key ?? "",
			isSaved: false,
			result: Result.succeed(previewOf(nowMs)),
		}),
	])

const seed = (variant: Variant, nowMs: number): EditorModel => {
	if (variant === "new") return run(opened({}, nowMs, []), [EditorMessage.ClickedStartBlank()])
	if (variant === "anomaly") return opened({ ruleId: ruleId(8) }, nowMs, [scopedAnomalyRuleRow()])
	return withPreview(opened({ ruleId: ruleId(2) }, nowMs, [ERROR_RATE_RULE]), nowMs)
}

// Reads and writes need a session; the lab keeps the editor's local commands (chart, focus, menus).
const BLOCKED = /^(FetchAlert|RunAlert|SaveAlert|TrackAlert|ReloadAlert|ReadAlertEditorGrants|GenerateAlert)/

const toLab = (commands: ReadonlyArray<Command.Command<EditorMessage, never, Resources>> | undefined) =>
	Command.mapMessages(
		Arr.filter(commands ?? [], (command) => !BLOCKED.test(command.name)),
		(message) => Message.GotEditorMessage({ message }),
	)

export const init = (labFlags: Flags): Update.Return<Model, Message, Resources> => {
	const started = editorInit({ _tag: "AlertsCreate", search: {} }, LAB_CONTEXT)
	return {
		model: { variant: labFlags.variant, editor: seed(labFlags.variant, labFlags.nowMs) },
		commands: toLab(started.commands),
	}
}

export const update = (model: Model, message: Message): Update.Return<Model, Message, Resources> => {
	const next = editorUpdate(model.editor, message.message, LAB_CONTEXT)
	return { model: { ...model, editor: next.model }, commands: toLab(next.commands) }
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

import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { Effect, Option, Result, Schema, Array as Arr } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as RuleMessage from "../page/settings/ingest-rule/message"
import * as RuleModel from "../page/settings/ingest-rule/model"
import type { LogSample, PreviewSignal, Samples } from "../page/settings/ingest-rule/preview"
import { init as ruleInit, update as ruleUpdate } from "../page/settings/ingest-rule/update"
import { view as ruleView } from "../page/settings/ingest-rule/view"
import { ORG } from "../page/kit/alert-test-rows"
import type { PageContext } from "../page/contract"
import type { Resources } from "../platform/resources"
import { keepLocal } from "./local-commands"

// `/lab/ingest-rule`: the ingest rule editor over fixture logs. `?state=` picks a parse rule.

export const LabState = Schema.Literals(["parse-json", "parse-grok", "parse-steps"])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "parse-json",
	),
}))

export const Model = Schema.Struct({ state: LabState, page: RuleModel.Model })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotPageMessage: { message: RuleMessage.Message } })
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>

const CONTEXT: PageContext = { orgId: Schema.decodeSync(OrgId)(ORG), pinnedNamespace: null, timeZone: "UTC" }
const M = RuleMessage.Message

const log = (serviceName: string, body: string): LogSample => ({
	serviceName,
	body,
	severityNumber: 0,
	severityText: "",
	traceId: "",
	logAttributes: {},
	resourceAttributes: {},
})

const JSON_LOGS = [
	log(
		"checkout",
		'{"level":"error","msg":"payment declined","order":{"id":"ord_8812","total":42.5},"ts":"2026-11-23T09:14:02.381Z"}',
	),
	log(
		"checkout",
		'{"level":"info","msg":"order placed","order":{"id":"ord_8813","total":19},"ts":"2026-11-23T09:14:03.002Z"}',
	),
	log("checkout", "{truncated: payload was cut off"),
	log(
		"checkout",
		'{"level":"warn","msg":"retrying card network","attempt":2,"ts":"2026-11-23T09:14:04.517Z"}',
	),
]

const ACCESS_LOGS = [
	log(
		"edge",
		'203.0.113.9 - - [23/Nov/2026:09:14:02 +0000] "GET /api/orders?page=2 HTTP/1.1" 200 5123 "-" "curl/8.4.0"',
	),
	log(
		"edge",
		'198.51.100.24 - ana [23/Nov/2026:09:14:03 +0000] "POST /api/checkout HTTP/2.0" 502 0 "https://shop.example.com/cart" "Mozilla/5.0"',
	),
	log("edge", "upstream connect error or disconnect/reset before headers"),
	log(
		"edge",
		'192.0.2.77 - - [23/Nov/2026:09:14:05 +0000] "GET /healthz HTTP/1.1" 200 2 "-" "kube-probe/1.31"',
	),
]

const run = (model: RuleModel.Model, messages: ReadonlyArray<RuleMessage.Message>) =>
	Arr.reduce(messages, model, (current, message) => ruleUpdate(current, message, CONTEXT).model)

const pageFor = (state: LabState): RuleModel.Model => {
	const entered = ruleInit(
		{ _tag: "IngestRuleNew", search: state === "parse-grok" ? {} : { template: "parse-json-logs" } },
		CONTEXT,
	).model
	const session = M.CompletedFetchSession({ orgId: ORG, grants: Policy.grantsOf(["org:engineer"]) })
	const samples = (rows: ReadonlyArray<LogSample>) => (model: RuleModel.Model) =>
		M.CompletedFetchSamples({ key: model.samplesKey, result: Result.succeed({ _tag: "logs", rows }) })
	if (state === "parse-grok") {
		const parsing = run(entered, [
			session,
			M.ChangedText({ part: "name", value: "Parse edge access logs" }),
			M.PickedAction({ actionType: "parse" }),
			M.ChangedStepKind({ id: 1, kind: "grok" }),
			M.ChangedStepText({ id: 1, part: "pattern", value: "%{COMBINEDAPACHELOG}" }),
		])
		return run(parsing, [samples(ACCESS_LOGS)(parsing)])
	}
	const json = run(entered, [session])
	const steps =
		state === "parse-steps"
			? run(json, [
					M.AddedStep({ kind: "timestamp" }),
					M.ChangedStepText({ id: 3, part: "key", value: "ts" }),
				])
			: json
	return run(steps, [samples(JSON_LOGS)(steps)])
}

/** What the lab answers a preview request with: its fixture logs, and no spans. */
const fixtureSamples = (state: LabState, signal: PreviewSignal): Samples =>
	signal === "traces"
		? { _tag: "traces", rows: [] }
		: { _tag: "logs", rows: state === "parse-grok" ? ACCESS_LOGS : JSON_LOGS }

export const init = (flags: Flags): Return => ({ model: { state: flags.state, page: pageFor(flags.state) } })

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotPageMessage: ({ message: child }) => {
			const next = ruleUpdate(model.page, child, CONTEXT)
			// The real fetch is dropped below, so a pending preview request is answered from the
			// fixtures, even one that reuses the last request's key.
			const page = !AsyncData.isLoading(next.model.samples)
				? next.model
				: run(next.model, [
						M.CompletedFetchSamples({
							key: next.model.samplesKey,
							result: Result.succeed(fixtureSamples(model.state, next.model.previewSignal)),
						}),
					])
			return {
				model: { ...model, page },
				commands: Command.mapMessages(keepLocal(next.commands), (inner) =>
					Message.GotPageMessage({ message: inner }),
				),
			}
		},
	})

export const breadcrumbs = () => [
	{ label: "Settings", href: "/settings" },
	{ label: "Ingestion", href: "/settings/ingestion" },
	{ label: "New rule" },
]

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.submodel({
		slotId: "lab-ingest-rule",
		model: model.page,
		view: ruleView,
		viewInputs: { context: CONTEXT },
		toParentMessage: (message: RuleMessage.Message) => Message.GotPageMessage({ message }),
	})

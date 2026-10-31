import { OrgId } from "@maple/domain"
import { V2IngestRule } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { change, expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ORG } from "../../alerts/shared/test-rows"
import { PageOutMessage, type PageContext } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import type { LogSample } from "./preview"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const asAdmin = (model: Model): Model =>
	pageUpdate(model, Message.CompletedFetchSession({ orgId: ORG, isAdmin: true })).model
const fresh = (template?: string): Model =>
	asAdmin(
		init({ _tag: "IngestRuleNew", search: template === undefined ? {} : { template } }, context).model,
	)

const log = (severityText: string, body: string): LogSample => ({
	serviceName: "checkout",
	body,
	severityNumber: 0,
	severityText,
	traceId: "",
	logAttributes: {},
	resourceAttributes: {},
})
const SAMPLES = [
	log("DEBUG", "cache warm"),
	log("DEBUG", "retrying"),
	log("INFO", "order placed by ana@example.com"),
	log("ERROR", "payment failed"),
]

const withSamples = (model: Model): Model =>
	pageUpdate(
		model,
		Message.CompletedFetchSamples({
			key: model.samplesKey,
			result: Result.succeed({ _tag: "logs", rows: SAMPLES }),
		}),
	).model

describe("ingest rule editor", () => {
	test("a new rule reads recent logs for the preview", () => {
		const entered = init({ _tag: "IngestRuleNew", search: {} }, context)
		expect(entered.commands?.map(({ name }) => name)).toContain("FetchIngestRuleSamples")
	})

	test("an empty drop rule lists what is missing and cannot be created", () => {
		scene(
			{ update: pageUpdate, view },
			given(fresh()),
			expectView(text("give the rule a name")).toExist(),
			expectView(text("a drop rule needs at least one condition")).toExist(),
			expectView(role("button", { name: "Create rule" })).toBeDisabled(),
		)
	})

	test("a template fills the form and is ready to save", () => {
		scene(
			{ update: pageUpdate, view },
			given(fresh("drop-debug-logs")),
			expectView(role("textbox", { name: "Name" })).toHaveValue("Drop debug logs"),
			expectView(text("Ready to save")).toExist(),
			expectView(role("button", { name: "Create rule" })).not.toBeDisabled(),
		)
	})

	test("changing a condition's field shows the first operator that field allows", () => {
		scene(
			{ update: pageUpdate, view },
			given(fresh("drop-debug-logs")),
			expectView(role("combobox", { name: "Condition 1 operator" })).toHaveValue("lt"),
			change(role("combobox", { name: "Condition 1 field" }), "body"),
			expectView(role("combobox", { name: "Condition 1 field" })).toHaveValue("body"),
			expectView(role("combobox", { name: "Condition 1 operator" })).toHaveValue("eq"),
		)
	})

	test("the preview counts the sample records the rule would drop", () => {
		scene(
			{ update: pageUpdate, view },
			given(withSamples(fresh("drop-debug-logs"))),
			expectView(text("Would drop 2 of 4 (50%)")).toExist(),
		)
	})

	test("a redact preview shows the replaced text", () => {
		scene(
			{ update: pageUpdate, view },
			given(withSamples(fresh("redact-pii"))),
			expectView(text("Would redact 1 of 4 (25%)")).toExist(),
			expectView(text("[REDACTED:email]")).toExist(),
		)
	})

	test("hashing warns that it is pseudonymization", () => {
		scene(
			{ update: pageUpdate, view },
			given(fresh("hash-user-ids")),
			expectView(text(/^Hashing is pseudonymization/u)).toExist(),
		)
	})

	test("saving posts the rule and returns to the ingestion tab", () => {
		const saving = pageUpdate(fresh("drop-debug-logs"), Message.ClickedSave())
		expect(saving.commands?.[0]).toMatchObject({
			name: "SaveIngestRule",
			args: {
				editingId: null,
				payload: {
					name: "Drop debug logs",
					enabled: true,
					signals: ["logs"],
					conditions: [{ field: "severity", op: "lt", value: "info" }],
					action: { type: "drop", keep_percent: 0 },
				},
			},
		})
		const saved = Schema.decodeUnknownSync(V2IngestRule)({
			id: "irule_YofPTrK9782DWwcnXhpcCw",
			object: "ingest_rule",
			name: "Drop debug logs",
			enabled: true,
			position: 0,
			signals: ["logs"],
			conditions: [{ field: "severity", op: "lt", value: "info" }],
			action: { type: "drop", keep_percent: 0 },
			created_at: "2026-10-28T12:00:00.000Z",
			updated_at: "2026-10-28T12:00:00.000Z",
		})
		expect(
			pageUpdate(saving.model, Message.CompletedSave({ result: Result.succeed(saved) })).outMessage,
		).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/settings?tab=ingestion",
				isReplace: false,
				toast: {
					type: "success",
					title: "Ingest rule created",
					description: "Applies to new data within 30 seconds.",
				},
			}),
		)
	})
})

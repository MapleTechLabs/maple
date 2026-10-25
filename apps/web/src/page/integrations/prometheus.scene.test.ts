import { OrgId } from "@maple/domain"
import { V2ScrapeTarget } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { expect as expectView, given, role, scene, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../data/load-failure"
import * as Field from "../../ui/field"
import { PageOutMessage, type PageContext } from "../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const steps = (model: Model, messages: ReadonlyArray<Message>) =>
	messages.reduce((current, message) => pageUpdate(current, message).model, model)

const target = Schema.decodeUnknownSync(V2ScrapeTarget)({
	id: "scrp_YoxMqYdzUJ1tH4BqCWxPH3",
	object: "scrape_target",
	name: "redis exporter",
	service_name: "cart-svc",
	url: "https://redis.internal:9121/metrics",
	target_type: "prometheus",
	organization: null,
	include_branches: [],
	exclude_branches: [],
	scrape_interval_seconds: 60,
	labels_json: null,
	auth_type: "none",
	has_credentials: false,
	managed_by: null,
	enabled: true,
	last_scrape_at: "2026-10-01T11:13:00.000Z",
	last_scrape_error: null,
	created_at: "2026-09-01T00:00:00.000Z",
	updated_at: "2026-09-02T00:00:00.000Z",
})

const loaded = (): Model => {
	const model = init({ search: { integration: "prometheus" } }, context).model
	return pageUpdate(
		model,
		Message.CompletedLoadScrapeTargets({
			key: model.statuses.scrapeTargets.key ?? "",
			result: Result.succeed([target]),
		}),
	).model
}

describe("prometheus scrape targets", () => {
	test("selecting a target reads its checks; a stale answer is dropped", () => {
		const selected = pageUpdate(loaded(), Message.ClickedTarget({ id: target.id }))
		expect(names(selected.commands)).toEqual(["FetchScrapeTargetChecks"])
		const late = pageUpdate(
			selected.model,
			Message.CompletedFetchChecks({ key: "old", result: Result.succeed([]) }),
		)
		expect(late.model.prometheusCard.checks).toEqual(selected.model.prometheusCard.checks)
	})

	test("the form validates and saves once, then selects and probes the new target", () => {
		const opened = loaded()
		expect(names(pageUpdate(opened, Message.SubmittedTargetForm()).commands)).toEqual([])
		const filled = steps(opened, [
			Message.GotFormFieldMessage({
				field: "name",
				message: Field.Message.ChangedValue({ value: "node" }),
			}),
			Message.GotFormFieldMessage({
				field: "url",
				message: Field.Message.ChangedValue({ value: "https://n/metrics" }),
			}),
		])
		const saving = pageUpdate(filled, Message.SubmittedTargetForm())
		expect(names(saving.commands)).toEqual(["SaveScrapeTarget"])
		expect(names(pageUpdate(saving.model, Message.SubmittedTargetForm()).commands)).toEqual([])
		const saved = pageUpdate(
			saving.model,
			Message.CompletedSave({ isEdit: false, id: target.id, failure: null }),
		)
		expect(saved.model.prometheusCard.selectedId).toBe(target.id)
		expect(names(saved.commands)).toContain("ProbeScrapeTarget")
		expect(saved.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "success",
				title: "Scrape target created",
				description: "",
			}),
		)
	})

	test("an out-of-range interval keeps the form invalid", () => {
		const opened = loaded()
		const invalid = steps(opened, [
			Message.GotFormFieldMessage({
				field: "name",
				message: Field.Message.ChangedValue({ value: "x" }),
			}),
			Message.GotFormFieldMessage({
				field: "url",
				message: Field.Message.ChangedValue({ value: "https://x" }),
			}),
			Message.GotFormFieldMessage({
				field: "interval",
				message: Field.Message.ChangedValue({ value: "2" }),
			}),
		])
		expect(names(pageUpdate(invalid, Message.SubmittedTargetForm()).commands)).toEqual([])
	})

	test("a failed probe toasts and stops spinning", () => {
		const probing = pageUpdate(loaded(), Message.ClickedProbe({ id: target.id }))
		expect(names(probing.commands)).toEqual(["ProbeScrapeTarget"])
		const failed = pageUpdate(
			probing.model,
			Message.CompletedProbe({
				id: target.id,
				failure: toLoadFailure("x"),
				success: false,
				error: null,
			}),
		)
		expect(failed.model.prometheusCard.probing).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(failed.model),
			expectView(role("button", { name: "Sync now" })).toBeEnabled(),
			expectView(role("link", { name: "Add another target" })).toExist(),
		)
	})
})

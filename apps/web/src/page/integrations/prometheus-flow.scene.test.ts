import { OrgId } from "@maple/domain"
import { V2ScrapeTarget, V2ScrapeTargetCheck } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { click, Command, expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Field from "../../ui/field"
import type { PageContext } from "../contract"
import { ScrollToTop } from "../sources/new/command"
import { Message } from "../sources/new/message"
import type { Model } from "../sources/new/model"
import { init, update } from "../sources/new/update"
import { view as pageView } from "../sources/new/view"
import { Message as IntegrationMessage } from "./message"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const inner = (model: Model, message: IntegrationMessage) =>
	pageUpdate(model, Message.GotIntegrationsMessage({ message }))
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const URL_VALUE = "https://redis.internal:9121/metrics"

const target = Schema.decodeUnknownSync(V2ScrapeTarget)({
	id: "scrp_YoxMqYdzUJ1tH4BqCWxPH3",
	object: "scrape_target",
	name: "redis.internal:9121",
	service_name: null,
	url: URL_VALUE,
	target_type: "prometheus",
	organization: null,
	include_branches: [],
	exclude_branches: [],
	scrape_interval_seconds: 15,
	labels_json: null,
	auth_type: "none",
	has_credentials: false,
	managed_by: null,
	enabled: true,
	last_scrape_at: null,
	last_scrape_error: null,
	created_at: "2026-10-01T11:00:00.000Z",
	updated_at: "2026-10-01T11:00:00.000Z",
})

const check = (success: boolean) =>
	Schema.decodeUnknownSync(V2ScrapeTargetCheck)({
		object: "scrape_target.check",
		timestamp: "2026-10-01T11:01:00.000Z",
		success,
		sub_target_key: null,
		duration_seconds: 0.2,
		samples_scraped: 1284,
		samples_post_metric_relabeling: 1284,
		message: success ? null : "target returned HTTP 503",
	})

const entered = (integration: "prometheus" | "warpstream"): Model =>
	init({ _tag: "SourcesNew", search: { integration } }, context).model

/** The URL typed and saved: the save answered with the new target, and the list re-read. */
const saved = (integration: "prometheus" | "warpstream"): Model => {
	const typed = inner(
		entered(integration),
		IntegrationMessage.GotFormFieldMessage({
			field: "url",
			message: Field.Message.ChangedValue({ value: URL_VALUE }),
		}),
	).model
	const saving = inner(typed, IntegrationMessage.SubmittedTargetForm()).model
	const done = inner(
		saving,
		IntegrationMessage.CompletedSave({ isEdit: false, id: target.id, failure: null }),
	)
	return inner(
		done.model,
		IntegrationMessage.CompletedLoadScrapeTargets({
			key: done.model.integrations.statuses.scrapeTargets.key ?? "",
			result: Result.succeed([target]),
		}),
	).model
}

const probed = (model: Model, success: boolean): Model =>
	inner(
		model,
		IntegrationMessage.CompletedProbe({
			id: target.id,
			failure: null,
			success,
			error: success ? null : "dial tcp 52.14.88.203:9121: i/o timeout",
		}),
	).model

const withCheck = (model: Model, success: boolean): Model =>
	inner(
		model,
		IntegrationMessage.CompletedFetchChecks({
			key: model.integrations.prometheusCard.checks.key ?? "",
			result: Result.succeed([check(success)]),
		}),
	).model

describe("prometheus connect flow", () => {
	test("saving the endpoint probes it, without a Test button", () => {
		const typed = inner(
			entered("prometheus"),
			IntegrationMessage.GotFormFieldMessage({
				field: "url",
				message: Field.Message.ChangedValue({ value: URL_VALUE }),
			}),
		).model
		const saving = inner(typed, IntegrationMessage.SubmittedTargetForm())
		expect(names(saving.commands)).toContain("SaveScrapeTarget")
		const done = inner(
			saving.model,
			IntegrationMessage.CompletedSave({ isEdit: false, id: target.id, failure: null }),
		)
		expect(names(done.commands)).toContain("ProbeScrapeTarget")
		scene(
			{ update: pageUpdate, view },
			given(entered("prometheus")),
			expectView(role("listitem", { current: "step", name: "Connect" })).toExist(),
			expectView(text("Waiting for an endpoint URL. Maple probes it as soon as you save.")).toExist(),
			expectView(role("button", { name: "Test" })).not.toExist(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
		)
	})

	test("a working probe unlocks Continue; Choose data keeps the saved defaults", () => {
		scene(
			{ update: pageUpdate, view },
			given(saved("prometheus")),
			expectView(text("Probing redis.internal:9121.")).toExist(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
		)
		scene(
			{ update: pageUpdate, view },
			given(probed(saved("prometheus"), true)),
			expectView(text("Endpoint works. redis.internal:9121 answered the probe.")).toExist(),
			click(role("button", { name: "Continue" })),
			Command.resolve(ScrollToTop, Message.CompletedScrollToTop()),
			expectView(role("listitem", { current: "step", name: "Choose data" })).toExist(),
			expectView(role("listitem", { name: "redis.internal:9121" })).toExist(),
			expectView(role("button", { name: "Continue" })).toBeEnabled(),
			click(role("button", { name: "Continue" })),
			Command.resolve(ScrollToTop, Message.CompletedScrollToTop()),
			expectView(role("listitem", { current: "step", name: "Go live" })).toExist(),
			expectView(text("Access works")).toExist(),
			expectView(text("The first scheduled scrape runs within 15 s")).toExist(),
		)
	})

	test("a failed probe explains the error, offers Probe again and keeps Continue locked", () => {
		scene(
			{ update: pageUpdate, view },
			given(probed(saved("prometheus"), false)),
			expectView(text("dial tcp 52.14.88.203:9121: i/o timeout")).toExist(),
			expectView(role("button", { name: "Probe again" })).toExist(),
			expectView(text("Continue unlocks once the probe succeeds.")).toExist(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
		)
	})

	test("an unsaved name change locks Continue on Choose data until it is saved", () => {
		const choosing = pageUpdate(probed(saved("prometheus"), true), Message.ClickedContinue()).model
		const renamed = inner(
			choosing,
			IntegrationMessage.GotFormFieldMessage({
				field: "name",
				message: Field.Message.ChangedValue({ value: "redis prod" }),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(renamed),
			expectView(text("Save your changes to continue.")).toExist(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
			expectView(role("button", { name: "Save" })).toBeEnabled(),
		)
	})

	test("Go live reads the first scheduled scrape from the target's checks", () => {
		const live = [Message.ClickedContinue(), Message.ClickedContinue()].reduce(
			(model, message) => pageUpdate(model, message).model,
			probed(saved("prometheus"), true),
		)
		scene(
			{ update: pageUpdate, view },
			given(withCheck(live, true)),
			expectView(role("listitem", { name: "Live" })).toExist(),
			expectView(text("Last scrape read 1.3K samples in 200.0ms")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(withCheck(live, false)),
			expectView(text("Last scrape failed")).toExist(),
			expectView(text("target returned HTTP 503")).toExist(),
		)
	})

	test("WarpStream uses the same steps with its own copy", () => {
		scene(
			{ update: pageUpdate, view },
			given(entered("warpstream")),
			expectView(text("Scrape your cluster's metrics endpoint")).toExist(),
			expectView(text("Where to find it in WarpStream")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(probed(saved("warpstream"), true)),
			expectView(role("button", { name: "Continue" })).toBeEnabled(),
		)
	})
})

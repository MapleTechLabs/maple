import { OrgId } from "@maple/domain"
import { encodeLogKey } from "../../../lib/log-key"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import type { LogRecord } from "../../../ui/logs/log-row-view"
import type { PageContext } from "../../contract"
import * as LogDetail from "../detail"
import { Message, type Model } from "./model"
import { init, update } from "./update"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const pageUpdate = (model: Model, message: Message) => update(model, message, context)

const log: LogRecord = {
	timestamp: "2026-10-01T11:59:59.023Z",
	exactTimestamp: "2026-10-01 11:59:59.023412000",
	severityText: "ERROR",
	severityNumber: 17,
	serviceName: "storefront",
	body: "PaymentError: declined",
	traceId: undefined,
	spanId: undefined,
	logAttributes: {},
	resourceAttributes: {},
}

describe("log page", () => {
	test("a stale or repeated answer leaves the open panels as they are", () => {
		const entered = init({ _tag: "Log", logId: encodeLogKey(log) }, context).model
		const answer = (key: string) => Message.CompletedFetchLog({ key, result: Result.succeed(log) })
		const shown = pageUpdate(entered, answer(entered.log.key ?? "")).model
		const expanded = pageUpdate(
			shown,
			Message.GotDetailMessage({ message: LogDetail.Message.ToggledErrorExpanded() }),
		).model
		expect(expanded.detail).not.toEqual(shown.detail)
		expect(pageUpdate(expanded, answer("stale")).model.detail).toEqual(expanded.detail)
		expect(pageUpdate(expanded, answer(entered.log.key ?? "")).model.detail).toEqual(expanded.detail)
	})
})

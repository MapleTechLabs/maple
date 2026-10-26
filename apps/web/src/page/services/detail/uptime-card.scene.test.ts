import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { LinkedCursorMessage, MountLinkedCursor } from "../../../charts/linked-cursor"
import { ResolveThemeColors, ThemeMessage } from "../../../charts/theme-colors"
import { describe, test } from "vitest"
import type { UptimeMonitor } from "../../alerts/shared/uptime-derive"
import { downMonitor, httpMonitor } from "../../alerts/shared/uptime-test-monitors"
import type { PageContext } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = Date.parse("2026-10-01T12:00:00Z")
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const mounted = [
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
	Mount.resolve(MountLinkedCursor, LinkedCursorMessage.CompletedMountLinkedCursor()),
] as const

/** The Overview of `checkout-api` with the org's monitors answered. */
const withMonitors = (monitors: ReadonlyArray<UptimeMonitor>): Model => {
	const start = init({ serviceName: "checkout-api", search: {} }, context).model
	const resolved = pageUpdate(start, Message.CompletedResolveClock({ nowMs: NOW, mode: "Load" })).model
	return pageUpdate(
		resolved,
		Message.CompletedFetchUptimeMonitors({
			key: resolved.uptimeMonitors.key ?? "",
			result: Result.succeed(monitors),
		}),
	).model
}

describe("service detail, Uptime card", () => {
	test("a service no monitor watches shows no Uptime card", () => {
		scene(
			{ update: pageUpdate, view },
			given(withMonitors([downMonitor({ service_name: "payments-api" })])),
			...mounted,
			expectView(text("checked from outside")).not.toExist(),
		)
	})

	test("a watched service lists its monitor with status and links to add another", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				withMonitors([
					downMonitor({ service_name: "checkout-api" }),
					httpMonitor({ service_name: "other" }),
				]),
			),
			...mounted,
			expectView(text("checked from outside")).toExist(),
			expectView(text("Down 6m")).toExist(),
			expectView(role("link", { name: "api.acme.dev/checkout/health" })).toExist(),
			expectView(role("link", { name: "Add uptime check for this service" })).toHaveAttr(
				"href",
				"/alerts/uptime/new?serviceName=checkout-api",
			),
			expectView(role("link", { name: "Open in Alerts" })).toHaveAttr("href", "/alerts?tab=uptime"),
		)
	})
})

import { OrgId } from "@maple/domain"
import * as Policy from "@maple/domain/policy"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, test } from "vitest"
import { MeasureTabIndicator, Message as TabsMessage } from "@maple/views/ui/tabs"
import { buildAlertsLabFixture } from "../../../lab/alerts-fixture"
import type { PageContext } from "../../contract"
import { MountInvestigationRows } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

// An observer reads the investigations; starting one needs `investigations:run`.

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const measured = () =>
	Mount.resolve(
		MeasureTabIndicator,
		TabsMessage.MeasuredIndicator({
			rect: { left: 2, right: 115, top: 2, bottom: 2, width: 51, height: 28 },
		}),
	)

/** The rows' click stream mounts with the list; it answers with a row click, which only navigates. */
const rowsMounted = () => Mount.resolve(MountInvestigationRows, Message.ClickedRow({ id: investigation.id }))

const MEMBER = Policy.grantsOf(["org:member"])
const OBSERVER = Policy.grantsOf(["org:observer"])
const NOW = Date.UTC(2026, 9, 1, 12)
const investigation = buildAlertsLabFixture(NOW).incident.investigation
const bar = role("textbox", { name: "What should Maple investigate?" })

/** The list read by a session holding `grants`, over `data`. */
const loaded = (
	grants: ReadonlyArray<Policy.Permission>,
	data: ReadonlyArray<typeof investigation>,
): Model => {
	const entered = init({ search: {} }, context).model
	const granted = pageUpdate(entered, Message.CompletedReadGrants({ orgId: context.orgId, grants })).model
	return pageUpdate(
		granted,
		Message.CompletedFetchFirstPage({
			key: granted.firstPage.key ?? "",
			result: Result.succeed({ data, hasMore: false, nextCursor: null }),
		}),
	).model
}

describe("investigations list, observer", () => {
	test("an observer reads the list without the investigate bar; a member has it", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(OBSERVER, [investigation])),
			measured(),
			rowsMounted(),
			expectView(role("tab", { name: /Active/ })).toExist(),
			expectView(bar).toBeAbsent(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded(MEMBER, [investigation])),
			measured(),
			rowsMounted(),
			expectView(bar).toExist(),
		)
	})

	test("an empty workspace shows an observer the plain empty list, and a member the first-run hero", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(OBSERVER, [])),
			measured(),
			expectView(text("Nothing under investigation")).toExist(),
			expectView(text("When an alert rule fires, Maple opens one on its own.")).toExist(),
			expectView(text("Ask, and Maple goes and finds out.")).toBeAbsent(),
			expectView(bar).toBeAbsent(),
			expectView(role("button", { name: /Why did checkout latency spike/ })).toBeAbsent(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded(MEMBER, [])),
			expectView(text("Ask, and Maple goes and finds out.")).toExist(),
			expectView(bar).toExist(),
			expectView(role("button", { name: /Why did checkout latency spike/ })).toExist(),
		)
	})
})

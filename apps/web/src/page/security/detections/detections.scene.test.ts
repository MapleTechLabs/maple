import { OrgId } from "@maple/domain"
import {
	AuditDetectionNotFoundError,
	AuditTrailForbiddenError,
	AuditTrailPersistenceError,
	type AlertRuleId,
	type AuditDetection,
	type AuditDetectionListResponse,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { toLoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import { MountNetworkAutoRetry } from "@maple/views/ui/error-state"
import { MountDialog } from "@maple/views/ui/dialog"
import { Array as Arr, Option, Result, Schema } from "effect"
import {
	click,
	Command,
	expect as expectView,
	expectOutMessage,
	given,
	Mount,
	role,
	scene,
	text,
	within,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { detectionsOf, noDetections } from "../../../lab/security-detections-fixture"
import { type PageContext, PageOutMessage } from "../../contract"
import { DETECTION_TEMPLATES } from "../kit/detection-templates"
import { DeleteDetection, FetchDetections, SaveDetectionEnabled } from "./command"
import { detectionById, detectionsOf as shown } from "./derive"
import { Message, type Model } from "./model"
import { enter, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const NOW = Date.UTC(2026, 9, 31, 14, 32)
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const LIST = "SecurityApiDetectionsList"

/** The hosted product: the session, not the build, says what the viewer may read. */
const init = () => enter(context, true)
const ADMIN = Policy.allPermissions
const ENGINEER = Policy.grantsOf(["org:engineer"])
const table = role("table", { name: "Detections" })
const adminsOnly = text("Only org admins can see and change detections")

const fold = (model: Model, messages: ReadonlyArray<(model: Model) => Message>): Model =>
	Arr.reduce(messages, model, (current, toMessage) => pageUpdate(current, toMessage(current)).model)

const grantsRead = (grants: ReadonlyArray<Policy.Permission>) => () =>
	Message.CompletedReadGrants({ orgId: context.orgId, grants: [...grants] })

const listed = (list: AuditDetectionListResponse) => (model: Model) =>
	Message.CompletedFetchDetections({ key: model.list.key ?? "", result: Result.succeed(list) })

const listFailed = (error: unknown) => (model: Model) =>
	Message.CompletedFetchDetections({
		key: model.list.key ?? "",
		result: Result.fail(toLoadFailure(error)),
	})

const LIST_OF_FIVE = detectionsOf(NOW)

/** The page as an admin sees it once the list answered. */
const loaded = (list: AuditDetectionListResponse = LIST_OF_FIVE): Model =>
	fold(init().model, [grantsRead(ADMIN), listed(list)])

/** The fixture's detection called `name`. */
const named = (name: string): AuditDetection =>
	Option.getOrThrow(Arr.findFirst(LIST_OF_FIVE.detections, (detection) => detection.name === name))

const only = (name: string): Model => loaded({ detections: [named(name)] })

const unavailable = new AuditTrailPersistenceError({ message: "The audit trail could not be read" })
const down = toLoadFailure(unavailable)

describe("security detections", () => {
	test("nothing is asked of the API until the session says who is looking", () => {
		expect(names(init().commands)).not.toContain(LIST)
	})

	test("a self-hosted install has one role, so the list is asked for on entry", () => {
		expect(names(enter(context, false).commands)).toContain(LIST)
	})

	test("an engineer is told detections are for admins and nothing is asked of the API", () => {
		const answered = pageUpdate(init().model, grantsRead(ENGINEER)())

		expect(names(answered.commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(answered.model),
			expectView(adminsOnly).toExist(),
			expectView(table).toBeAbsent(),
			expectView(role("link", { name: "New detection" })).toBeAbsent(),
		)
	})

	// A failed session read answers with no grants at all. That is "unknown", not "member": an
	// admin must not be locked out by it.
	test("a session that could not be read asks the API, and the API's refusal is what locks the page", () => {
		const asked = pageUpdate(init().model, grantsRead([])())
		expect(names(asked.commands)).toEqual([LIST])

		scene(
			{ update: pageUpdate, view },
			given(fold(asked.model, [listed(LIST_OF_FIVE)])),
			expectView(table).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(
				fold(asked.model, [
					listFailed(
						new AuditTrailForbiddenError({ message: "Only org admins can read the audit log." }),
					),
				]),
			),
			expectView(adminsOnly).toExist(),
			expectView(role("button", { name: "Try again" })).toBeAbsent(),
		)
	})

	test("a row says what the detection counts, when it fires, how severe and who is told", () => {
		scene(
			{ update: pageUpdate, view },
			given(only("Burst of refused requests")),
			expectView(within(table, role("link", { name: "Burst of refused requests" }))).toExist(),
			expectView(within(table, text("Denied"))).toExist(),
			expectView(within(table, text("10 or more in 10 minutes"))).toExist(),
			expectView(within(table, text("Critical"))).toExist(),
			expectView(within(table, text("2 destinations"))).toExist(),
			expectView(within(table, text("Notifies no one"))).toBeAbsent(),
		)
	})

	test("the filters read by name, and an exact action as the platform writes it", () => {
		scene(
			{ update: pageUpdate, view },
			given(only("Role changes on Vercel")),
			expectView(within(table, text("Vercel"))).toExist(),
			expectView(within(table, text("team.member.role.updated"))).toExist(),
			expectView(within(table, text("1 or more in 5 minutes"))).toExist(),
			expectView(within(table, text("1 destination"))).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(only("Credential changes on Google Cloud")),
			expectView(within(table, text("Google Cloud · Credentials"))).toExist(),
		)
	})

	test("a detection with no filters counts every audit event, over a window in hours", () => {
		scene(
			{ update: pageUpdate, view },
			given(only("Unusual audit volume")),
			expectView(within(table, text("Every audit event"))).toExist(),
			expectView(within(table, text("500 or more in 1 hour"))).toExist(),
		)
	})

	// Such a detection opens incidents nobody is told about.
	test("a detection that notifies no one says so", () => {
		scene(
			{ update: pageUpdate, view },
			given(only("Credential changes on Google Cloud")),
			expectView(within(table, text("Notifies no one"))).toExist(),
		)
	})

	test("the switch shows whether a detection is on, and names what a press would do", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			expectView(role("switch", { name: "Enable Repeated sign-in failures" })).toHaveAttr(
				"aria-checked",
				"false",
			),
			expectView(role("switch", { name: "Disable Role changes on Vercel" })).toHaveAttr(
				"aria-checked",
				"true",
			),
		)
	})

	test("members are told once what they see of a detection", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			expectView(
				text(
					"Every member of the org can see a detection's name and that it fired. Only org admins see the events it counted.",
				),
			).toExist(),
		)
	})

	test("the switch saves on toggle and shows what the API stored", () => {
		const detection = named("Role changes on Vercel")

		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			click(role("switch", { name: "Disable Role changes on Vercel" })),
			Command.resolve(
				SaveDetectionEnabled({ id: detection.id, enabled: false }),
				Message.CompletedToggle({
					id: detection.id,
					result: Result.succeed({ ...detection, enabled: false }),
				}),
			),
			expectView(role("switch", { name: "Enable Role changes on Vercel" })).toHaveAttr(
				"aria-checked",
				"false",
			),
		)
	})

	// No optimistic flip: until the API answers the switch is where it was, and cannot be pressed again.
	test("a toggle in flight leaves the switch as it was, and a second press sends nothing", () => {
		const detection = named("Role changes on Vercel")
		const pressed = pageUpdate(loaded(), Message.ToggledDetection({ id: detection.id }))

		expect(names(pressed.commands)).toEqual(["SecurityApiDetectionToggle"])
		expect(
			names(pageUpdate(pressed.model, Message.ToggledDetection({ id: detection.id })).commands),
		).toEqual([])
		expect(detectionById(pressed.model, detection.id)).toEqual(Option.some(detection))
	})

	test("a toggle the API refuses leaves the detection as it was and says why", () => {
		const detection = named("Role changes on Vercel")
		const pressed = pageUpdate(loaded(), Message.ToggledDetection({ id: detection.id })).model
		const failed = pageUpdate(
			pressed,
			Message.CompletedToggle({ id: detection.id, result: Result.fail(down) }),
		)

		expect(failed.outMessage).toMatchObject({ type: "error", title: "Couldn't update the detection" })
		scene(
			{ update: pageUpdate, view },
			given(failed.model),
			expectView(role("switch", { name: "Disable Role changes on Vercel" })).toHaveAttr(
				"aria-checked",
				"true",
			),
		)
	})

	const confirm = within(role("alertdialog"), role("button", { name: "Delete detection" }))
	const askedToDelete = (id: AlertRuleId): Model =>
		pageUpdate(loaded(), Message.ClickedDelete({ id })).model

	test("delete asks first, and says the detection's incidents go with it", () => {
		const detection = named("Burst of refused requests")
		const asked = pageUpdate(loaded(), Message.ClickedDelete({ id: detection.id }))

		expect(names(asked.commands)).not.toContain("SecurityApiDetectionDelete")
		scene(
			{ update: pageUpdate, view },
			given(asked.model),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(within(role("alertdialog"), text("Delete Burst of refused requests?"))).toExist(),
			expectView(
				within(role("alertdialog"), text(/the incidents it opened are deleted with it/u)),
			).toExist(),
			expectView(confirm).toExist(),
		)
	})

	test("a confirmed delete removes the detection once the API says it is gone", () => {
		const detection = named("Burst of refused requests")
		const confirmed = pageUpdate(askedToDelete(detection.id), Message.ClickedConfirmDelete())

		expect(confirmed.commands?.[0]).toMatchObject({
			name: DeleteDetection.name,
			args: { id: detection.id },
		})
		// Still listed while the request is out.
		expect(shown(confirmed.model)).toHaveLength(LIST_OF_FIVE.detections.length)

		const deleted = pageUpdate(
			confirmed.model,
			Message.CompletedDelete({ id: detection.id, result: Result.succeed({ id: detection.id }) }),
		)
		expect(deleted.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Detection deleted", description: "" }),
		)
		expect(deleted.model.deleteDialog.isOpen).toBe(false)
		expect(Arr.map(shown(deleted.model) ?? [], (row) => row.name)).not.toContain(detection.name)
	})

	test("a delete the API refuses keeps the detection listed and the dialog open", () => {
		const detection = named("Burst of refused requests")
		const confirmed = pageUpdate(askedToDelete(detection.id), Message.ClickedConfirmDelete()).model
		const failed = pageUpdate(
			confirmed,
			Message.CompletedDelete({
				id: detection.id,
				result: Result.fail(
					toLoadFailure(
						new AuditDetectionNotFoundError({
							detectionId: detection.id,
							message: "No such detection.",
						}),
					),
				),
			}),
		)

		expect(failed.outMessage).toMatchObject({ type: "error", title: "Couldn't delete the detection" })
		expect(failed.model.deleteDialog.isOpen).toBe(true)
		expect(shown(failed.model)).toHaveLength(LIST_OF_FIVE.detections.length)
	})

	test("edit opens the editor on that detection", () => {
		const detection = named("Burst of refused requests")

		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			click(role("button", { name: "Edit Burst of refused requests" })),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({
					url: `/security/detections/new?detectionId=${detection.id}`,
					isReplace: false,
				}),
			),
		)
	})

	test("with no detections the page offers the ready-made ones, each opening the editor filled in", () => {
		expect(DETECTION_TEMPLATES).toHaveLength(5)
		scene(
			{ update: pageUpdate, view },
			given(loaded(noDetections)),
			expectView(text("No detections yet")).toExist(),
			expectView(table).toBeAbsent(),
			...Arr.map(DETECTION_TEMPLATES, (template) =>
				expectView(role("link", { name: `Use template: ${template.title}` })).toHaveAttr(
					"href",
					`/security/detections/new?template=${template.id}`,
				),
			),
			expectView(text("Fires on 5 or more failed sign-ins within 10 minutes.")).toExist(),
			expectView(role("link", { name: "Start from scratch" })).toHaveAttr(
				"href",
				"/security/detections/new",
			),
			expectView(role("link", { name: "New detection" })).toHaveAttr(
				"href",
				"/security/detections/new",
			),
		)
	})

	test("a failed load says so, and trying again shows the list it gets", () => {
		const failed = fold(init().model, [grantsRead(ADMIN), listFailed(unavailable)])
		const key = failed.list.key ?? ""

		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Couldn't load detections")).toExist(),
			expectView(table).toBeAbsent(),
			Mount.resolve(
				MountNetworkAutoRetry({ retryKey: JSON.stringify(Message.ClickedRetry()) }),
				Message.ClickedRetry(),
			),
			Command.resolve(
				FetchDetections({ key }),
				Message.CompletedFetchDetections({ key, result: Result.succeed(LIST_OF_FIVE) }),
			),
			Mount.expectEnded(MountNetworkAutoRetry),
			expectView(table).toExist(),
		)
	})
})

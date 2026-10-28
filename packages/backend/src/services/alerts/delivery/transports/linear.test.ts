import type { AlertDestinationRow } from "@maple/db/tables"
import { AlertDeliveryError, AlertDestinationId, OrgId } from "@maple/domain/http"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import type { DispatchContext } from "../context"
import type { LinearDeliveryPort, LinearThread, RenderInput, SecretConfigOf } from "../Transport"
import { LINEAR_REOPEN_WINDOW_MS, linearEntityId, linearTransport } from "./linear"

const ORG = Schema.decodeUnknownSync(OrgId)("org_1")
const DESTINATION_ID = Schema.decodeUnknownSync(AlertDestinationId)("7c6b5a49-3821-4e0f-9d8c-7b6a59483726")
const NOW = 1_700_000_000_000
const HOUR = 60 * 60 * 1000

const config: SecretConfigOf<"linear"> = {
	type: "linear",
	teamId: "team_1",
	teamKey: "ENG",
	teamName: "Engineering",
}

const destinationRow: AlertDestinationRow = {
	id: DESTINATION_ID,
	orgId: ORG,
	name: "Engineering triage",
	type: "linear",
	enabled: true,
	configJson: {},
	secretCiphertext: "",
	secretIv: "",
	secretTag: "",
	lastTestedAt: null,
	lastTestError: null,
	consecutiveFailures: 0,
	lastFailureAt: null,
	disabledAt: null,
	disabledReason: null,
	createdAt: 0,
	updatedAt: 0,
	createdBy: "user_1",
	updatedBy: "user_1",
}

const baseContext: DispatchContext = {
	deliveryKey: "delivery_1",
	destination: destinationRow,
	publicConfig: { summary: "Linear · Engineering", channelLabel: "ENG" },
	secretConfig: config,
	ruleId: "rule_1",
	ruleName: "Checkout error rate",
	groupKey: "checkout",
	signalType: "error_rate",
	severity: "critical",
	comparator: "gt",
	threshold: 0.05,
	thresholdUpper: null,
	eventType: "trigger",
	incidentId: "inc_1",
	incidentStatus: "open",
	dedupeKey: "org_1:rule_1:checkout",
	windowMinutes: 5,
	value: 0.08,
	sampleCount: 1200,
	template: null,
	sentAtMs: NOW,
}

const inputFor = (context: Partial<DispatchContext> = {}): RenderInput<SecretConfigOf<"linear">> => ({
	config,
	context: { ...baseContext, ...context },
	linkUrl: "https://app.maple.test/alerts/incidents/inc_1",
	chatUrl: "https://app.maple.test/chat",
	payloadJson: "{}",
	templated: null,
})

interface IssueFixture {
	readonly id: string
	readonly identifier: string
	readonly url: string
	readonly state: { readonly type: string }
	readonly team: { readonly id: string }
	readonly completedAt?: string | null
}

interface Call {
	readonly name: string
	readonly variables: Record<string, unknown>
}

/** Linear and the thread table in memory; every GraphQL operation is recorded. */
const fakeLinear = (
	seed: {
		issues?: ReadonlyArray<IssueFixture>
		threads?: ReadonlyArray<LinearThread>
		/** Ids held by issues Maple cannot see: a create with one answers "already exists". */
		taken?: ReadonlyArray<string>
	} = {},
) => {
	const issues = new Map((seed.issues ?? []).map((issue) => [issue.id, issue]))
	const threads = new Map((seed.threads ?? []).map((thread) => [thread.threadKey, thread]))
	const calls: Call[] = []
	const answer = (name: string, variables: Record<string, unknown>): object | null => {
		switch (name) {
			case "MapleIssue": {
				const issue = issues.get(String(variables.id))
				return issue === undefined ? null : { issue }
			}
			case "MapleTeam":
				return {
					team: {
						id: "team_1",
						key: "ENG",
						name: "Engineering",
						triageEnabled: true,
						triageIssueState: { id: "state_triage" },
						states: { nodes: [{ id: "state_todo", position: 1 }] },
					},
				}
			case "MapleIssueCreate": {
				const input = variables.input
				const id = isRecord(input) ? String(input.id) : ""
				if (seed.taken?.includes(id)) return null
				const issue = {
					id,
					identifier: `ENG-${issues.size + 1}`,
					url: `https://linear.app/acme/issue/ENG-${issues.size + 1}`,
					state: { type: "triage" },
					team: { id: isRecord(input) ? String(input.teamId) : "" },
				}
				issues.set(issue.id, issue)
				return { issueCreate: { success: true, issue } }
			}
			default:
				return {}
		}
	}
	const port: LinearDeliveryPort = {
		request: (_orgId, operation, schema) =>
			Effect.gen(function* () {
				calls.push({ name: operation.name, variables: operation.variables })
				const data = answer(operation.name, operation.variables)
				if (data === null) return null
				return yield* Schema.decodeUnknownEffect(schema)(data).pipe(
					Effect.mapError(
						() => new AlertDeliveryError({ message: "bad fixture", destinationType: "linear" }),
					),
				)
			}),
		findThread: (_orgId, _destinationId, threadKey) => Effect.succeed(threads.get(threadKey) ?? null),
		saveThread: (thread) => Effect.sync(() => void threads.set(thread.threadKey, thread)),
	}
	const send = (input: RenderInput<SecretConfigOf<"linear">>) =>
		linearTransport.send(input, {
			linear: port,
			sendEmail: () => Effect.die("unexpected email"),
			postChatAlert: () => Effect.die("unexpected chat post"),
		})
	return { send, calls, threads, issues }
}

const names = (calls: ReadonlyArray<Call>) => calls.map((call) => call.name)

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null

/** The `input` variable of the operation named `name`, failing the test when it was never sent. */
const inputOf = (calls: ReadonlyArray<Call>, name: string): Record<string, unknown> => {
	const input = calls.find((call) => call.name === name)?.variables.input
	assert.isTrue(isRecord(input), `${name} was not sent`)
	return isRecord(input) ? input : {}
}

const openThread = (overrides: Partial<LinearThread> = {}): LinearThread => ({
	orgId: ORG,
	destinationId: DESTINATION_ID,
	threadKey: "rule_1:checkout",
	linearIssueId: "issue_open",
	linearIdentifier: "ENG-7",
	linearUrl: "https://linear.app/acme/issue/ENG-7",
	incidentId: "inc_1",
	...overrides,
})

const issue = (overrides: Partial<IssueFixture> = {}): IssueFixture => ({
	id: "issue_open",
	identifier: "ENG-7",
	url: "https://linear.app/acme/issue/ENG-7",
	state: { type: "started" },
	team: { id: "team_1" },
	...overrides,
})

describe("linear transport", () => {
	it.effect("opens an urgent issue for a new critical incident and links it back", () =>
		Effect.gen(function* () {
			const linear = fakeLinear()
			const result = yield* linear.send(inputFor())

			const create = inputOf(linear.calls, "MapleIssueCreate")
			assert.strictEqual(create.id, linearEntityId("issue", DESTINATION_ID, "team_1", "inc_1", ""))
			assert.strictEqual(create.teamId, "team_1")
			assert.strictEqual(create.priority, 1)
			assert.include(
				String(create.description),
				"[Open in Maple](https://app.maple.test/alerts/incidents/inc_1)",
			)
			const link = inputOf(linear.calls, "MapleIssueLink")
			assert.strictEqual(link.url, "https://app.maple.test/alerts/incidents/inc_1")

			assert.strictEqual(result.providerMessage, "Opened Linear issue ENG-1")
			assert.strictEqual(result.providerReference, "https://linear.app/acme/issue/ENG-1")
			assert.strictEqual(linear.threads.get("rule_1:checkout")?.linearIdentifier, "ENG-1")
		}),
	)

	it.effect("reuses the issue a lost-response create already made", () =>
		Effect.gen(function* () {
			const issueId = linearEntityId("issue", DESTINATION_ID, "team_1", "inc_1", "")
			const linear = fakeLinear({
				issues: [issue({ id: issueId, identifier: "ENG-3", state: { type: "triage" } })],
			})
			const result = yield* linear.send(inputFor())
			assert.notInclude(names(linear.calls), "MapleIssueCreate")
			assert.strictEqual(result.providerMessage, "Opened Linear issue ENG-3")
		}),
	)

	it.effect("comments on the open issue when the same incident changes severity", () =>
		Effect.gen(function* () {
			const linear = fakeLinear({ issues: [issue()], threads: [openThread()] })
			const result = yield* linear.send(
				inputFor({ deliveryKey: "delivery_2", ruleSeverities: ["warning", "critical"] }),
			)
			assert.notInclude(names(linear.calls), "MapleIssueCreate")
			const comment = inputOf(linear.calls, "MapleComment")
			assert.include(String(comment.body), "Severity changed to critical")
			assert.strictEqual(
				comment.id,
				linearEntityId("comment", DESTINATION_ID, "issue_open", "delivery_2"),
			)
			assert.strictEqual(result.providerMessage, "Commented on Linear issue ENG-7")
		}),
	)

	it.effect("comments instead of opening another issue when the rule fires again", () =>
		Effect.gen(function* () {
			const linear = fakeLinear({ issues: [issue()], threads: [openThread()] })
			yield* linear.send(inputFor({ incidentId: "inc_2" }))
			assert.notInclude(names(linear.calls), "MapleIssueCreate")
			const comment = inputOf(linear.calls, "MapleComment")
			assert.include(String(comment.body), "Fired again")
			assert.strictEqual(linear.threads.get("rule_1:checkout")?.incidentId, "inc_2")
		}),
	)

	it.effect("reopens an issue closed within the window into the team's Triage", () =>
		Effect.gen(function* () {
			const closedAt = new Date(NOW - 2 * HOUR).toISOString()
			const linear = fakeLinear({
				issues: [issue({ state: { type: "completed" }, completedAt: closedAt })],
				threads: [openThread()],
			})
			const result = yield* linear.send(inputFor({ incidentId: "inc_2" }))
			assert.deepStrictEqual(inputOf(linear.calls, "MapleIssueReopen"), { stateId: "state_triage" })
			assert.include(String(inputOf(linear.calls, "MapleComment").body), "Fired again")
			assert.notInclude(names(linear.calls), "MapleIssueCreate")
			assert.strictEqual(result.providerMessage, "Reopened Linear issue ENG-7")
		}),
	)

	it.effect("opens a new issue once the old one has been closed longer than the window", () =>
		Effect.gen(function* () {
			const closedAt = new Date(NOW - LINEAR_REOPEN_WINDOW_MS - HOUR).toISOString()
			const linear = fakeLinear({
				issues: [issue({ state: { type: "completed" }, completedAt: closedAt })],
				threads: [openThread()],
			})
			const result = yield* linear.send(inputFor({ incidentId: "inc_2" }))
			assert.include(names(linear.calls), "MapleIssueCreate")
			assert.notInclude(names(linear.calls), "MapleIssueReopen")
			assert.strictEqual(result.providerMessage, "Opened Linear issue ENG-2")
			assert.strictEqual(linear.threads.get("rule_1:checkout")?.linearIdentifier, "ENG-2")
		}),
	)

	it.effect("comments on resolve and leaves the issue for the team to close", () =>
		Effect.gen(function* () {
			const linear = fakeLinear({ issues: [issue()], threads: [openThread()] })
			yield* linear.send(inputFor({ eventType: "resolve", incidentStatus: "resolved", value: 0.01 }))
			assert.include(String(inputOf(linear.calls, "MapleComment").body), "Resolved")
			assert.notInclude(names(linear.calls), "MapleIssueReopen")
		}),
	)

	it.effect("does nothing for a resolve whose incident never opened an issue", () =>
		Effect.gen(function* () {
			const linear = fakeLinear()
			const result = yield* linear.send(inputFor({ eventType: "resolve", incidentStatus: "resolved" }))
			assert.notInclude(names(linear.calls), "MapleComment")
			assert.strictEqual(result.providerMessage, "No Linear issue to update")
		}),
	)

	it.effect("resolves an issue whose trigger made it but never saved the thread", () =>
		Effect.gen(function* () {
			const issueId = linearEntityId("issue", DESTINATION_ID, "team_1", "inc_1", "")
			const linear = fakeLinear({ issues: [issue({ id: issueId, identifier: "ENG-4" })] })
			const result = yield* linear.send(inputFor({ eventType: "resolve", incidentStatus: "resolved" }))
			assert.include(String(inputOf(linear.calls, "MapleComment").body), "Resolved")
			assert.strictEqual(result.providerMessage, "Commented on Linear issue ENG-4")
			assert.strictEqual(linear.threads.get("rule_1:checkout")?.linearIssueId, issueId)
		}),
	)

	it.effect("skips reminders", () =>
		Effect.gen(function* () {
			const linear = fakeLinear({ issues: [issue()], threads: [openThread()] })
			const result = yield* linear.send(inputFor({ eventType: "renotify" }))
			assert.lengthOf(linear.calls, 0)
			assert.include(result.providerMessage, "Skipped")
		}),
	)

	it.effect("tests a destination by reading its team, without opening an issue", () =>
		Effect.gen(function* () {
			const linear = fakeLinear()
			const result = yield* linear.send(inputFor({ eventType: "test", incidentId: null }))
			assert.notInclude(names(linear.calls), "MapleIssueCreate")
			assert.strictEqual(result.providerMessage, "Linear team Engineering (ENG) is reachable")
		}),
	)

	it.effect("marks an issue resolved when its trigger arrives after the incident resolved", () =>
		Effect.gen(function* () {
			const linear = fakeLinear()
			const result = yield* linear.send(inputFor({ incidentStatus: "resolved" }))
			assert.include(names(linear.calls), "MapleIssueCreate")
			assert.include(
				String(inputOf(linear.calls, "MapleComment").body),
				"resolved before Maple reached Linear",
			)
			assert.strictEqual(result.providerMessage, "Opened Linear issue ENG-1")
		}),
	)

	it.effect("finds the same issue for two deliveries of one incident", () =>
		Effect.gen(function* () {
			const linear = fakeLinear()
			yield* linear.send(inputFor({ deliveryKey: "delivery_a" }))
			linear.threads.clear()
			yield* linear.send(inputFor({ deliveryKey: "delivery_b", severity: "warning" }))
			assert.lengthOf(
				linear.calls.filter((call) => call.name === "MapleIssueCreate"),
				1,
			)
		}),
	)

	it.effect("gives a closed issue a fresh id when the same incident needs a new one", () =>
		Effect.gen(function* () {
			const closedAt = new Date(NOW - LINEAR_REOPEN_WINDOW_MS - HOUR).toISOString()
			const oldId = linearEntityId("issue", DESTINATION_ID, "team_1", "inc_1", "")
			const linear = fakeLinear({
				issues: [issue({ id: oldId, state: { type: "completed" }, completedAt: closedAt })],
				threads: [openThread({ linearIssueId: oldId })],
			})
			const result = yield* linear.send(inputFor({ deliveryKey: "delivery_9" }))
			const create = inputOf(linear.calls, "MapleIssueCreate")
			assert.notStrictEqual(create.id, oldId)
			assert.strictEqual(result.providerMessage, "Opened Linear issue ENG-2")
		}),
	)

	it.effect("labels an error-issue update without claiming a severity change", () =>
		Effect.gen(function* () {
			const linear = fakeLinear({ issues: [issue()], threads: [openThread()] })
			yield* linear.send(inputFor({ deliveryKey: "delivery_3" }))
			assert.include(String(inputOf(linear.calls, "MapleComment").body), "**Updated.**")
			const alert = fakeLinear({ issues: [issue()], threads: [openThread()] })
			yield* alert.send(
				inputFor({ deliveryKey: "delivery_3", ruleSeverities: ["warning", "critical"] }),
			)
			assert.include(String(inputOf(alert.calls, "MapleComment").body), "Severity changed to critical")
		}),
	)
})

describe("linear transport after a resolve or a team change", () => {
	it.effect("does not reopen an issue for a trigger that arrives after its incident resolved", () =>
		Effect.gen(function* () {
			const closedAt = new Date(NOW - 2 * HOUR).toISOString()
			const linear = fakeLinear({
				issues: [issue({ state: { type: "completed" }, completedAt: closedAt })],
				threads: [openThread()],
			})
			const result = yield* linear.send(inputFor({ incidentId: "inc_2", incidentStatus: "resolved" }))
			assert.notInclude(names(linear.calls), "MapleIssueReopen")
			assert.notInclude(names(linear.calls), "MapleComment")
			assert.include(result.providerMessage, "Skipped")
		}),
	)

	it.effect("opens a new issue in the destination's team when the thread's issue is in another", () =>
		Effect.gen(function* () {
			const linear = fakeLinear({
				issues: [issue({ team: { id: "team_old" } })],
				threads: [openThread()],
			})
			yield* linear.send(inputFor({ deliveryKey: "delivery_7" }))
			assert.strictEqual(inputOf(linear.calls, "MapleIssueCreate").teamId, "team_1")
			assert.notInclude(names(linear.calls), "MapleComment")
		}),
	)

	it.effect("moves to a fresh id when the computed one is held by an issue Maple cannot see", () =>
		Effect.gen(function* () {
			const held = linearEntityId("issue", DESTINATION_ID, "team_1", "inc_1", "")
			const linear = fakeLinear({ taken: [held] })
			const result = yield* linear.send(inputFor())
			const creates = linear.calls.filter((call) => call.name === "MapleIssueCreate")
			assert.lengthOf(creates, 2)
			assert.strictEqual(result.providerMessage, "Opened Linear issue ENG-1")
		}),
	)
})

describe("linearEntityId", () => {
	it("is a stable UUID v4 per input", () => {
		const id = linearEntityId("comment", "delivery_1")
		assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
		assert.strictEqual(id, linearEntityId("comment", "delivery_1"))
		assert.notStrictEqual(id, linearEntityId("comment", "delivery_2"))
	})
})

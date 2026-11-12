import { AWS_MODULE_SPECS, AwsMetricStream } from "@maple/domain/aws"
import {
	Timestamp,
	V2AwsConnection,
	V2AwsCreateConnectionRequest,
	type V2AwsIngest,
	type V2AwsIntegration,
	type V2AwsSetup,
} from "@maple/domain/http/v2"
import * as Policy from "@maple/domain/policy"
import { AwsAccountId, AwsConnectionId, AwsModule } from "@maple/primitives"
import { Array as Arr, Effect, Option, Record as Rec, Result, Schema, String as Str } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import {
	CheckAwsConnection,
	CreateAwsConnection,
	LoadAwsIngest,
	LoadAwsSetup,
	UpdateAwsModules,
} from "../page/infra-integrations/aws/integration/aws"
import { ReadClock, STATUS_READS } from "../page/integrations/command"
import { Message as IntegrationsMessage } from "../page/integrations/message"
import { Model as IntegrationsModel } from "../page/integrations/model"
import * as Integrations from "../page/integrations/update"
import { view as integrationsView } from "../page/integrations/view"
import { Message as NewMessage } from "../page/sources/new/message"
import { Model as NewModel } from "../page/sources/new/model"
import { initPage as newInit, update as newUpdate } from "../page/sources/new/update"
import { view as newView } from "../page/sources/new/view"
import type { Resources } from "../platform/resources"
import { AppRoute } from "../route"
import { LAB_CONTEXT } from "./gcp-host"
import { keepLocal } from "./local-commands"

// `/lab/aws-connection`: the AWS integration around its Cost module, over one synthetic account
// (`?state=`): the connected card and the connect flow, each with and without the module offered.
// The switch, Sync now and the account form work: every read and write is answered from the fixture.

export const LabState = Schema.Literals([
	"before",
	"off",
	"waiting",
	"granted",
	"member",
	"pending",
	"failing",
	"stopped",
	"metrics-off",
	"flow",
	"flow-before",
])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "off",
	),
}))

const NOW_MS = Date.UTC(2026, 10, 6, 12)
const at = (minutesAgo: number) =>
	Schema.decodeSync(Timestamp)(new Date(NOW_MS - minutesAgo * 60_000).toISOString())

const ACCOUNT = Schema.decodeSync(AwsAccountId)("123456789012")
const CONNECTION_ID = Schema.decodeSync(AwsConnectionId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")
const NEW_CONNECTION_ID = Schema.decodeSync(AwsConnectionId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f9")

/** The id's first 24 hex digits, as the stack and role names carry it. */
const suffixOf = (id: AwsConnectionId) => Str.slice(0, 24)(Str.replaceAll("-", "")(id))

const roleArn = (id: AwsConnectionId, account: string = ACCOUNT) =>
	`arn:aws:iam::${account}:role/MapleIntegration-${suffixOf(id)}`

const CONNECTED: V2AwsConnection = {
	id: CONNECTION_ID,
	object: "aws_connection",
	account_id: ACCOUNT,
	role_arn: roleArn(CONNECTION_ID),
	oidc_issuer: "https://api.maple.dev/oidc/aws",
	oidc_subject: `aws-connection:${CONNECTION_ID}`,
	modules: [],
	granted_modules: [],
	template_version: 2,
	setup_outdated: false,
	verified_at: at(60 * 24 * 14),
	last_checked_at: at(12),
	last_check_error: null,
	metric_stream: Schema.decodeSync(AwsMetricStream)({
		regions: ["us-east-1"],
		namespaces: ["AWS/ECS", "AWS/ApplicationELB"],
	}),
	metric_stream_changed_at: at(60 * 24 * 14),
	metrics_last_received_at: at(1),
	metrics_last_error: null,
	created_at: at(60 * 24 * 14),
}

const INGEST: V2AwsIngest = {
	object: "aws_connection.ingest",
	window_start: at(60),
	window_end: at(0),
	data_points: 5_040,
	last_point_at: at(1),
	groups: [
		{
			namespace: "AWS/ECS",
			region: "us-east-1",
			metrics: 4,
			data_points: 2_880,
			resources: 3,
			sample_resources: ["example-api", "example-worker", "example-web"],
			last_point_at: at(1),
		},
		{
			namespace: "AWS/ApplicationELB",
			region: "us-east-1",
			metrics: 9,
			data_points: 2_160,
			resources: 1,
			sample_resources: ["app/example-alb/0000000000000000"],
			last_point_at: at(2),
		},
	],
}

const setupOf = (connection: V2AwsConnection): V2AwsSetup => {
	const suffix = suffixOf(connection.id)
	return {
		object: "aws_connection.setup",
		stack_name: `maple-integration-${suffix}`,
		stack_region: "us-east-1",
		setup_script: Arr.join(
			[
				"set -euo pipefail",
				"# Lab fixture: not a real setup script.",
				`aws cloudformation deploy --stack-name maple-integration-${suffix} \\`,
				"  --template-file maple-integration.json --capabilities CAPABILITY_NAMED_IAM \\",
				`  --parameter-overrides Modules=${Arr.join(connection.modules, ",")}`,
			],
			"\n",
		),
		cleanup_script: `aws cloudformation delete-stack --stack-name maple-integration-${suffix}`,
		cloudformation_template: '{ "Description": "Lab fixture" }',
		terraform: "# Lab fixture",
		metrics_stack_name: null,
		metrics_cloudformation_template: null,
	}
}

/** What the lab's API holds: whether the org is offered Cost, and its connections. */
const Fixture = Schema.Struct({ isOffered: Schema.Boolean, connections: Schema.Array(V2AwsConnection) })
type Fixture = typeof Fixture.Type

const fixtureFor = (state: LabState): Fixture => {
	const isOffered = state !== "before" && state !== "flow-before"
	if (state === "flow" || state === "flow-before") return { isOffered, connections: [] }
	if (state === "waiting")
		return { isOffered, connections: [{ ...CONNECTED, modules: ["cost"], setup_outdated: true }] }
	if (state === "granted")
		return {
			isOffered,
			connections: [{ ...CONNECTED, modules: ["cost"], granted_modules: ["cost"] }],
		}
	// The stack was never deployed: nothing is verified, granted or received yet.
	if (state === "pending")
		return {
			isOffered,
			connections: [
				{
					...CONNECTED,
					granted_modules: null,
					template_version: null,
					verified_at: null,
					last_checked_at: at(1),
					metric_stream_changed_at: at(6),
					metrics_last_received_at: null,
					created_at: at(6),
				},
			],
		}
	if (state === "failing")
		return {
			isOffered,
			connections: [
				{
					...CONNECTED,
					last_check_error:
						"AccessDenied: Maple could not assume the role. Its trust policy does not name this connection.",
				},
			],
		}
	if (state === "stopped")
		return { isOffered, connections: [{ ...CONNECTED, metrics_last_received_at: at(60 * 9) }] }
	if (state === "metrics-off")
		return {
			isOffered,
			connections: [
				{
					...CONNECTED,
					metric_stream: null,
					metric_stream_changed_at: null,
					metrics_last_received_at: null,
				},
			],
		}
	return { isOffered, connections: [CONNECTED] }
}

/** Every module as the API lists it; only Cost can be offered. */
const statusOf = (fixture: Fixture): V2AwsIntegration => ({
	object: "aws_integration",
	available: true,
	modules: Arr.map(Rec.toEntries(AWS_MODULE_SPECS), ([module, spec]) => ({
		module,
		title: spec.title,
		summary: spec.summary,
		available: module === "cost" && fixture.isOffered,
	})),
	connections: fixture.connections,
})

const withConnection = (fixture: Fixture, connection: V2AwsConnection): Fixture => ({
	...fixture,
	connections: Arr.some(fixture.connections, (entry) => entry.id === connection.id)
		? Arr.map(fixture.connections, (entry) => (entry.id === connection.id ? connection : entry))
		: [...fixture.connections, connection],
})

const sameModules = (a: ReadonlyArray<AwsModule>, b: ReadonlyArray<AwsModule>) =>
	a.length === b.length && Arr.every(a, (module) => b.includes(module))

const keyArgs = Schema.decodeUnknownOption(Schema.Struct({ key: Schema.String }))
const keyedIdArgs = Schema.decodeUnknownOption(Schema.Struct({ key: Schema.String, id: AwsConnectionId }))
const modulesArgs = Schema.decodeUnknownOption(
	Schema.Struct({ id: AwsConnectionId, modules: Schema.Array(AwsModule) }),
)
const checkArgs = Schema.decodeUnknownOption(Schema.Struct({ id: AwsConnectionId, quiet: Schema.Boolean }))
const createArgs = Schema.decodeUnknownOption(Schema.Struct({ request: V2AwsCreateConnectionRequest }))

type Pending = Readonly<{ name: string; args?: unknown }>
type Answer = Readonly<{ message: IntegrationsMessage; fixture: Fixture }>

const found = (fixture: Fixture, id: AwsConnectionId) =>
	Arr.findFirst(fixture.connections, (entry) => entry.id === id)

/** A read or write the page asked for, answered the way the API would, and the fixture after it. */
const answerOf = (fixture: Fixture, command: Pending): Option.Option<Answer> => {
	switch (command.name) {
		case ReadClock.name:
			return Option.some({
				message: IntegrationsMessage.CompletedReadClock({ nowMs: NOW_MS }),
				fixture,
			})
		case STATUS_READS.aws.name:
			return Option.map(keyArgs(command.args), ({ key }) => ({
				message: IntegrationsMessage.CompletedLoadAws({
					key,
					result: Result.succeed(statusOf(fixture)),
				}),
				fixture,
			}))
		case LoadAwsIngest.name:
			return Option.map(keyedIdArgs(command.args), ({ key, id }) => ({
				message: IntegrationsMessage.CompletedLoadAwsIngest({
					id,
					key,
					result: Result.succeed(INGEST),
				}),
				fixture,
			}))
		case LoadAwsSetup.name:
			return Option.flatMap(keyedIdArgs(command.args), ({ key, id }) =>
				Option.map(found(fixture, id), (connection) => ({
					message: IntegrationsMessage.CompletedLoadAwsSetup({
						key,
						result: Result.succeed(setupOf(connection)),
					}),
					fixture,
				})),
			)
		case UpdateAwsModules.name:
			return Option.flatMap(modulesArgs(command.args), ({ id, modules }) =>
				Option.map(found(fixture, id), (before) => {
					const connection: V2AwsConnection = {
						...before,
						modules,
						setup_outdated:
							before.granted_modules !== null && !sameModules(modules, before.granted_modules),
					}
					return {
						message: IntegrationsMessage.CompletedAwsModules({ id, connection, error: null }),
						fixture: withConnection(fixture, connection),
					}
				}),
			)
		// Sync now stands for a deploy: the role then grants what the connection asks for.
		case CheckAwsConnection.name:
			return Option.flatMap(checkArgs(command.args), ({ id, quiet }) =>
				Option.map(found(fixture, id), (before) => {
					const connection: V2AwsConnection = {
						...before,
						granted_modules: before.modules,
						template_version: 2,
						setup_outdated: false,
						verified_at: before.verified_at ?? at(0),
						last_checked_at: at(0),
					}
					return {
						message: IntegrationsMessage.CompletedAwsCheck({
							id,
							quiet,
							connection,
							failure: null,
						}),
						fixture: withConnection(fixture, connection),
					}
				}),
			)
		case CreateAwsConnection.name:
			return Option.map(createArgs(command.args), ({ request }) => {
				const connection: V2AwsConnection = {
					...CONNECTED,
					id: NEW_CONNECTION_ID,
					account_id: request.account_id,
					role_arn: roleArn(NEW_CONNECTION_ID, request.account_id),
					oidc_subject: `aws-connection:${NEW_CONNECTION_ID}`,
					modules: request.modules ?? [],
					granted_modules: null,
					template_version: null,
					verified_at: null,
					last_checked_at: null,
					metric_stream: null,
					metric_stream_changed_at: null,
					metrics_last_received_at: null,
					created_at: at(0),
				}
				return {
					message: IntegrationsMessage.SucceededAwsCreate({ connection }),
					fixture: withConnection(fixture, connection),
				}
			})
		default:
			return Option.none()
	}
}

type Settled<M, C> = Readonly<{ fixture: Fixture; model: M; commands: ReadonlyArray<C> }>

/**
 * Answers the page's reads and writes from the fixture until none is left: an answer can ask for
 * more (a saved module re-reads the status and the setup). What is not answered is handed back.
 */
const settle = <M, C extends Pending>(
	start: Settled<M, C>,
	apply: (model: M, message: IntegrationsMessage) => Readonly<{ model: M; commands?: ReadonlyArray<C> }>,
	depth = 0,
): Settled<M, C> => {
	const next = Arr.reduce(
		start.commands,
		{ fixture: start.fixture, model: start.model, asked: Arr.empty<C>(), rest: Arr.empty<C>() },
		(acc, command) =>
			Option.match(answerOf(acc.fixture, command), {
				onNone: () => ({ ...acc, rest: [...acc.rest, command] }),
				onSome: (answer) => {
					const step = apply(acc.model, answer.message)
					return {
						...acc,
						fixture: answer.fixture,
						model: step.model,
						asked: [...acc.asked, ...(step.commands ?? [])],
					}
				},
			}),
	)
	if (next.asked.length === 0 || depth > 8)
		return { fixture: next.fixture, model: next.model, commands: next.rest }
	const later = settle({ fixture: next.fixture, model: next.model, commands: next.asked }, apply, depth + 1)
	return { ...later, commands: [...next.rest, ...later.commands] }
}

export const Model = Schema.Struct({
	state: LabState,
	fixture: Fixture,
	hub: IntegrationsModel,
	create: NewModel,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotHubMessage: { message: IntegrationsMessage },
	GotCreateMessage: { message: NewMessage },
})
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>

const applyHub = (model: IntegrationsModel, message: IntegrationsMessage) =>
	Integrations.update(model, message, LAB_CONTEXT)

const applyCreate = (model: NewModel, message: IntegrationsMessage) =>
	newUpdate(model, NewMessage.GotIntegrationsMessage({ message }), LAB_CONTEXT)

const liftHub = (commands: ReadonlyArray<Command.Command<IntegrationsMessage, never, Resources>>) =>
	Command.mapMessages(keepLocal(commands), (message) => Message.GotHubMessage({ message }))

const liftCreate = (commands: ReadonlyArray<Command.Command<NewMessage, never, Resources>>) =>
	Command.mapMessages(keepLocal(commands), (message) => Message.GotCreateMessage({ message }))

const isFlow = (state: LabState) => state === "flow" || state === "flow-before"

export const init = ({ state }: Flags): Return => {
	const fixture = fixtureFor(state)
	const grants = state === "member" ? [] : Policy.allPermissions
	const entered = Integrations.init({ search: { integration: "aws" } }, LAB_CONTEXT)
	const hub = settle(
		{ fixture, model: { ...entered.model, grants }, commands: entered.commands ?? [] },
		applyHub,
	)
	const opened = newInit(AppRoute.SourcesNew({ search: { integration: "aws" } }), LAB_CONTEXT)
	const create = settle(
		{ fixture, model: { ...opened.model, grants }, commands: opened.commands ?? [] },
		applyCreate,
	)
	return {
		model: { state, fixture, hub: hub.model, create: create.model },
		commands: isFlow(state) ? liftCreate(create.commands) : liftHub(hub.commands),
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotHubMessage: ({ message: child }) => {
			const step = Integrations.update(model.hub, child, LAB_CONTEXT)
			const ready = settle(
				{ fixture: model.fixture, model: step.model, commands: step.commands ?? [] },
				applyHub,
			)
			return {
				model: { ...model, fixture: ready.fixture, hub: ready.model },
				commands: liftHub(ready.commands),
			}
		},
		GotCreateMessage: ({ message: child }) => {
			const step = newUpdate(model.create, child, LAB_CONTEXT)
			const ready = settle(
				{ fixture: model.fixture, model: step.model, commands: step.commands ?? [] },
				applyCreate,
			)
			return {
				model: { ...model, fixture: ready.fixture, create: ready.model },
				commands: liftCreate(ready.commands),
			}
		},
	})

export const breadcrumbs = [{ label: "Lab", href: "/lab" }, { label: "AWS connection" }] as const

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	isFlow(model.state)
		? h.submodel({
				slotId: "aws-connection-lab-flow",
				model: model.create,
				view: newView,
				viewInputs: { context: LAB_CONTEXT },
				toParentMessage: (message: NewMessage) => Message.GotCreateMessage({ message }),
			})
		: h.submodel({
				slotId: "aws-connection-lab-card",
				model: model.hub,
				view: integrationsView,
				viewInputs: { context: LAB_CONTEXT },
				toParentMessage: (message: IntegrationsMessage) => Message.GotHubMessage({ message }),
			})

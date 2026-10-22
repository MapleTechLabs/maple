import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import { AwsAccountId, AwsConnectionId, AwsModule } from "../../primitives"
import {
	AwsAccountAlreadyConnectedError,
	AwsIntegrationUnavailableError,
	IntegrationsNotFoundError,
	IntegrationsPersistenceError,
	IntegrationsValidationError,
} from "../integrations"
import { AuthorizationV2 } from "./auth"
import { wireExample, Timestamp } from "./envelopes"
import { V2InsufficientPermissions } from "./errors"
import { publicErrors } from "./public-error"
import { PublicId, PublicIdPrefixes } from "./public-id"

// AWS integration. No OAuth and no stored secret: an org registers a connection for an account, an
// administrator deploys the generated CloudFormation stack, and Maple assumes the role it creates
// with an external id Maple minted. Each module is its own policy on the role. Public v2 from the
// start so scripted setups can use a scoped API key.

/** `awsc_…` public ID ⇄ internal `AwsConnectionId` (raw UUID). */
export const AwsConnectionPublicId = PublicId(PublicIdPrefixes.awsConnection, AwsConnectionId)

const connectionExample = {
	id: "awsc_YofPTrK9782DWwcnXhpcCw",
	object: "aws_connection",
	account_id: "123456789012",
	role_arn: "arn:aws:iam::123456789012:role/MapleIntegration-018f2b3c4d5e4f708192a3b4",
	external_id: "9f1c4e2a7b3d4c6e8a0b1c2d3e4f5a6b",
	modules: [],
	granted_modules: [],
	template_version: 1,
	setup_outdated: false,
	verified_at: "2026-10-21T12:05:00.000Z",
	last_checked_at: "2026-10-21T13:00:00.000Z",
	last_check_error: null,
	created_at: "2026-10-21T12:00:00.000Z",
} as const

export const V2AwsConnection = Schema.Struct({
	id: AwsConnectionPublicId,
	object: Schema.Literal("aws_connection").annotate({
		description: 'The object type, always `"aws_connection"`.',
	}),
	account_id: AwsAccountId.annotate({
		description: "The 12-digit AWS account the connection reads.",
	}),
	role_arn: Schema.String.annotate({
		description:
			"The IAM role the setup creates and Maple assumes. Its name is derived from the connection, so it cannot point at another role.",
		examples: [connectionExample.role_arn],
	}),
	external_id: Schema.String.annotate({
		description:
			"The external id the role's trust policy requires. Maple mints it; it is not a secret, but it is what keeps another Maple organization from assuming this role.",
		examples: [connectionExample.external_id],
	}),
	modules: Schema.Array(AwsModule).annotate({
		description: "What the connection is meant to let Maple read. The setup grants exactly these.",
		examples: [[]],
	}),
	granted_modules: Schema.NullOr(Schema.Array(AwsModule)).annotate({
		description:
			"The modules whose policies the latest check found on the role, or `null` before a check could assume it.",
		examples: [[]],
	}),
	template_version: Schema.NullOr(Schema.Number).annotate({
		description: "The setup version the role is tagged with, or `null` before a check could read it.",
		examples: [1],
	}),
	setup_outdated: Schema.Boolean.annotate({
		description:
			"Whether the deployed setup differs from what the connection asks for: an older template, or other modules. Deploy the stack from `setup` again.",
		examples: [false],
	}),
	verified_at: Schema.NullOr(Timestamp).annotate({
		description: "When Maple first assumed the role, or `null` while the setup has not been deployed.",
	}),
	last_checked_at: Schema.NullOr(Timestamp).annotate({
		description: "When Maple last tried to assume the role. Checked hourly and on `check`.",
	}),
	last_check_error: Schema.NullOr(Schema.String).annotate({
		description: "Why the latest check failed and what to do about it, or `null`.",
		examples: [null],
	}),
	created_at: Timestamp.annotate({ description: "When the connection was created." }),
}).annotate({
	identifier: "AwsConnection",
	title: "AWS connection",
	description: "One connected AWS account.",
	examples: [wireExample(connectionExample)],
})
export type V2AwsConnection = Schema.Schema.Type<typeof V2AwsConnection>

export const V2AwsModuleInfo = Schema.Struct({
	module: AwsModule,
	title: Schema.String,
	summary: Schema.String,
	available: Schema.Boolean.annotate({
		description:
			"Whether Maple reads anything with this module yet. Unavailable modules cannot be requested.",
	}),
}).annotate({ identifier: "AwsModuleInfo", title: "AWS module" })

export const V2AwsIntegration = Schema.Struct({
	object: Schema.Literal("aws_integration").annotate({
		description: 'The object type, always `"aws_integration"`.',
	}),
	available: Schema.Boolean.annotate({
		description:
			"Whether this Maple deployment has an AWS identity to assume roles with. When `false`, connections cannot be created.",
		examples: [true],
	}),
	modules: Schema.Array(V2AwsModuleInfo).annotate({
		description: "Every module, in the order the setup lists them.",
	}),
	connections: Schema.Array(V2AwsConnection).annotate({
		description: "Every connection of the organization, oldest first.",
	}),
}).annotate({
	identifier: "AwsIntegration",
	title: "AWS integration status",
	description:
		'The AWS integration state for the authenticated organization. Note: `connections` is **not** the standard `{ object: "list", data, has_more, next_cursor }` envelope: an organization has a handful of connections and they are returned whole.',
	examples: [
		wireExample({
			object: "aws_integration",
			available: true,
			modules: [],
			connections: [connectionExample],
		}),
	],
})
export type V2AwsIntegration = Schema.Schema.Type<typeof V2AwsIntegration>

const modulesField = (description: string) =>
	Schema.optionalKey(Schema.Array(AwsModule)).annotate({ description, examples: [[]] })

export const V2AwsCreateConnectionRequest = Schema.Struct({
	account_id: AwsAccountId.annotate({ description: "The 12-digit AWS account ID." }),
	modules: modulesField("What Maple may read. Defaults to none: the role then only lets Maple confirm the setup."),
}).annotate({
	identifier: "AwsCreateConnectionRequest",
	title: "AWS connection create request",
	examples: [wireExample({ account_id: "123456789012" })],
})
export type V2AwsCreateConnectionRequest = Schema.Schema.Type<typeof V2AwsCreateConnectionRequest>

export const V2AwsUpdateConnectionRequest = Schema.Struct({
	modules: modulesField("What Maple may read. Omitted: the connection's modules are unchanged; `[]` removes them all."),
}).annotate({
	identifier: "AwsUpdateConnectionRequest",
	title: "AWS connection update request",
	description: "Omitted fields are unchanged. AWS follows once the stack from `setup` is deployed again.",
	examples: [wireExample({ modules: [] })],
})
export type V2AwsUpdateConnectionRequest = Schema.Schema.Type<typeof V2AwsUpdateConnectionRequest>

const SCRIPT_EXAMPLE = "set -euo pipefail\n…\naws cloudformation deploy --stack-name maple-integration-…\n"

export const V2AwsSetup = Schema.Struct({
	object: Schema.Literal("aws_connection.setup").annotate({
		description: 'The object type, always `"aws_connection.setup"`.',
	}),
	stack_name: Schema.String.annotate({
		description: "The CloudFormation stack the setup deploys.",
		examples: ["maple-integration-018f2b3c4d5e4f708192a3b4"],
	}),
	stack_region: Schema.String.annotate({
		description:
			"The region the stack lives in. IAM is global, but a stack is not: create and delete it in this region.",
		examples: ["us-east-1"],
	}),
	setup_script: Schema.String.annotate({
		description:
			"Text to paste into AWS CloudShell, signed in to the connection's account as an administrator. It deploys `cloudformation_template` as `stack_name`; run it again after changing `modules`. It carries no secret.",
		examples: [SCRIPT_EXAMPLE],
	}),
	cleanup_script: Schema.String.annotate({
		description: "Text to paste into AWS CloudShell that deletes the stack and everything it created.",
		examples: ["aws cloudformation delete-stack --stack-name maple-integration-…\n"],
	}),
	cloudformation_template: Schema.String.annotate({
		description:
			"For a setup in the console: the stack as a CloudFormation template (JSON), to upload under Create stack → With new resources.",
	}),
	terraform: Schema.String.annotate({
		description: "The same setup as a self-contained Terraform file for the `aws` provider.",
	}),
}).annotate({
	identifier: "AwsSetup",
	title: "AWS connection setup",
	description:
		"The ways to set up one AWS connection: the CloudShell script, or the same resources in the console or as code. Maple confirms the setup by assuming the role.",
})
export type V2AwsSetup = Schema.Schema.Type<typeof V2AwsSetup>

export const V2AwsConnectionDeleteResponse = Schema.Struct({
	id: AwsConnectionPublicId,
	object: Schema.Literal("aws_connection").annotate({
		description: 'The object type, always `"aws_connection"`.',
	}),
	deleted: Schema.Literal(true).annotate({
		description: "Always `true` on a successful delete.",
	}),
	cleanup_script: Schema.String.annotate({
		description:
			"Text to paste into AWS CloudShell that deletes the stack. Maple has no write access to AWS, so an administrator runs it; until then the role exists but no Maple organization holds its external id.",
	}),
}).annotate({
	identifier: "AwsConnectionDeleteResponse",
	title: "AWS connection delete response",
})
export type V2AwsConnectionDeleteResponse = Schema.Schema.Type<typeof V2AwsConnectionDeleteResponse>

const [alreadyConnected, unavailable, validation, connectionNotFound, integrationPersistence] = publicErrors(
	AwsAccountAlreadyConnectedError,
	AwsIntegrationUnavailableError,
	IntegrationsValidationError,
	IntegrationsNotFoundError,
	IntegrationsPersistenceError,
)

const connectionParams = { id: AwsConnectionPublicId }

export class V2AwsIntegrationsApiGroup extends HttpApiGroup.make("awsIntegration")
	.add(
		HttpApiEndpoint.get("status", "/", {
			success: V2AwsIntegration,
			error: [integrationPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getAwsIntegration",
				summary: "Retrieve AWS integration status",
				description:
					"Returns the organization's AWS connections with the outcome of their latest check, the modules Maple offers, and whether this deployment can connect AWS at all. Requires the `integrations:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("createConnection", "/connections", {
			payload: V2AwsCreateConnectionRequest,
			success: V2AwsConnection,
			error: [
				V2InsufficientPermissions.schema,
				alreadyConnected,
				unavailable,
				validation,
				integrationPersistence,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createAwsConnection",
				summary: "Connect an AWS account",
				description:
					"Registers a connection for one account and mints its external id. Maple reads nothing until an administrator deploys the stack from `setup`. An account can be connected once per Maple organization. Requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("updateConnection", "/connections/:id", {
			params: connectionParams,
			payload: V2AwsUpdateConnectionRequest,
			success: V2AwsConnection,
			error: [V2InsufficientPermissions.schema, connectionNotFound, validation, integrationPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateAwsConnection",
				summary: "Change what a connection reads",
				description:
					"Changes the connection's modules. Maple cannot change AWS itself: deploy the stack from `setup` again afterwards. Requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("setup", "/connections/:id/setup", {
			params: connectionParams,
			success: V2AwsSetup,
			error: [
				V2InsufficientPermissions.schema,
				connectionNotFound,
				unavailable,
				integrationPersistence,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getAwsConnectionSetup",
				summary: "Render a connection's setup",
				description:
					"Returns the CloudShell script, the CloudFormation template and the Terraform file that set up one connection. Requires an org-admin role and the `integrations:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("checkConnection", "/connections/:id/check", {
			params: connectionParams,
			success: V2AwsConnection,
			error: [
				V2InsufficientPermissions.schema,
				connectionNotFound,
				unavailable,
				integrationPersistence,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "checkAwsConnection",
				summary: "Check a connection now",
				description:
					"Assumes the role and reads what the setup granted, instead of waiting for the hourly check. A failed check is reported in `last_check_error`, not as an error response. Requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("deleteConnection", "/connections/:id", {
			params: connectionParams,
			success: V2AwsConnectionDeleteResponse,
			error: [V2InsufficientPermissions.schema, connectionNotFound, integrationPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "deleteAwsConnection",
				summary: "Disconnect an AWS account",
				description:
					"Deletes the connection and its source, after which Maple no longer assumes the role. Already-ingested data is unaffected. The response carries the script that deletes the stack. Requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.prefix("/v2/integrations/aws")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "AWS Integration",
			description:
				"Connect AWS accounts: register a connection, choose what Maple may read, fetch the CloudFormation stack that sets it up, and see whether Maple can assume its role.",
		}),
	) {}

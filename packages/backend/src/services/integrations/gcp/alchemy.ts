import {
	GCP_PUSH_SUBSCRIPTION,
	GCP_READER_PROJECT_ROLE,
	GCP_READER_SCOPE_ROLES,
	type GcpSetupPlan,
} from "@maple/domain/gcp"
import type { GcpExisting } from "./terraform"

// The alchemy the stack is written for: version 2 is in beta, and resource props still change.
const ALCHEMY_VERSION = "2.0.0-beta.83"

/** A TypeScript string literal. */
const ts = (value: string): string => JSON.stringify(value)

// Alchemy creates a project sink, the topic and the subscription in the project it signs in to.
const SINKS = { project: "Sink", folder: "FolderSink", organization: "OrganizationSink" } as const

const logsSection = (plan: GcpSetupPlan, logs: NonNullable<GcpSetupPlan["logs"]>) => {
	const parent =
		plan.scopeType === "project"
			? ""
			: `\n      ${plan.scopeType === "folder" ? "folderId" : "organization"}: ${ts(plan.scopeId)},`
	return `
    // ---- Log forwarding ----
    const topic = yield* GCP.PubSub.Topic("maple-topic", { topicId: ${ts(logs.topic)} })

    // What Pub/Sub signs its pushes as. It holds no role anywhere.
    const pushAccount = yield* GCP.IAM.ServiceAccount("maple-push", {
      project: PROJECT_ID,
      accountId: ${ts(logs.pushServiceAccountId)},
      displayName: "Maple log push identity",
      description: "Signs Pub/Sub push requests to Maple. Holds no roles.",
    })
    // Pub/Sub's service agent mints the push tokens: needed in projects created before April 2021.
    yield* GCP.IAM.Member("maple-push-token-creator", {
      kind: "iam.serviceAccount",
      name: pushAccount.name,
      role: "roles/iam.serviceAccountTokenCreator",
      member: \`serviceAccount:service-\${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com\`,
    })

    // One LogEntry per request, unwrapped. noWrapper is sent as given though alchemy's type omits it.
    const pushConfig = {
      pushEndpoint: PUSH_ENDPOINT,
      noWrapper: { writeMetadata: false },
      oidcToken: { serviceAccountEmail: pushAccount.email, audience: PUSH_ENDPOINT },
    }
    // A day of retention bounds a replay. An expiration policy without a ttl never expires.
    yield* GCP.PubSub.Subscription("maple-subscription", {
      subscriptionId: ${ts(logs.subscription)},
      topic: topic.name,
      ackDeadlineSeconds: ${GCP_PUSH_SUBSCRIPTION.ackDeadlineSeconds},
      messageRetentionDuration: "${GCP_PUSH_SUBSCRIPTION.messageRetentionSeconds}s",
      expirationPolicy: {},
      retryPolicy: {
        minimumBackoff: "${GCP_PUSH_SUBSCRIPTION.minRetryDelaySeconds}s",
        maximumBackoff: "${GCP_PUSH_SUBSCRIPTION.maxRetryDelaySeconds}s",
      },
      pushConfig,
    })

    const sink = yield* GCP.Logging.${SINKS[plan.scopeType]}("maple-sink", {${parent}
      sinkId: ${ts(logs.sink)},
      destination: Output.interpolate\`pubsub.googleapis.com/\${topic.name}\`,
      filter: LOG_FILTER,
      ${plan.scopeType === "project" ? "uniqueWriterIdentity: true" : "includeChildren: true"},
    })
    // The sink writes as the logging service agent every sink on the ${plan.scopeType} shares. Publisher
    // on this topic is all it needs; a project role it holds is not this stack's to revoke.
    yield* GCP.IAM.Member("maple-sink-publisher", {
      kind: "pubsub.topic",
      name: topic.name,
      role: "roles/pubsub.publisher",
      member: Output.map(sink.writerIdentity, (identity) => identity ?? ""),
    })
`
}

const readerSection = (reader: NonNullable<GcpSetupPlan["reader"]>) => `
    // ---- Metrics and resources ----
    // A read-only account Maple reads as through short-lived tokens. No key is created.
    const reader = yield* GCP.IAM.ServiceAccount("maple-reader", {
      project: PROJECT_ID,
      accountId: ${ts(reader.serviceAccountId)},
      displayName: "Maple metrics and resource reader",
    })
    yield* GCP.IAM.Member("maple-reader-token-creator", {
      kind: "iam.serviceAccount",
      name: reader.name,
      role: "roles/iam.serviceAccountTokenCreator",
      member: \`serviceAccount:\${MAPLE_SERVICE_ACCOUNT}\`,
    })
    // The narrowest predefined roles for Maple's reads, and the quota they count against.
    for (const role of [${[...GCP_READER_SCOPE_ROLES, GCP_READER_PROJECT_ROLE].map(ts).join(", ")}]) {
      yield* GCP.IAM.Member(\`maple-reader-\${role.split("/")[1]}\`, {
        kind: "project",
        name: PROJECT_ID,
        role,
        member: Output.interpolate\`serviceAccount:\${reader.email}\`,
      })
    }
`

/**
 * A self-contained Alchemy stack for the connection. Null for a folder or organization with
 * read-only access: Alchemy's IAM members can't reach a folder's or organization's policy.
 */
export const renderGcpAlchemy = (plan: GcpSetupPlan, existing: GcpExisting): string | null => {
	const { logs, reader } = plan
	if (reader !== null && plan.scopeType !== "project") return null
	const takeOver = existing.logs || existing.reader
	// Alchemy keys its state by stack name: one per connection, or a second replaces the first.
	const stackName = logs?.topic ?? reader?.serviceAccountId ?? "maple-gcp"
	const constants = [
		...(logs === null
			? []
			: [
					`// Its number: gcloud projects describe ${plan.projectId} --format='value(projectNumber)'`,
					`const PROJECT_NUMBER = ""`,
					`const PUSH_ENDPOINT = ${ts(logs.pushEndpoint)}`,
					`const LOG_FILTER = ${ts(logs.logFilter)}`,
				]),
		...(reader === null ? [] : [`const MAPLE_SERVICE_ACCOUNT = ${ts(reader.mapleServiceAccountEmail)}`]),
	]
	return `// Maple connection for Google Cloud ${plan.scopeType} ${plan.scopeId}
//   Log forwarding:        ${logs === null ? "off" : "on"}
//   Metrics and resources: ${reader === null ? "off" : "on"}
// This file carries no secret${logs === null ? "." : `: Pub/Sub signs each push as ${logs.pushServiceAccountId},\n// and Maple checks the signature.`}
// Details: https://maple.dev/docs/integrations/gcp-infrastructure-as-code
//
// Written for alchemy ${ALCHEMY_VERSION}: bun add alchemy@${ALCHEMY_VERSION} effect@^4 @effect/platform-bun@^4
// Alchemy does not wait for an API to be switched on, so switch them on first:
//   gcloud services enable ${plan.apis.join(" ")} --project=${plan.projectId}
// Then deploy as an account allowed to create these resources, in the project it signs in to,
// which must be ${plan.projectId}. --adopt takes over what an earlier setup ${takeOver ? "created" : "may have left in place: add it then"}:
//   GOOGLE_ACCESS_TOKEN="$(gcloud auth print-access-token)" GOOGLE_PROJECT_ID=${plan.projectId} bunx alchemy deploy maple.ts --stage maple${takeOver ? " --adopt" : ""}${
		logs === null
			? ""
			: `
// A destroy deletes the topic right after the sink, and Google may log a sink error for the
// minutes it keeps routing. To avoid it, delete the sink in the console two minutes earlier.`
	}
import * as Alchemy from "alchemy"
import * as GCP from "alchemy/GCP"
import * as Output from "alchemy/Output"
import * as Effect from "effect/Effect"

// The host project holds Maple's Pub/Sub topic, subscription and service accounts.
const PROJECT_ID = ${ts(plan.projectId)}
${constants.join("\n")}
${logs === null ? "" : `if (!/^\\d+$/.test(PROJECT_NUMBER)) throw new Error("Set PROJECT_NUMBER at the top of maple.ts.")\n`}
export default Alchemy.Stack(
  ${ts(stackName)},
  { providers: GCP.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {${logs === null ? "" : logsSection(plan, logs)}${reader === null ? "" : readerSection(reader)}  }),
)
`
}

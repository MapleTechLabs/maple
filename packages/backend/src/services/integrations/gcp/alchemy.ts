import type { GcpSetupPlan } from "./setup-plan"

const DOCS_URL = "https://maple.dev/docs/integrations/gcp"
// The alchemy the stack is written for: version 2 is in beta, and resource props still change.
const ALCHEMY_VERSION = "2.0.0-beta.83"

/** A TypeScript string literal. */
const ts = (value: string): string => JSON.stringify(value)

// Alchemy creates a project sink, the topic and the subscription in the project it signs in to.
const SINKS = { project: "Sink", folder: "FolderSink", organization: "OrganizationSink" } as const

const logsSection = (plan: GcpSetupPlan, logs: NonNullable<GcpSetupPlan["logs"]>) => {
	const sink = SINKS[plan.scopeType]
	const parent =
		plan.scopeType === "project"
			? ""
			: `\n      ${plan.scopeType === "folder" ? "folderId" : "organization"}: ${ts(plan.scopeId)},`
	return `
    // ---- Log forwarding ----
    // A Log Router sink on the ${plan.scopeType} routes entries into a Pub/Sub topic, whose push
    // subscription delivers each LogEntry to Maple, signed as the push service account.
    const topic = yield* GCP.PubSub.Topic("maple-topic", { topicId: ${ts(logs.topic)} })

    // What Pub/Sub signs its pushes as. It holds no role anywhere: a token for it proves only
    // that a push came from this subscription.
    const pushAccount = yield* GCP.IAM.ServiceAccount("maple-push", {
      project: PROJECT_ID,
      accountId: ${ts(logs.pushServiceAccountId)},
      displayName: "Maple log push identity",
      description: "Signs Pub/Sub push requests to Maple. Holds no roles.",
    })
    // Pub/Sub's service agent mints the push tokens. Newer projects allow it by default, older
    // ones need this grant.
    yield* GCP.IAM.Member("maple-push-token-creator", {
      kind: "iam.serviceAccount",
      name: pushAccount.name,
      role: "roles/iam.serviceAccountTokenCreator",
      member: \`serviceAccount:service-\${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com\`,
    })

    // One LogEntry per request, unwrapped. Alchemy sends noWrapper as given, though its type
    // leaves it out: hence a variable rather than an inline object.
    const pushConfig = {
      pushEndpoint: PUSH_ENDPOINT,
      noWrapper: { writeMetadata: false },
      oidcToken: { serviceAccountEmail: pushAccount.email, audience: PUSH_ENDPOINT },
    }
    // A day of retention bounds what is replayed after an outage. An expiration policy without
    // a ttl never expires.
    yield* GCP.PubSub.Subscription("maple-subscription", {
      subscriptionId: ${ts(logs.subscription)},
      topic: topic.name,
      ackDeadlineSeconds: ${logs.ackDeadlineSeconds},
      messageRetentionDuration: "${logs.messageRetentionSeconds}s",
      expirationPolicy: {},
      retryPolicy: { minimumBackoff: "${logs.minRetryDelaySeconds}s", maximumBackoff: "${logs.maxRetryDelaySeconds}s" },
      pushConfig,
    })

    const sink = yield* GCP.Logging.${sink}("maple-sink", {${parent}
      sinkId: ${ts(logs.sink)},
      destination: Output.interpolate\`pubsub.googleapis.com/\${topic.name}\`,
      filter: LOG_FILTER,
      ${plan.scopeType === "project" ? "uniqueWriterIdentity: true" : "includeChildren: true"},
    })
    // The sink writes as a Google-managed identity: Logs Writer on the project that holds the
    // destination, and Pub/Sub Publisher on this one topic.
    const writer = Output.map(sink.writerIdentity, (identity) => identity ?? "")
    yield* GCP.IAM.Member("maple-sink-log-writer", {
      kind: "project",
      name: PROJECT_ID,
      role: "roles/logging.logWriter",
      member: writer,
    })
    yield* GCP.IAM.Member("maple-sink-publisher", {
      kind: "pubsub.topic",
      name: topic.name,
      role: "roles/pubsub.publisher",
      member: writer,
    })
`
}

const readerSection = (reader: NonNullable<GcpSetupPlan["reader"]>) => `
    // ---- Metrics and resources ----
    // A read-only service account Maple reads metrics and resources as, through short-lived
    // tokens its own account may mint for this one account. No key is created.
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
    // The narrowest predefined roles for Maple's two calls, monitoring.timeSeries.list and
    // cloudasset.assets.searchAllResources, and the quota of the project its reads are billed to.
    // All read-only; Cloud Asset Viewer can also read resource metadata and IAM policies.
    for (const role of [${[...reader.scopeRoles, ...reader.projectRoles].map(ts).join(", ")}]) {
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
 * read-only access: Alchemy's IAM members reach projects, service accounts and topics only, not
 * a folder's or an organization's policy.
 */
export const renderGcpAlchemy = (plan: GcpSetupPlan): string | null => {
	const { logs, reader } = plan
	if (reader !== null && plan.scopeType !== "project") return null
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
// It holds no secret${logs === null ? "." : ": Pub/Sub signs each push as the push service account, and Maple accepts only\n// that account's tokens."} Details: ${DOCS_URL}
//
// Written for alchemy ${ALCHEMY_VERSION}: bun add alchemy@${ALCHEMY_VERSION} effect@^4
// Alchemy does not wait for an API to be switched on, so switch them on first:
//   gcloud services enable ${plan.apis.join(" ")} --project=${plan.projectId}
// Then deploy as an account allowed to create these resources. Alchemy creates them in the project
// it signs in to, which must be ${plan.projectId}:
//   GOOGLE_ACCESS_TOKEN="$(gcloud auth print-access-token)" GOOGLE_PROJECT_ID=${plan.projectId} bunx alchemy deploy maple.ts --stage maple
// \`destroy\` instead of \`deploy\` removes it again; it needs the state alchemy keeps in .alchemy/.
import * as Alchemy from "alchemy"
import * as GCP from "alchemy/GCP"
import * as Output from "alchemy/Output"
import * as Effect from "effect/Effect"

// The host project holds Maple's Pub/Sub topic, subscription and service accounts.
const PROJECT_ID = ${ts(plan.projectId)}
${constants.join("\n")}
${logs === null ? "" : `if (!/^\\d+$/.test(PROJECT_NUMBER)) throw new Error("Set PROJECT_NUMBER at the top of maple.ts.")\n`}
export default Alchemy.Stack(
  "maple-gcp",
  { providers: GCP.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {${logs === null ? "" : logsSection(plan, logs)}${reader === null ? "" : readerSection(reader)}  }),
)
`
}

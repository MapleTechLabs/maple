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

    // One LogEntry per request, unwrapped. noWrapper is sent as given though alchemy's type omits it,
    // and only on create: an adopted subscription keeps its own setting (Maple's setups all unwrap).
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

const readerSection = (plan: GcpSetupPlan, reader: NonNullable<GcpSetupPlan["reader"]>) => `
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
${
	plan.scopeType === "project"
		? `    // The narrowest predefined roles for Maple's reads, and the quota they count against.
    for (const role of [${[...GCP_READER_SCOPE_ROLES, GCP_READER_PROJECT_ROLE].map(ts).join(", ")}]) {
      yield* GCP.IAM.Member(\`maple-reader-\${role.split("/")[1]}\`, {
        kind: "project",
        name: PROJECT_ID,
        role,
        member: Output.interpolate\`serviceAccount:\${reader.email}\`,
      })
    }
`
		: `    // The narrowest predefined roles for Maple's reads, on the ${plan.scopeType}: ScopeIamMember
    // (below the stack) grants them, since GCP.IAM.Member reaches projects only.
    for (const role of [${GCP_READER_SCOPE_ROLES.map(ts).join(", ")}]) {
      yield* ScopeIamMember(\`maple-reader-\${role.split("/")[1]}\`, {
        resource: SCOPE,
        role,
        member: Output.interpolate\`serviceAccount:\${reader.email}\`,
      })
    }
    // The quota Maple's reads count against, on the host project.
    yield* GCP.IAM.Member(${ts(`maple-reader-${GCP_READER_PROJECT_ROLE.split("/")[1]}`)}, {
      kind: "project",
      name: PROJECT_ID,
      role: ${ts(GCP_READER_PROJECT_ROLE)},
      member: Output.interpolate\`serviceAccount:\${reader.email}\`,
    })
`
}`

// alchemy's GCP.IAM.Member grants on projects and single resources, not on a folder or an
// organization. This resource edits their IAM policy through the Resource Manager API, signed in
// like the rest of the stack. Tested against a project's policy, which takes the same calls.
const SCOPE_IAM_MEMBER = `// ---- ScopeIamMember: one role → member grant on a folder's or organization's IAM policy ----
// Only this grant is managed: other members and roles are left alone. A concurrent edit retries.
type ScopeIamMemberProps = { resource: string; role: string; member: string }
type ScopeIamMember = Alchemy.Resource<"Maple.ScopeIamMember", ScopeIamMemberProps, ScopeIamMemberProps>
const ScopeIamMember = Alchemy.Resource<ScopeIamMember>("Maple.ScopeIamMember")

class IamPolicyError extends Data.TaggedError("Maple.IamPolicyError")<{ message: string; status: number }> {}
type Policy = { etag?: string; version?: number; bindings?: Array<{ role: string; members?: Array<string>; condition?: unknown }> }

const iamCall = (resource: string, verb: "getIamPolicy" | "setIamPolicy", body: unknown) =>
  Effect.gen(function* () {
    const env = yield* yield* GCP.GcpEnvironment
    const response = yield* Effect.promise(() =>
      fetch(\`https://cloudresourcemanager.googleapis.com/v3/\${resource}:\${verb}\`, {
        method: "POST",
        headers: { authorization: \`Bearer \${Redacted.value(env.accessToken)}\`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
    const json = yield* Effect.promise(() => response.json() as Promise<Policy & { error?: { message: string } }>)
    if (!response.ok) {
      return yield* new IamPolicyError({ message: json.error?.message ?? response.statusText, status: response.status })
    }
    return json
  })

const getPolicy = (resource: string) => iamCall(resource, "getIamPolicy", { options: { requestedPolicyVersion: 3 } })

const hasGrant = (policy: Policy, props: ScopeIamMemberProps) =>
  (policy.bindings ?? []).some(
    (b) => b.role === props.role && b.condition === undefined && (b.members ?? []).includes(props.member),
  )

const editGrant = (props: ScopeIamMemberProps, grant: boolean) =>
  Effect.gen(function* () {
    const policy = yield* getPolicy(props.resource)
    if (hasGrant(policy, props) === grant) return
    const bindings = (policy.bindings ?? [])
      .map((b) =>
        b.role === props.role && b.condition === undefined
          ? { ...b, members: (b.members ?? []).filter((m) => m !== props.member) }
          : b,
      )
      .filter((b) => (b.members ?? []).length > 0)
    if (grant) {
      const existing = bindings.find((b) => b.role === props.role && b.condition === undefined)
      if (existing) existing.members = [...(existing.members ?? []), props.member]
      else bindings.push({ role: props.role, members: [props.member] })
    }
    yield* iamCall(props.resource, "setIamPolicy", { policy: { ...policy, version: 3, bindings }, updateMask: "bindings,etag" })
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Maple.IamPolicyError" && (e.status === 409 || e.status === 412),
      schedule: Schedule.exponential("500 millis"),
      times: 5,
    }),
  )

const ScopeIamMemberProvider = Provider.succeed(ScopeIamMember, {
  stables: ["resource", "role", "member"],
  diff: Effect.fn(function* ({ news, olds }) {
    if (!Alchemy.isResolved(news) || olds === undefined) return undefined
    const changed = news.resource !== olds.resource || news.role !== olds.role || news.member !== olds.member
    return changed ? { action: "replace" as const, deleteFirst: false } : undefined
  }),
  read: Effect.fn(function* ({ olds, output }) {
    const props = output ?? olds
    if (props === undefined) return undefined
    return hasGrant(yield* getPolicy(props.resource), props) ? { ...props } : undefined
  }),
  reconcile: Effect.fn(function* ({ news }) {
    yield* editGrant(news, true)
    return { ...news }
  }),
  delete: Effect.fn(function* ({ output }) {
    yield* editGrant(output, false)
  }),
})
`

/** A self-contained Alchemy stack for the connection. */
export const renderGcpAlchemy = (plan: GcpSetupPlan, existing: GcpExisting): string => {
	const { logs, reader } = plan
	// A folder's or organization's read roles need ScopeIamMember: alchemy has no resource for them.
	const scopeIam = reader !== null && plan.scopeType !== "project"
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
		...(scopeIam ? [`const SCOPE = ${ts(`${plan.scopeType === "folder" ? "folders" : "organizations"}/${plan.scopeId}`)}`] : []),
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
// Then deploy as an account allowed to create these resources${scopeIam ? ` and to set the ${plan.scopeType}'s IAM policy` : ""}, in the project it signs in to,
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
import * as Output from "alchemy/Output"${scopeIam ? `\nimport * as Provider from "alchemy/Provider"\nimport * as Data from "effect/Data"` : ""}
import * as Effect from "effect/Effect"${scopeIam ? `\nimport * as Layer from "effect/Layer"\nimport * as Redacted from "effect/Redacted"\nimport * as Schedule from "effect/Schedule"` : ""}

// The host project holds Maple's Pub/Sub topic, subscription and service accounts.
const PROJECT_ID = ${ts(plan.projectId)}
${constants.join("\n")}
${logs === null ? "" : `if (!/^\\d+$/.test(PROJECT_NUMBER)) throw new Error("Set PROJECT_NUMBER at the top of maple.ts.")\n`}
${scopeIam ? `${SCOPE_IAM_MEMBER}\n` : ""}export default Alchemy.Stack(
  ${ts(stackName)},
  ${
		scopeIam
			? `{
    // GCP's resources, and ScopeIamMember signed in the same way.
    providers: Layer.mergeAll(
      GCP.providers(),
      ScopeIamMemberProvider.pipe(Layer.provide(GCP.fromCredentials().pipe(Layer.provide(GCP.fromAuthProvider())))),
    ),
    state: Alchemy.localState(),
  }`
			: "{ providers: GCP.providers(), state: Alchemy.localState() }"
	},
  Effect.gen(function* () {${logs === null ? "" : logsSection(plan, logs)}${reader === null ? "" : readerSection(plan, reader)}  }),
)
`
}

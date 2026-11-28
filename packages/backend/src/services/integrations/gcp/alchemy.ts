import {
	GCP_PUSH_SUBSCRIPTION,
	GCP_READER_PROJECT_ROLE,
	GCP_READER_SCOPE_ROLES,
	type GcpSetupPlan,
	gcpScopeParent,
} from "@maple/domain/gcp"
import { Schema, Array as Arr, String as Str } from "effect"
import type { GcpExisting } from "./terraform"

// The alchemy the stack is written for: version 2 is in beta, and resource props still change.
const ALCHEMY_VERSION = "2.0.0-beta.83"

/** A TypeScript string literal. */
const ts: (value: string) => string = Schema.encodeSync(Schema.fromJsonString(Schema.String))

// Alchemy creates a project sink, the topics and the subscriptions in the project it signs in to.
const SINKS = { project: "Sink", folder: "FolderSink", organization: "OrganizationSink" } as const

const logsSection = (plan: GcpSetupPlan, logs: NonNullable<GcpSetupPlan["logs"]>) => {
	const parent =
		plan.scopeType === "project"
			? ""
			: `\n      ${plan.scopeType === "folder" ? "folderId" : "organization"}: ${ts(plan.scopeId)},`
	return `
    // ---- Log forwarding ----
    const topic = yield* GCP.PubSub.Topic("maple-topic", { topicId: ${ts(logs.topic)} })

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

// One push identity signs both subscriptions: declared once when either is on.
const pushSection = (plan: GcpSetupPlan, pushServiceAccountId: string) => `
    // ---- Push identity ----
    // What Pub/Sub signs its pushes to Maple as. It holds no role anywhere.
    const pushAccount = yield* GCP.IAM.ServiceAccount("maple-push", {
      project: PROJECT_ID,
      accountId: ${ts(pushServiceAccountId)},
      displayName: ${plan.logs === null ? '"Maple push identity"' : '"Maple log push identity"'},
      description: "Signs Pub/Sub push requests to Maple. Holds no roles.",
    })
    // Pub/Sub's service agent mints the push tokens: needed in projects created before April 2021.
    yield* GCP.IAM.Member("maple-push-token-creator", {
      kind: "iam.serviceAccount",
      name: pushAccount.name,
      role: "roles/iam.serviceAccountTokenCreator",
      member: \`serviceAccount:service-\${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com\`,
    })
`

const securitySection = (plan: GcpSetupPlan, security: NonNullable<GcpSetupPlan["security"]>) => `
    // ---- Security findings ----
    const securityTopic = yield* GCP.PubSub.Topic("maple-security-topic", { topicId: ${ts(security.topic)} })

    // One finding per request, unwrapped, signed as the push identity for Maple's address.
    const securityPushConfig = {
      pushEndpoint: SECURITY_PUSH_ENDPOINT,
      noWrapper: { writeMetadata: false },
      oidcToken: { serviceAccountEmail: pushAccount.email, audience: SECURITY_PUSH_ENDPOINT },
    }
    yield* GCP.PubSub.Subscription("maple-security-subscription", {
      subscriptionId: ${ts(security.subscription)},
      topic: securityTopic.name,
      ackDeadlineSeconds: ${GCP_PUSH_SUBSCRIPTION.ackDeadlineSeconds},
      messageRetentionDuration: "${GCP_PUSH_SUBSCRIPTION.messageRetentionSeconds}s",
      expirationPolicy: {},
      retryPolicy: {
        minimumBackoff: "${GCP_PUSH_SUBSCRIPTION.minRetryDelaySeconds}s",
        maximumBackoff: "${GCP_PUSH_SUBSCRIPTION.maxRetryDelaySeconds}s",
      },
      pushConfig: securityPushConfig,
    })

    // Security Command Center sends each finding written or changed on the ${plan.scopeType} to the
    // topic, and grants its own service agent the right to publish there. SccNotification (below
    // the stack) is the v2 API's config: alchemy's SecurityCenter resources call v1.
    yield* SccNotification("maple-security-notification", {
      parent: SCOPE,
      configId: ${ts(security.notificationConfig)},
      pubsubTopic: securityTopic.name,
      filter: SECURITY_FILTER,
      description: "Sends Security Command Center findings to Maple.",
    })
`

// The account reads metrics, findings, or both: named for what it does, as the setup script does.
const readsMetrics = (reader: NonNullable<GcpSetupPlan["reader"]>) =>
	Arr.some(GCP_READER_SCOPE_ROLES, (role) => Arr.contains(reader.scopeRoles, role))

const readerSection = (plan: GcpSetupPlan, reader: NonNullable<GcpSetupPlan["reader"]>) => `
    // ---- Read-only access: metrics and resources, security findings ----
    // A read-only account Maple reads as through short-lived tokens. No key is created.
    const reader = yield* GCP.IAM.ServiceAccount("maple-reader", {
      project: PROJECT_ID,
      accountId: ${ts(reader.serviceAccountId)},
      displayName: ${readsMetrics(reader) ? '"Maple metrics and resource reader"' : '"Maple security findings reader"'},
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
    for (const role of [${Arr.join(Arr.map([...reader.scopeRoles, GCP_READER_PROJECT_ROLE], ts), ", ")}]) {
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
    for (const role of [${Arr.join(Arr.map(reader.scopeRoles, ts), ", ")}]) {
      yield* ScopeIamMember(\`maple-reader-\${role.split("/")[1]}\`, {
        resource: SCOPE,
        role,
        member: Output.interpolate\`serviceAccount:\${reader.email}\`,
      })
    }
    // The quota Maple's reads count against, on the host project.
    yield* GCP.IAM.Member(${ts(`maple-reader-${Str.split("/")(GCP_READER_PROJECT_ROLE)[1]}`)}, {
      kind: "project",
      name: PROJECT_ID,
      role: ${ts(GCP_READER_PROJECT_ROLE)},
      member: Output.interpolate\`serviceAccount:\${reader.email}\`,
    })
`
}`

// A Google API call signed in like the rest of the stack, for the resources below it.
const GOOGLE_CALL = `// ---- googleCall: one Google API request as the signed-in account ----
class GoogleApiError extends Data.TaggedError("Maple.GoogleApiError")<{ message: string; status: number }> {}

const googleCall = <A>(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown) =>
  Effect.gen(function* () {
    const env = yield* yield* GCP.GcpEnvironment
    const response = yield* Effect.promise(() =>
      fetch(url, {
        method,
        headers: { authorization: \`Bearer \${Redacted.value(env.accessToken)}\`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )
    const json = yield* Effect.promise(() => response.json() as Promise<A & { error?: { message: string } }>)
    if (!response.ok) {
      return yield* new GoogleApiError({ message: json.error?.message ?? response.statusText, status: response.status })
    }
    return json
  })
`

// alchemy's GCP.IAM.Member grants on projects and single resources, not on a folder or an
// organization. This resource edits their IAM policy through the Resource Manager API, signed in
// like the rest of the stack. Tested against a project's policy, which takes the same calls.
const SCOPE_IAM_MEMBER = `// ---- ScopeIamMember: one role → member grant on a folder's or organization's IAM policy ----
// Only this grant is managed: other members and roles are left alone. A concurrent edit retries.
type ScopeIamMemberProps = { resource: string; role: string; member: string }
type ScopeIamMember = Alchemy.Resource<"Maple.ScopeIamMember", ScopeIamMemberProps, ScopeIamMemberProps>
const ScopeIamMember = Alchemy.Resource<ScopeIamMember>("Maple.ScopeIamMember")

type Policy = { etag?: string; version?: number; bindings?: Array<{ role: string; members?: Array<string>; condition?: unknown }> }

const iamCall = (resource: string, verb: "getIamPolicy" | "setIamPolicy", body: unknown) =>
  googleCall<Policy>("POST", \`https://cloudresourcemanager.googleapis.com/v3/\${resource}:\${verb}\`, body)

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
      while: (e) => e._tag === "Maple.GoogleApiError" && (e.status === 409 || e.status === 412),
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

// alchemy's SecurityCenter notification resources call the v1 API, whose findings name no
// location, and whose configs the v2 API (the setup script's, Terraform's) does not see.
const SCC_NOTIFICATION = `// ---- SccNotification: a Security Command Center v2 notification config, location global ----
type SccNotificationProps = { parent: string; configId: string; pubsubTopic: string; filter: string; description: string }
type SccNotificationAttrs = SccNotificationProps & { name: string; serviceAccount: string | undefined }
type SccNotification = Alchemy.Resource<"Maple.SccNotification", SccNotificationProps, SccNotificationAttrs>
const SccNotification = Alchemy.Resource<SccNotification>("Maple.SccNotification")

type NotificationConfig = { name?: string; serviceAccount?: string }
const SCC_API = "https://securitycenter.googleapis.com/v2"
const configName = (props: SccNotificationProps) => \`\${props.parent}/locations/global/notificationConfigs/\${props.configId}\`
const missing = (e: GoogleApiError) => (e.status === 404 ? Effect.succeed(undefined) : Effect.fail(e))
const getConfig = (props: SccNotificationProps) =>
  googleCall<NotificationConfig>("GET", \`\${SCC_API}/\${configName(props)}\`).pipe(Effect.catchTag("Maple.GoogleApiError", missing))
const attrsOf = (props: SccNotificationProps, config: NotificationConfig): SccNotificationAttrs => ({
  ...props,
  name: config.name ?? configName(props),
  serviceAccount: config.serviceAccount,
})

const SccNotificationProvider = Provider.succeed(SccNotification, {
  stables: ["parent", "configId", "name"],
  diff: Effect.fn(function* ({ news, olds }) {
    if (!Alchemy.isResolved(news) || olds === undefined) return undefined
    const moved = news.parent !== olds.parent || news.configId !== olds.configId
    return moved ? { action: "replace" as const, deleteFirst: false } : undefined
  }),
  read: Effect.fn(function* ({ olds, output }) {
    const props = output ?? olds
    if (props === undefined) return undefined
    const config = yield* getConfig(props)
    return config === undefined ? undefined : attrsOf(props, config)
  }),
  // Creating or pointing a config at a topic grants SCC's service agent publish rights on it.
  reconcile: Effect.fn(function* ({ news }) {
    const body = { pubsubTopic: news.pubsubTopic, description: news.description, streamingConfig: { filter: news.filter } }
    const config =
      (yield* getConfig(news)) === undefined
        ? yield* googleCall<NotificationConfig>(
            "POST",
            \`\${SCC_API}/\${news.parent}/locations/global/notificationConfigs?configId=\${encodeURIComponent(news.configId)}\`,
            body,
          )
        : yield* googleCall<NotificationConfig>(
            "PATCH",
            \`\${SCC_API}/\${configName(news)}?updateMask=description,pubsubTopic,streamingConfig.filter\`,
            body,
          )
    return attrsOf(news, config)
  }),
  delete: Effect.fn(function* ({ output }) {
    yield* googleCall("DELETE", \`\${SCC_API}/\${configName(output)}\`).pipe(Effect.catchTag("Maple.GoogleApiError", missing))
  }),
})
`

/** A self-contained Alchemy stack for the connection. */
export const renderGcpAlchemy = (plan: GcpSetupPlan, existing: GcpExisting): string => {
	const { logs, reader, security } = plan
	// A folder's or organization's read roles need ScopeIamMember: alchemy has no resource for them.
	const scopeIam = reader !== null && plan.scopeType !== "project"
	// Resources the stack brings itself, signed in like alchemy's own.
	const custom = [
		...(scopeIam ? ["ScopeIamMemberProvider"] : []),
		...(security === null ? [] : ["SccNotificationProvider"]),
	]
	const pushServiceAccountId = logs?.pushServiceAccountId ?? security?.pushServiceAccountId
	const takeOver = existing.logs || existing.reader
	// Alchemy keys its state by stack name: one per connection, or a second replaces the first.
	const stackName = logs?.topic ?? reader?.serviceAccountId ?? "maple-gcp"
	const constants = [
		...(pushServiceAccountId === undefined
			? []
			: [
					`// Its number: gcloud projects describe ${plan.projectId} --format='value(projectNumber)'`,
					`const PROJECT_NUMBER = ""`,
				]),
		...(logs === null
			? []
			: [`const PUSH_ENDPOINT = ${ts(logs.pushEndpoint)}`, `const LOG_FILTER = ${ts(logs.logFilter)}`]),
		...(reader === null ? [] : [`const MAPLE_SERVICE_ACCOUNT = ${ts(reader.mapleServiceAccountEmail)}`]),
		...(scopeIam || security !== null
			? [`const SCOPE = ${ts(gcpScopeParent(plan.scopeType, plan.scopeId))}`]
			: []),
		...(security === null
			? []
			: [
					`const SECURITY_PUSH_ENDPOINT = ${ts(security.pushEndpoint)}`,
					`const SECURITY_FILTER = ${ts(security.filter)}`,
				]),
	]
	return `// Maple connection for Google Cloud ${plan.scopeType} ${plan.scopeId}
//   Log forwarding:        ${logs === null ? "off" : "on"}
//   Metrics and resources: ${reader !== null && readsMetrics(reader) ? "on" : "off"}
//   Security findings:     ${security === null ? "off" : "on"}
// This file carries no secret${pushServiceAccountId === undefined ? "." : `: Pub/Sub signs each push as ${pushServiceAccountId},\n// and Maple checks the signature.`}
// Details: https://maple.dev/docs/integrations/gcp-infrastructure-as-code
//
// Written for alchemy ${ALCHEMY_VERSION}: bun add alchemy@${ALCHEMY_VERSION} effect@^4 @effect/platform-bun@^4
// Alchemy does not wait for an API to be switched on, so switch them on first:
//   gcloud services enable ${Arr.join(plan.apis, " ")} --project=${plan.projectId}
// Then deploy as an account allowed to create these resources${scopeIam ? ` and to set the ${plan.scopeType}'s IAM policy` : ""}${security === null ? "" : ` and Security Command Center notifications on the ${plan.scopeType}`}, in the project it signs in to,
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
import * as Output from "alchemy/Output"${custom.length > 0 ? `\nimport * as Provider from "alchemy/Provider"\nimport * as Data from "effect/Data"` : ""}
import * as Effect from "effect/Effect"${custom.length > 0 ? `\nimport * as Layer from "effect/Layer"\nimport * as Redacted from "effect/Redacted"` : ""}${scopeIam ? `\nimport * as Schedule from "effect/Schedule"` : ""}

// The host project holds Maple's Pub/Sub topic, subscription and service accounts.
const PROJECT_ID = ${ts(plan.projectId)}
${Arr.join(constants, "\n")}
${pushServiceAccountId === undefined ? "" : `if (!/^\\d+$/.test(PROJECT_NUMBER)) throw new Error("Set PROJECT_NUMBER at the top of maple.ts.")\n`}
${custom.length > 0 ? `${GOOGLE_CALL}\n` : ""}${scopeIam ? `${SCOPE_IAM_MEMBER}\n` : ""}${security === null ? "" : `${SCC_NOTIFICATION}\n`}export default Alchemy.Stack(
  ${ts(stackName)},
  ${
		custom.length > 0
			? `{
    // GCP's resources, and the stack's own signed in the same way.
    providers: Layer.mergeAll(
      GCP.providers(),
${Arr.join(
	Arr.map(
		custom,
		(provider) =>
			`      ${provider}.pipe(Layer.provide(GCP.fromCredentials().pipe(Layer.provide(GCP.fromAuthProvider())))),\n`,
	),
	"",
)}    ),
    state: Alchemy.localState(),
  }`
			: "{ providers: GCP.providers(), state: Alchemy.localState() }"
  },
  Effect.gen(function* () {${pushServiceAccountId === undefined ? "" : pushSection(plan, pushServiceAccountId)}${logs === null ? "" : logsSection(plan, logs)}${security === null ? "" : securitySection(plan, security)}${reader === null ? "" : readerSection(plan, reader)}  }),
)
`
}

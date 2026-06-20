# Schedule Cookbook

Use this cookbook by problem shape: retry failed work, poll successful status values, repeat background work, or observe a schedule.

## Before Choosing A Recipe

- `Effect.retry` observes typed failures and stops on the first success.
- `Effect.repeat` observes successful values and stops on the first failure.
- Recurrence counts are follow-up runs after the first execution, so `Schedule.recurs(3)` allows three more attempts or repeats.
- Schedule output is policy output. Use `Schedule.passthrough` when a repeated program should return the latest successful value.
- Backoff, jitter, and spacing control timing. They do not classify errors, make writes idempotent, or add a stop condition by themselves.
- Bound request-path recurrence with a count, elapsed budget, or both. Leave unbounded schedules to explicitly owned background fibers.

| Problem                            | Start with                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| Retry a flaky operation            | `Effect.retry` plus `Schedule.exponential`, usually with `Schedule.recurs` and `Schedule.jittered` |
| Poll until a status is terminal    | `Effect.repeat` plus `Schedule.spaced`, `Schedule.passthrough`, and `Schedule.while`               |
| Run periodic background work       | `Effect.repeat` plus `Schedule.spaced`, `Schedule.fixed`, `Schedule.windowed`, or `Schedule.cron`  |
| Avoid overload across many callers | Add jitter, backoff, count limits, elapsed limits, and idempotency where side effects are retried  |

## Core Building Blocks

### Exponential Backoff

Create an Effect Schedule value named `retryBackoff` that uses exponential backoff starting at 100 milliseconds.

```ts
import { Schedule } from "effect"

const retryBackoff = Schedule.exponential("100 millis")
```

### Limit Recurrences

Create an Effect Schedule value named `threeRetries` that allows at most 3 recurrences.

```ts
import { Schedule } from "effect"

const threeRetries = Schedule.recurs(3)
```

Caution: `recurs(n)` counts follow-up recurrences after the first execution.

### Space Repetitions

Create an Effect Schedule value named `pollEverySecond` that recurs about once per second after each completed run.

```ts
import { Schedule } from "effect"

const pollEverySecond = Schedule.spaced("1 second")
```

### Use Fixed Cadence

Create an Effect Schedule value named `heartbeatCadence` that runs on an aligned 30 second cadence instead of waiting 30 seconds after each run finishes.

```ts
import { Schedule } from "effect"

const heartbeatCadence = Schedule.fixed("30 seconds")
```

### Run One Follow-Up

Create an Effect Schedule value named `oneFollowUpRun` that performs exactly one additional recurrence after about 10 seconds.

```ts
import { Schedule } from "effect"

const oneFollowUpRun = Schedule.duration("10 seconds")
```

### Stop After Elapsed Time

Create an Effect Schedule value named `thirtySecondBudget` that can be used to stop repetitions or retries after about 30 seconds have elapsed.

```ts
import { Schedule } from "effect"

const thirtySecondBudget = Schedule.during("30 seconds")
```

### Add Jitter

Create an Effect Schedule value named `jitteredBackoff` that starts with 100 ms exponential backoff and adds a little randomness to each delay.

```ts
import { Schedule } from "effect"

const jitteredBackoff = Schedule.exponential("100 millis").pipe(
  Schedule.jittered
)
```

Explanation: jitter randomly changes each computed delay a little. This helps when many callers fail at the same time, because they will not all retry again at the exact same moment.

Caution: jitter spreads delay across callers; it does not add a retry limit.

### Combine Backoff With Count And Time Limits

Create an Effect Schedule value named `boundedBackoff` that uses exponential backoff starting at 100 ms, allows at most 5 recurrences, and also stops after about 10 seconds have elapsed.

```ts
import { Schedule } from "effect"

const boundedBackoff = Schedule.exponential("100 millis").pipe(
  Schedule.both(Schedule.recurs(5)),
  Schedule.both(Schedule.during("10 seconds"))
)
```

Explanation: `Schedule.both` runs both schedules against the same input. The combined schedule continues only while both schedules continue. Its output is a pair, which matters when another operator reads the schedule output.

Caution: `recurs(n)` counts follow-up recurrences after the first execution.

### Keep The Left Schedule Output

Create an Effect Schedule value named `limitedBackoff` that combines exponential backoff starting at 100 ms with a maximum of 5 recurrences, while keeping the backoff delay as the schedule output.

```ts
import { Schedule } from "effect"

const limitedBackoff = Schedule.exponential("100 millis").pipe(
  Schedule.bothLeft(Schedule.recurs(5))
)
```

Caution: `recurs(n)` counts follow-up recurrences after the first execution.

### Keep The Right Schedule Output

Create an Effect Schedule value named `retryAttemptCount` that combines exponential backoff starting at 100 ms with a maximum of 5 recurrences, while keeping the recurrence count as the schedule output.

```ts
import { Schedule } from "effect"

const retryAttemptCount = Schedule.exponential("100 millis").pipe(
  Schedule.bothRight(Schedule.recurs(5))
)
```

Caution: `recurs(n)` counts follow-up recurrences after the first execution.

### Return The Latest Input

Create an Effect Schedule value named `keepLatestStatus` that checks about once per second and outputs the latest successful `Status` value instead of the schedule's internal counter.

```ts
import { Schedule } from "effect"

type Status = "Pending" | "Done"

const keepLatestStatus = Schedule.spaced("1 second").pipe(
  Schedule.setInputType<Status>(),
  Schedule.passthrough
)
```

Explanation: `Schedule.setInputType` tells TypeScript what kind of input the schedule receives. `Schedule.passthrough` changes the schedule output to the latest input, so `Effect.repeat` can return the latest successful value instead of the schedule's counter or delay.

### Continue While Input Matches

Create an Effect Schedule value named `pollWhilePending` that checks about once per second, keeps returning the latest successful `Status`, and stops when the latest status is no longer `Pending`.

```ts
import { Schedule } from "effect"

type Status = "Pending" | "Done"

const pollWhilePending = Schedule.spaced("1 second").pipe(
  Schedule.setInputType<Status>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input === "Pending")
)
```

### Run One Policy Then Another

Create an Effect Schedule value named `warmThenSteady` that recurs 3 times 100 ms apart, then switches to recurring every 5 seconds.

```ts
import { Schedule } from "effect"

const warmThenSteady = Schedule.spaced("100 millis").pipe(
  Schedule.bothLeft(Schedule.recurs(3)),
  Schedule.andThen(Schedule.spaced("5 seconds"))
)
```

Caution: `recurs(n)` counts follow-up recurrences after the first execution.

### Retry With A Schedule

Write the Effect code that retries `request` with exponential backoff starting at 100 ms and at most 3 retries.

```ts
import { Effect, Schedule } from "effect"

type RequestError = unknown

declare const request: Effect.Effect<Response, RequestError>

const retryPolicy = Schedule.exponential("100 millis").pipe(
  Schedule.both(Schedule.recurs(3))
)

const program = request.pipe(Effect.retry(retryPolicy))
```

Caution: `recurs(n)` counts follow-up recurrences after the first execution.

### Repeat With A Schedule

Write the Effect code that repeats `refresh` after each successful run, waiting about 1 minute between runs.

```ts
import { Effect, Schedule } from "effect"

type RefreshError = unknown

declare const refresh: Effect.Effect<void, RefreshError>

const refreshCadence = Schedule.spaced("1 minute")

const program = refresh.pipe(Effect.repeat(refreshCadence))
```

Caution: `Effect.repeat` observes successful values and stops on the first failure.

### Retry Only Selected Failures

Write the Effect code that retries `callService` at most 3 times, but only when the failure is `Transient`.

```ts
import { Effect, Schedule } from "effect"

type ServiceResponse = unknown

type ServiceError =
  | { readonly _tag: "Transient" }
  | { readonly _tag: "Permanent" }

declare const callService: Effect.Effect<ServiceResponse, ServiceError>

const program = callService.pipe(
  Effect.retry({
    schedule: Schedule.recurs(3),
    while: (error) => error._tag === "Transient"
  })
)
```

Caution: `recurs(n)` counts follow-up recurrences after the first execution.

### Repeat Until A Successful Value Matches

Write the Effect code that repeats `readStatus` about once per second until the successful status is `Complete`.

```ts
import { Effect, Schedule } from "effect"

type StatusError = unknown

type Status = "Pending" | "Complete"

declare const readStatus: Effect.Effect<Status, StatusError>

const program = readStatus.pipe(
  Effect.repeat({
    schedule: Schedule.spaced("1 second"),
    until: (status) => status === "Complete"
  })
)
```

Caution: `Effect.repeat` observes successful values and stops on the first failure.

### Observe Schedule Input

Create an Effect Schedule value named `loggingRetryPolicy` that uses exponential backoff starting at 100 ms and logs each retry input error tag before the delay is selected.

```ts
import { Console, Schedule } from "effect"

type RequestError = { readonly _tag: string }

const loggingRetryPolicy = Schedule.exponential("100 millis").pipe(
  Schedule.tapInput((error: RequestError) => Console.log(error._tag))
)
```

### Observe Schedule Output

Create an Effect Schedule value named `measuredBackoff` that uses exponential backoff starting at 100 ms and records each selected retry delay.

```ts
import { Duration, Effect, Schedule } from "effect"

declare const Metrics: {
  readonly recordRetryDelay: (delay: Duration.Duration) => Effect.Effect<void>
}

const measuredBackoff = Schedule.exponential("100 millis").pipe(
  Schedule.tapOutput((delay) => Metrics.recordRetryDelay(delay))
)
```

### Run On Time Windows

Create an Effect Schedule value named `minuteWindow` that recurs on one-minute window boundaries.

```ts
import { Schedule } from "effect"

const minuteWindow = Schedule.windowed("1 minute")
```

### Run From A Cron Expression

Create an Effect Schedule value named `nightlyAtTwo` that recurs every night at 02:00 using a cron expression.

```ts
import { Schedule } from "effect"

const nightlyAtTwo = Schedule.cron("0 2 * * *")
```

## Retry And Recovery

### Retry HTTP GET Timeouts

Write the Effect code that retries `getUser("user-123")` only when it fails with `HttpTimeout`.

```ts
import { Effect, Schedule } from "effect"

type User = unknown

type HttpTimeout = { readonly _tag: "HttpTimeout" }
type HttpStatusError = { readonly _tag: "HttpStatusError"; readonly status: number }
type DecodeError = { readonly _tag: "DecodeError" }

declare const getUser: (
  id: string
) => Effect.Effect<User, HttpTimeout | HttpStatusError | DecodeError>

const isHttpTimeout = (
  error: HttpTimeout | HttpStatusError | DecodeError
): error is HttpTimeout => error._tag === "HttpTimeout"

const retryGetUserTimeouts = Schedule.exponential("100 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(3)),
  Schedule.both(Schedule.during("2 seconds"))
)

const program = getUser("user-123").pipe(
  Effect.retry({
    schedule: retryGetUserTimeouts,
    while: isHttpTimeout
  })
)
```

Caution: jitter spreads delay across callers; it does not add a retry limit.

### Retry An Idempotent Order Submission

Write the Effect code that retries a temporarily failed order submission.

```ts
import { Effect, Schedule } from "effect"

type Order = unknown

type PostOrderError =
  | { readonly _tag: "Timeout" }
  | { readonly _tag: "ConnectionReset" }
  | { readonly _tag: "BadGateway" }
  | { readonly _tag: "ServiceUnavailable" }
  | { readonly _tag: "RateLimited" }
  | { readonly _tag: "InvalidRequest" }
  | { readonly _tag: "Unauthorized" }

declare const postOrder: (
  request: {
    readonly customerId: string
    readonly sku: string
    readonly quantity: number
    readonly idempotencyKey: string
  }
) => Effect.Effect<Order, PostOrderError>

const idempotencyKey = "order-key-123"

const isRetryablePostOrderError = (error: PostOrderError): boolean => {
  switch (error._tag) {
    case "Timeout":
    case "ConnectionReset":
    case "BadGateway":
    case "ServiceUnavailable":
    case "RateLimited":
      return true
    case "InvalidRequest":
    case "Unauthorized":
      return false
  }
}

const retryOrderSubmission = Schedule.exponential("100 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(4)),
  Schedule.both(Schedule.during("3 seconds"))
)

const program = postOrder({
  customerId: "customer-1",
  sku: "sku-1",
  quantity: 2,
  idempotencyKey
}).pipe(
  Effect.retry({
    schedule: retryOrderSubmission,
    while: isRetryablePostOrderError
  })
)
```

Caution: the schedule only times retries; the stable idempotency key is what makes duplicate attempts safe.

### Retry HTTP GET 503 Responses

Write the Effect code that retries `getCatalog("https://api.example.test/catalog")` only when the error value is an HTTP `GET` response with status `503`.

```ts
import { Effect, Schedule } from "effect"

type TransportError = { readonly _tag: "TransportError" }
type HttpResponseError = {
  readonly _tag: "HttpResponseError"
  readonly method: "GET" | "POST"
  readonly status: number
}
type GetCatalogError = TransportError | HttpResponseError

declare const getCatalog: (
  url: string
) => Effect.Effect<string, GetCatalogError>

const isServiceUnavailableGet = (error: GetCatalogError): boolean =>
  error._tag === "HttpResponseError" &&
  error.method === "GET" &&
  error.status === 503

const retry503WithBackoff = Schedule.exponential("100 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(4)),
  Schedule.both(Schedule.during("3 seconds"))
)

const program = getCatalog("https://api.example.test/catalog").pipe(
  Effect.retry({
    schedule: retry503WithBackoff,
    while: isServiceUnavailableGet
  })
)
```

Caution: jitter spreads delay across callers; it does not add a retry limit.

### Respect Retry-After On Rate Limits

Write the Effect code that retries `callApi` only for `RateLimited` errors.

```ts
import { Duration, Effect, Schedule } from "effect"

type HttpError =
  | { readonly _tag: "RateLimited"; readonly retryAfter: Duration.Duration | undefined }
  | { readonly _tag: "Unauthorized" | "Forbidden" | "BadRequest" | "Unavailable" }

declare const callApi: Effect.Effect<string, HttpError>

const rateLimitPolicy = Schedule.exponential("100 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.identity<HttpError>()),
  Schedule.modifyDelay(([_, error], delay) =>
    Effect.succeed(
      error._tag === "RateLimited" && error.retryAfter !== undefined
        ? Duration.max(delay, error.retryAfter)
        : delay
    )
  ),
  Schedule.both(Schedule.recurs(5)),
  Schedule.while(({ input }) => input._tag === "RateLimited")
)

const program = Effect.retry(callApi, rateLimitPolicy)
```

Explanation: `Schedule.identity<HttpError>()` keeps the retry error available as schedule output. `Schedule.modifyDelay` can then compare the normal backoff delay with `retryAfter` and choose the longer delay.

Caution: classify permanent failures before applying retry; backoff does not make invalid input transient.

### Retry Startup Config Fetches

Write the Effect code that retries startup config loading only for temporary network/service failures. Use exponential backoff starting at about 100 ms. Try at most 3 more times.

```ts
import { Effect, Schedule } from "effect"

type ClientConfig = unknown

type ConfigFetchError =
  | { readonly _tag: "NetworkUnavailable" }
  | { readonly _tag: "ServiceUnavailable" }
  | { readonly _tag: "MalformedConfig" }

declare const fetchStartupConfig: Effect.Effect<ClientConfig, ConfigFetchError>

const isTransientConfigFailure = (error: ConfigFetchError): boolean =>
  error._tag === "NetworkUnavailable" || error._tag === "ServiceUnavailable"

const startupConfigRetryPolicy = Schedule.exponential("100 millis").pipe(
  Schedule.both(Schedule.recurs(3))
)

const program = fetchStartupConfig.pipe(
  Effect.retry({
    schedule: startupConfigRetryPolicy,
    while: isTransientConfigFailure
  })
)
```

Caution: `recurs(n)` counts follow-up recurrences after the first execution.

### Retry Transient Profile Loads

Write the Effect code that retries `fetchProfile("user-123")` only for temporary profile-load failures. Use exponential backoff starting at about 100 ms, add a little randomness so callers do not retry together, and try at most 3 more times.

```ts
import { Effect, Schedule } from "effect"

type Profile = unknown
type ProfileLoadError = unknown

declare const fetchProfile: (
  userId: string
) => Effect.Effect<Profile, ProfileLoadError>

declare const isTransientProfileLoadError: (
  error: ProfileLoadError
) => boolean

const retryTransientProfileLoad = Schedule.exponential("100 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(3))
)

const program = fetchProfile("user-123").pipe(
  Effect.retry({
    schedule: retryTransientProfileLoad,
    while: isTransientProfileLoadError
  })
)
```

Caution: jitter spreads delay across callers; it does not add a retry limit.

### Retry Token Refresh Briefly

Write the Effect code that retries token refresh only for temporary refresh failures. Use exponential backoff starting at about 100 ms. Add a little randomness, try at most 2 more times, stop after about 1 second, and do not retry rejected, revoked, or expired refresh tokens.

```ts
import { Effect, Schedule } from "effect"

type Tokens = unknown

type RefreshTimeout = { readonly _tag: "RefreshTimeout" }
type RefreshServiceUnavailable = { readonly _tag: "RefreshServiceUnavailable" }
type RefreshRejected = { readonly _tag: "RefreshRejected" }
type RefreshError = RefreshTimeout | RefreshServiceUnavailable | RefreshRejected

declare const postRefreshToken: (
  refreshToken: string
) => Effect.Effect<Tokens, RefreshError>

const isTransientRefreshFailure = (
  error: RefreshError
): error is RefreshTimeout | RefreshServiceUnavailable =>
  error._tag === "RefreshTimeout" ||
  error._tag === "RefreshServiceUnavailable"

const retryTokenRefreshBriefly = Schedule.exponential("100 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(2)),
  Schedule.both(Schedule.during("1 second"))
)

const program = postRefreshToken("refresh-token-1").pipe(
  Effect.retry({
    schedule: retryTokenRefreshBriefly,
    while: isTransientRefreshFailure
  })
)
```

Caution: jitter spreads delay across callers; it does not add a retry limit.

### Reconnect A WebSocket With Capped Backoff

Write the Effect code that reconnects a WebSocket. Use exponential backoff starting at about 100 ms, never wait more than 5 seconds before the next attempt, and try at most 8 more times.

```ts
import { Duration, Effect, Schedule } from "effect"

type LiveSocket = unknown
type WebSocketOpenError = unknown

declare const openLiveSocket: Effect.Effect<LiveSocket, WebSocketOpenError>
declare const isRetryableOpenError: (error: WebSocketOpenError) => boolean

const websocketReconnectPolicy = Schedule.exponential("100 millis").pipe(
  Schedule.modifyDelay((_, delay) => Effect.succeed(Duration.min(delay, Duration.seconds(5)))),
  Schedule.both(Schedule.recurs(8))
)

const program = openLiveSocket.pipe(
  Effect.retry({
    schedule: websocketReconnectPolicy,
    while: isRetryableOpenError
  })
)
```

Caution: `recurs(n)` counts follow-up recurrences after the first execution.

### Reconnect A WebSocket With Jitter

Write the Effect code that reconnects a WebSocket. Add a little randomness so clients do not reconnect together, use exponential backoff starting at about 100 ms, never wait more than 5 seconds before the next attempt, try at most 8 more times, and stop retrying non-retryable reconnect errors.

```ts
import { Duration, Effect, Schedule } from "effect"

type WebSocketReconnectError = unknown

declare const reconnectWebSocket: Effect.Effect<string, WebSocketReconnectError>
declare const isRetryableReconnect: (error: WebSocketReconnectError) => boolean

const webSocketReconnectPolicy = Schedule.exponential("100 millis").pipe(
  Schedule.setInputType<WebSocketReconnectError>(),
  Schedule.jittered,
  Schedule.modifyDelay((_, delay) => Effect.succeed(Duration.min(delay, Duration.seconds(5)))),
  Schedule.both(Schedule.recurs(8)),
  Schedule.while(({ input }) => isRetryableReconnect(input))
)

const program = reconnectWebSocket.pipe(
  Effect.retry(webSocketReconnectPolicy)
)
```

Caution: jitter spreads delay across callers; it does not add a retry limit.

### Retry Startup Dependency Checks

Write the Effect code that retries startup dependency checks only for temporary startup failures. Use exponential backoff starting at about 100 ms, never wait more than 2 seconds before the next retry, try at most 5 more times, and do not keep startup waiting for more than about 20 seconds.

```ts
import { Duration, Effect, Schedule } from "effect"

type DependencyCheckError =
  | { readonly reason: "DnsLookup" | "ConnectionRefused" | "Timeout" }
  | { readonly reason: "BadCredentials" | "SchemaMismatch" }

declare const checkDatabase: Effect.Effect<void, DependencyCheckError>

const isRetryableStartupFailure = (error: DependencyCheckError) =>
  error.reason === "DnsLookup" ||
  error.reason === "ConnectionRefused" ||
  error.reason === "Timeout"

const startupDependencyPolicy = Schedule.exponential("100 millis").pipe(
  Schedule.modifyDelay((_, delay) => Effect.succeed(Duration.min(delay, Duration.seconds(2)))),
  Schedule.both(Schedule.recurs(5)),
  Schedule.both(Schedule.during("20 seconds"))
)

const program = checkDatabase.pipe(
  Effect.retry({
    schedule: startupDependencyPolicy,
    while: isRetryableStartupFailure
  })
)
```

Caution: `recurs(n)` counts follow-up recurrences after the first execution.

### Retry A Duplicate-Safe Deployment Hook

Write the Effect code that retries a duplicate-safe deployment hook only for temporary hook failures.

```ts
import { Duration, Effect, Schedule } from "effect"

type HookReceipt = unknown

type DeploymentHookError = {
  readonly status: number
}

declare const invokeDeploymentHook: (
  request: {
    readonly deploymentId: string
    readonly hookName: string
    readonly idempotencyKey: string
  }
) => Effect.Effect<HookReceipt, DeploymentHookError>

const isRetryableHookError = (error: DeploymentHookError) =>
  error.status === 408 ||
  error.status === 409 ||
  error.status === 429 ||
  error.status >= 500

const deploymentHookRetryPolicy = Schedule.exponential("100 millis").pipe(
  Schedule.setInputType<DeploymentHookError>(),
  Schedule.jittered,
  Schedule.modifyDelay((_, delay) => Effect.succeed(Duration.min(delay, Duration.seconds(2)))),
  Schedule.both(Schedule.recurs(5)),
  Schedule.while(({ input }) => isRetryableHookError(input))
)

const program = invokeDeploymentHook({
  deploymentId: "deploy-1",
  hookName: "post-deploy-smoke-test",
  idempotencyKey: "deploy-1:post-deploy-smoke-test"
}).pipe(
  Effect.retry(deploymentHookRetryPolicy)
)
```

Caution: the schedule only times retries; the stable idempotency key is what makes duplicate attempts safe.

### Retry Infrastructure API Calls

Write the Effect code that retries a safe infrastructure API call for timeout, temporary unavailability, or rate limit failures. Reuse the same `clientToken`, use exponential backoff starting at about 100 ms, add a little randomness, try at most 5 more times, stop after about 30 seconds, and do not retry invalid requests or authorization failures.

```ts
import { Effect, Schedule } from "effect"

type InfrastructureApiError =
  | { readonly _tag: "ApiTimeout" }
  | { readonly _tag: "ApiUnavailable" }
  | { readonly _tag: "RateLimited" }
  | { readonly _tag: "InvalidRequest" }
  | { readonly _tag: "Unauthorized" }
  | { readonly _tag: "Forbidden" }

declare const createSubnet: (
  request: {
    readonly vpcId: string
    readonly cidrBlock: string
    readonly clientToken: string
  }
) => Effect.Effect<string, InfrastructureApiError>

const retryInfrastructureApi = Schedule.exponential("100 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(5)),
  Schedule.both(Schedule.during("30 seconds"))
)

const program = createSubnet({
  vpcId: "vpc-123",
  cidrBlock: "10.0.8.0/24",
  clientToken: "deploy-1-subnet-10-0-8"
}).pipe(
  Effect.retry({
    schedule: retryInfrastructureApi,
    while: (error) =>
      error._tag === "ApiTimeout" ||
      error._tag === "ApiUnavailable" ||
      error._tag === "RateLimited"
  })
)
```

Caution: classify permanent failures before applying retry; backoff does not make invalid input transient.

### Retry Export Generation

Write the Effect code that retries idempotent export generation only for temporary database, renderer, or object-storage failures. Use a stable `exportId`, use exponential backoff starting at about 100 ms, add a little randomness, try at most 4 more times, and do not retry invalid requests or permission failures.

```ts
import { Effect, Schedule } from "effect"

type ExportFile = unknown

type ExportRequest = {
  readonly exportId: string
  readonly accountId: string
  readonly format: "csv" | "json"
}

type ExportError =
  | { readonly _tag: "DatabaseUnavailable" }
  | { readonly _tag: "RendererBusy" }
  | { readonly _tag: "ObjectStorageUnavailable" }
  | { readonly _tag: "InvalidExportRequest" }
  | { readonly _tag: "PermissionDenied" }

declare const generateExport: (
  request: ExportRequest
) => Effect.Effect<ExportFile, ExportError>

const isTransientExportError = (error: ExportError): boolean => {
  switch (error._tag) {
    case "DatabaseUnavailable":
    case "RendererBusy":
    case "ObjectStorageUnavailable":
      return true
    case "InvalidExportRequest":
    case "PermissionDenied":
      return false
    default:
      return false
  }
}

const retryTransientExportFailures = Schedule.exponential("100 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(4))
)

const request: ExportRequest = {
  exportId: "export-2026-05-17",
  accountId: "acct-123",
  format: "csv"
}

const program = generateExport(request).pipe(
  Effect.retry({
    schedule: retryTransientExportFailures,
    while: isTransientExportError
  })
)
```

Caution: classify permanent failures before applying retry; backoff does not make invalid input transient.

### Retry Object Storage Uploads

Write the Effect code that retries an idempotent object storage upload only for temporary storage failures. Reuse deterministic object identity, add a little randomness so concurrent upload retries do not line up, use exponential backoff starting at about 250 ms, try at most 5 more times, and stop after about 30 seconds.

```ts
import { Effect, Schedule } from "effect"

type UploadRequest = {
  readonly bucket: string
  readonly key: string
  readonly body: Uint8Array
  readonly checksumSha256: string
  readonly idempotencyKey: string
}

type UploadError =
  | { readonly reason: "Timeout" }
  | { readonly reason: "Throttled" }
  | { readonly reason: "Unavailable" }
  | { readonly reason: "ChecksumMismatch" }
  | { readonly reason: "Forbidden" }
  | { readonly reason: "BadRequest" }

declare const body: Uint8Array

declare const uploadObject: (
  request: UploadRequest
) => Effect.Effect<void, UploadError>

const isTransientStorageError = (error: UploadError) =>
  error.reason === "Timeout" ||
  error.reason === "Throttled" ||
  error.reason === "Unavailable"

const uploadRetryPolicy = Schedule.exponential("250 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(5)),
  Schedule.both(Schedule.during("30 seconds"))
)

const program = uploadObject({
  bucket: "reports",
  key: "daily/sha256-demo.json",
  body,
  checksumSha256: "sha256-demo",
  idempotencyKey: "sha256-demo"
}).pipe(
  Effect.retry({
    schedule: uploadRetryPolicy,
    while: isTransientStorageError
  })
)
```

Caution: the schedule only times retries; the stable idempotency key is what makes duplicate attempts safe.

### Retry Import Processing

Write the Effect code that retries one idempotent import batch only for storage, database, or enrichment outages. Use exponential backoff starting at about 100 ms, add a little randomness, try at most 4 more times, stop after about 20 seconds, and do not retry malformed input or domain validation failures.

```ts
import { Effect, Schedule } from "effect"

type ImportBatch = unknown
type ImportSummary = unknown

type ImportError =
  | { readonly _tag: "StorageTimeout" }
  | { readonly _tag: "DatabaseUnavailable" }
  | { readonly _tag: "EnrichmentUnavailable" }
  | { readonly _tag: "MalformedInput" }
  | { readonly _tag: "ValidationFailed" }

declare const processImportBatch: (
  batch: ImportBatch
) => Effect.Effect<ImportSummary, ImportError>

declare const batch: ImportBatch

const isTransientImportError = (error: ImportError): boolean =>
  error._tag === "StorageTimeout" ||
  error._tag === "DatabaseUnavailable" ||
  error._tag === "EnrichmentUnavailable"

const importRetryPolicy = Schedule.exponential("100 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(4)),
  Schedule.both(Schedule.during("20 seconds"))
)

const program = processImportBatch(batch).pipe(
  Effect.retry({
    schedule: importRetryPolicy,
    while: isTransientImportError
  })
)
```

Caution: jitter spreads delay across callers; it does not add a retry limit.

### Retry Payment Status Fetches

Write the Effect code that retries a safe payment status read only for temporary status-fetch failures such as 408, 429, or 5xx responses. Use exponential backoff starting at about 100 ms, add a little randomness, and try at most 5 more times.

```ts
import { Effect, Schedule } from "effect"

type PaymentStatus = unknown

type PaymentStatusFetchError = {
  readonly status: number
}

declare const fetchPaymentStatus: Effect.Effect<PaymentStatus, PaymentStatusFetchError>

const isRetryableStatusFetch = (error: PaymentStatusFetchError) =>
  error.status === 408 || error.status === 429 || error.status >= 500

const paymentStatusFetchRetry = Schedule.exponential("100 millis").pipe(
  Schedule.setInputType<PaymentStatusFetchError>(),
  Schedule.jittered,
  Schedule.both(Schedule.recurs(5)),
  Schedule.while(({ input }) => isRetryableStatusFetch(input))
)

const program = fetchPaymentStatus.pipe(
  Effect.retry(paymentStatusFetchRetry)
)
```

Caution: jitter spreads delay across callers; it does not add a retry limit.

### Retry Notification Delivery

Write the Effect code that retries notification delivery only for timeout or provider-unavailable failures while preserving a stable notification idempotency key. Use exponential backoff starting at about 100 ms, add a little randomness, try at most 5 more times, and do not retry invalid recipients, malformed messages, or unauthorized requests.

```ts
import { Effect, Schedule } from "effect"

type Notification = {
  readonly idempotencyKey: string
  readonly recipient: string
  readonly body: string
}

type DeliveryError =
  | { readonly _tag: "Timeout" }
  | { readonly _tag: "ProviderUnavailable" }
  | { readonly _tag: "InvalidRecipient" }
  | { readonly _tag: "MalformedMessage" }
  | { readonly _tag: "Unauthorized" }

declare const sendWithIdempotency: (
  notification: Notification
) => Effect.Effect<void, DeliveryError>

const isRetryableDeliveryError = (error: DeliveryError): boolean =>
  error._tag === "Timeout" || error._tag === "ProviderUnavailable"

const retryTransientDelivery = Schedule.exponential("100 millis").pipe(
  Schedule.setInputType<DeliveryError>(),
  Schedule.jittered,
  Schedule.both(Schedule.recurs(5))
)

const program = sendWithIdempotency({
  idempotencyKey: "notification-01HZYX8R7P0J9PAW4Q6V7N3QYB",
  recipient: "user@example.com",
  body: "Your export is ready."
}).pipe(
  Effect.retry({
    schedule: retryTransientDelivery,
    while: isRetryableDeliveryError
  })
)
```

Caution: the schedule only times retries; the stable idempotency key is what makes duplicate attempts safe.

### Retry An Unstable Remote API

Write the Effect code for a request-path call to `callRemoteApi`.

```ts
import { Effect, Schedule } from "effect"

type RemoteApiError =
  | { readonly _tag: "Timeout" }
  | { readonly _tag: "ConnectionReset" }
  | { readonly _tag: "ServiceUnavailable" }
  | { readonly _tag: "BadRequest" }
  | { readonly _tag: "Unauthorized" }

declare const callRemoteApi: Effect.Effect<Response, RemoteApiError>

const isRetryableRemoteApiError = (error: RemoteApiError): boolean =>
  error._tag === "Timeout" ||
  error._tag === "ConnectionReset" ||
  error._tag === "ServiceUnavailable"

const remoteApiRetry = Schedule.exponential("100 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(5)),
  Schedule.both(Schedule.during("10 seconds"))
)

const program = callRemoteApi.pipe(
  Effect.retry({
    schedule: remoteApiRetry,
    while: isRetryableRemoteApiError
  })
)
```

Caution: classify permanent failures before applying retry; backoff does not make invalid input transient.

### Retry Queue Reconnection

Write the Effect code used by a worker during startup to connect to the queue.

```ts
import { Effect, Schedule } from "effect"

type QueueConnection = unknown

type QueueConnectError =
  | { readonly _tag: "DnsFailure" }
  | { readonly _tag: "ConnectionRefused" }
  | { readonly _tag: "BrokerUnavailable" }
  | { readonly _tag: "BadCredentials" }
  | { readonly _tag: "UnsupportedProtocol" }

declare const connectQueue: Effect.Effect<QueueConnection, QueueConnectError>

const isRetryableQueueConnectError = (error: QueueConnectError): boolean =>
  error._tag === "DnsFailure" ||
  error._tag === "ConnectionRefused" ||
  error._tag === "BrokerUnavailable"

const queueReconnect = Schedule.exponential("100 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(8)),
  Schedule.both(Schedule.during("1 minute"))
)

const program = connectQueue.pipe(
  Effect.retry({
    schedule: queueReconnect,
    while: isRetryableQueueConnectError
  })
)
```

Caution: jitter spreads delay across callers; it does not add a retry limit.

### Retry Cold-Start Dependencies

Write the Effect code for a service startup check.

```ts
import { Effect, Schedule } from "effect"

type DependencyCheckError =
  | { readonly _tag: "DnsLookup" }
  | { readonly _tag: "ConnectionRefused" }
  | { readonly _tag: "Timeout" }
  | { readonly _tag: "BadCredentials" }
  | { readonly _tag: "SchemaMismatch" }

declare const checkDependency: Effect.Effect<void, DependencyCheckError>

const isRetryableStartupCheckError = (error: DependencyCheckError): boolean =>
  error._tag === "DnsLookup" ||
  error._tag === "ConnectionRefused" ||
  error._tag === "Timeout"

const dependencyStartup = Schedule.exponential("100 millis").pipe(
  Schedule.both(Schedule.recurs(6)),
  Schedule.both(Schedule.during("30 seconds"))
)

const program = checkDependency.pipe(
  Effect.retry({
    schedule: dependencyStartup,
    while: isRetryableStartupCheckError
  })
)
```

Caution: `recurs(n)` counts follow-up recurrences after the first execution.

### Retry With Capped Backoff

Write the Effect code for calling the search backend.

```ts
import { Duration, Effect, Schedule } from "effect"

type SearchResult = unknown

type SearchBackendError =
  | { readonly _tag: "Timeout" }
  | { readonly _tag: "Overloaded" }
  | { readonly _tag: "RejectedQuery" }

declare const callSearchBackend: Effect.Effect<SearchResult, SearchBackendError>

const isRetryableSearchBackendError = (error: SearchBackendError): boolean =>
  error._tag === "Timeout" || error._tag === "Overloaded"

const cappedBackoff = Schedule.exponential("100 millis").pipe(
  Schedule.modifyDelay((_, delay) => Effect.succeed(Duration.min(delay, Duration.seconds(5)))),
  Schedule.both(Schedule.recurs(5))
)

const program = callSearchBackend.pipe(
  Effect.retry({
    schedule: cappedBackoff,
    while: isRetryableSearchBackendError
  })
)
```

Caution: `recurs(n)` counts follow-up recurrences after the first execution.

### Retry HTTP Clients With Jitter

Write the Effect code for a client request that may be called by many app instances at once.

```ts
import { Effect, Schedule } from "effect"

type HttpResponse = unknown

type HttpClientError =
  | { readonly _tag: "Timeout" }
  | { readonly _tag: "ConnectionReset" }
  | { readonly _tag: "ResponseError"; readonly status: number }
  | { readonly _tag: "InvalidRequest" }

declare const httpRequest: Effect.Effect<HttpResponse, HttpClientError>

const isRetryableHttpClientError = (error: HttpClientError): boolean =>
  error._tag === "Timeout" ||
  error._tag === "ConnectionReset" ||
  (error._tag === "ResponseError" && error.status >= 500)

const httpRetry = Schedule.exponential("100 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(5))
)

const program = httpRequest.pipe(
  Effect.retry({
    schedule: httpRetry,
    while: isRetryableHttpClientError
  })
)
```

Caution: classify permanent failures before applying retry; backoff does not make invalid input transient.

### Do Not Retry Validation Errors

Write the Effect code for submitting the form.

```ts
import { Effect, Schedule } from "effect"

type SubmitReceipt = unknown

type SubmitError =
  | { readonly _tag: "Timeout" }
  | { readonly _tag: "ServiceUnavailable" }
  | { readonly _tag: "ValidationError"; readonly field: string }

declare const submitForm: Effect.Effect<SubmitReceipt, SubmitError>

const isRetryableSubmitError = (error: SubmitError): boolean =>
  error._tag === "Timeout" || error._tag === "ServiceUnavailable"

const program = submitForm.pipe(
  Effect.retry({
    schedule: Schedule.exponential("100 millis").pipe(Schedule.both(Schedule.recurs(3))),
    while: isRetryableSubmitError
  })
)
```

Caution: classify permanent failures before applying retry; backoff does not make invalid input transient.

### Retry Only 5xx Responses

Write the Effect code for a safe resource read.

```ts
import { Effect, Schedule } from "effect"

type Resource = unknown

type HttpError =
  | { readonly _tag: "HttpError"; readonly status: number }
  | { readonly _tag: "NetworkError" }

declare const fetchResource: Effect.Effect<Resource, HttpError>

const isServerError = (error: HttpError): boolean => error._tag === "HttpError" && error.status >= 500

const program = fetchResource.pipe(
  Effect.retry({
    schedule: Schedule.exponential("100 millis").pipe(Schedule.both(Schedule.recurs(3))),
    while: isServerError
  })
)
```

Caution: `recurs(n)` counts follow-up recurrences after the first execution.

### Retry Safe GET Reads

Write the Effect code for a safe read path.

```ts
import { Effect, Schedule } from "effect"

type Resource = unknown

type GetError =
  | { readonly _tag: "Timeout"; readonly method: "GET" | "POST" }
  | { readonly _tag: "ServiceUnavailable"; readonly method: "GET" | "POST" }
  | { readonly _tag: "BadRequest"; readonly method: "GET" | "POST" }

declare const getResource: Effect.Effect<Resource, GetError>

const isRetryableGetError = (error: GetError): boolean =>
  error.method === "GET" &&
  (error._tag === "Timeout" || error._tag === "ServiceUnavailable")

const program = getResource.pipe(
  Effect.retry({
    schedule: Schedule.exponential("100 millis").pipe(Schedule.both(Schedule.recurs(3))),
    while: isRetryableGetError
  })
)
```

Caution: `recurs(n)` counts follow-up recurrences after the first execution.

### Retry Short Pauses, Then Backoff

Write the Effect code for a search request where the first failures are often very short blips.

```ts
import { Effect, Schedule } from "effect"

type SearchBackendError = unknown
type SearchResult = unknown

declare const callSearchBackend: Effect.Effect<SearchResult, SearchBackendError>

const shortRetries = Schedule.spaced("100 millis").pipe(
  Schedule.bothLeft(Schedule.recurs(2))
)
const backoffRetries = Schedule.exponential("250 millis").pipe(
  Schedule.both(Schedule.recurs(4))
)
const policy = shortRetries.pipe(Schedule.andThen(backoffRetries))

const program = callSearchBackend.pipe(Effect.retry(policy))
```

Caution: `recurs(n)` counts follow-up recurrences after the first execution.

### Retry While An Auth Token Is Stale

Write the Effect code for refreshing an auth token.

```ts
import { Effect, Schedule } from "effect"

type AuthToken = unknown

type AuthTokenError =
  | { readonly _tag: "StaleToken" }
  | { readonly _tag: "TokenRevoked" }
  | { readonly _tag: "MalformedToken" }

declare const refreshAuthToken: Effect.Effect<AuthToken, AuthTokenError>

const program = refreshAuthToken.pipe(
  Effect.retry({
    schedule: Schedule.spaced("500 millis").pipe(
      Schedule.both(Schedule.recurs(4))
    ),
    while: (error) => error._tag === "StaleToken"
  })
)
```

Caution: `recurs(n)` counts follow-up recurrences after the first execution.

### Retry While A Circuit Breaker Allows It

Write the Effect code for calling billing from a checkout flow.

```ts
import { Effect, Schedule } from "effect"

type BillingReceipt = unknown

type BillingError =
  | { readonly _tag: "TransientBillingError" }
  | { readonly _tag: "RejectedPayment" }

declare const callBilling: Effect.Effect<BillingReceipt, BillingError>
declare const circuitBreakerAllowsRetry: (error: BillingError) => Effect.Effect<boolean>

const program = callBilling.pipe(
  Effect.retry({
    schedule: Schedule.exponential("100 millis").pipe(Schedule.both(Schedule.recurs(5))),
    while: (error) =>
      error._tag === "TransientBillingError"
        ? circuitBreakerAllowsRetry(error)
        : Effect.succeed(false)
  })
)
```

Caution: `recurs(n)` counts follow-up recurrences after the first execution.

## Polling And State Observation

In these recipes, non-terminal states are successful values, not failures. `Effect.repeat` runs the effect again after each success and stops when the schedule stops. A real failure from the effect still fails the whole program.

### Poll Job Status Until Terminal

Write the Effect code that polls `readJobStatus("job-1")` until the status is `succeeded` or `failed`, or until about 30 seconds pass.

```ts
import { Effect, Schedule } from "effect"

type JobStatusError = unknown

type JobStatus =
  | { readonly state: "queued"; readonly jobId: string }
  | { readonly state: "running"; readonly jobId: string }
  | { readonly state: "succeeded"; readonly jobId: string; readonly artifactUrl: string }
  | { readonly state: "failed"; readonly jobId: string; readonly reason: string }

declare const readJobStatus: (
  jobId: string
) => Effect.Effect<JobStatus, JobStatusError>

const isTerminal = (status: JobStatus): boolean => status.state === "succeeded" || status.state === "failed"

const pollJobStatus = Schedule.spaced("1 second").pipe(
  Schedule.setInputType<JobStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => !isTerminal(input)),
  Schedule.bothLeft(
    Schedule.during("30 seconds").pipe(
      Schedule.setInputType<JobStatus>()
    )
  )
)

const program = readJobStatus("job-1").pipe(
  Effect.repeat(pollJobStatus)
)
```

Caution: raw `Effect.repeat(schedule)` returns the schedule output; `Schedule.passthrough` preserves the latest successful value.

### Poll Platform Readiness

Write the Effect code that polls readiness snapshots.

```ts
import { Effect, Schedule } from "effect"

type ReadinessCheckError = unknown
type ReadinessSnapshot = unknown

declare const readPlatformReadiness: Effect.Effect<ReadinessSnapshot, ReadinessCheckError>
declare const isTerminalReadiness: (snapshot: ReadinessSnapshot) => boolean

const readinessPolling = Schedule.spaced("1 second").pipe(
  Schedule.setInputType<ReadinessSnapshot>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => !isTerminalReadiness(input)),
  Schedule.bothLeft(Schedule.during("30 seconds")),
  Schedule.bothLeft(Schedule.recurs(30))
)

const program = readPlatformReadiness.pipe(
  Effect.repeat(readinessPolling)
)
```

Caution: raw `Effect.repeat(schedule)` returns the schedule output; `Schedule.passthrough` preserves the latest successful value.

### Poll Rollout Status With Jitter

Write the Effect code that polls a rollout about once per second while it is `running`. Add a little randomness so many status watchers do not poll at the same instant. Stop on `succeeded` or `failed`; if it is still running after about 2 minutes, return the latest status.

```ts
import { Effect, Schedule } from "effect"

type StatusReadError = unknown

type RolloutStatus =
  | { readonly state: "running" }
  | { readonly state: "succeeded" }
  | { readonly state: "failed"; readonly reason: string }

declare const readRolloutStatus: (
  rolloutId: string
) => Effect.Effect<RolloutStatus, StatusReadError>

const pollRolloutStatus = Schedule.spaced("1 second").pipe(
  Schedule.jittered,
  Schedule.setInputType<RolloutStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input.state === "running"),
  Schedule.bothLeft(Schedule.during("2 minutes"))
)

const program = readRolloutStatus("rollout-42").pipe(
  Effect.repeat(pollRolloutStatus)
)
```

Caution: raw `Effect.repeat(schedule)` returns the schedule output; `Schedule.passthrough` preserves the latest successful value.

### Poll ETL Status

Write the Effect code that polls ETL status until `succeeded`, `failed`, or `canceled`, preserving the final observed status. Check about every 5 seconds and stop waiting after about 5 minutes.

```ts
import { Effect, Schedule } from "effect"

type StatusReadError = unknown

type EtlStatus =
  | { readonly state: "running" }
  | { readonly state: "succeeded" }
  | { readonly state: "failed"; readonly reason: string }
  | { readonly state: "canceled" }

declare const readEtlStatus: (
  runId: string
) => Effect.Effect<EtlStatus, StatusReadError>

const isTerminalEtlStatus = (status: EtlStatus): boolean =>
  status.state === "succeeded" ||
  status.state === "failed" ||
  status.state === "canceled"

const pollEtlStatusBudget = Schedule.spaced("5 seconds").pipe(
  Schedule.setInputType<EtlStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => !isTerminalEtlStatus(input)),
  Schedule.bothLeft(Schedule.during("5 minutes")),
  Schedule.bothLeft(Schedule.recurs(60))
)

const program = readEtlStatus("etl-run-7").pipe(
  Effect.repeat(pollEtlStatusBudget)
)
```

Caution: raw `Effect.repeat(schedule)` returns the schedule output; `Schedule.passthrough` preserves the latest successful value.

### Poll Payment Settlement

Write the Effect code that polls successful settlement statuses.

```ts
import { Effect, Schedule } from "effect"

type SettlementError = unknown

type SettlementStatus =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Processing" }
  | { readonly _tag: "Settled" }
  | { readonly _tag: "Declined" }

declare const fetchSettlementStatus: Effect.Effect<SettlementStatus, SettlementError>

const isOpen = (status: SettlementStatus) => status._tag === "Pending" || status._tag === "Processing"

const pollOpenSettlements = Schedule.spaced("1 second").pipe(
  Schedule.setInputType<SettlementStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => isOpen(input)),
  Schedule.bothLeft(Schedule.during("30 seconds"))
)

const program = fetchSettlementStatus.pipe(
  Effect.repeat(pollOpenSettlements)
)
```

Caution: raw `Effect.repeat(schedule)` returns the schedule output; `Schedule.passthrough` preserves the latest successful value.

### Poll Order Fulfillment

Write the Effect code that polls fulfillment statuses.

```ts
import { Effect, Schedule } from "effect"

type FulfillmentReadError = unknown

type FulfillmentStatus =
  | { readonly state: "preparing" }
  | { readonly state: "shipped" }
  | { readonly state: "delivered" }
  | { readonly state: "canceled"; readonly reason: string }

declare const readFulfillmentStatus: Effect.Effect<FulfillmentStatus, FulfillmentReadError>

const isTerminalFulfillment = (status: FulfillmentStatus) => status.state === "delivered" || status.state === "canceled"

const userFacingPolling = Schedule.spaced("1 second").pipe(
  Schedule.setInputType<FulfillmentStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => !isTerminalFulfillment(input)),
  Schedule.bothLeft(Schedule.during("30 seconds"))
)

const program = readFulfillmentStatus.pipe(
  Effect.repeat(userFacingPolling)
)
```

Caution: raw `Effect.repeat(schedule)` returns the schedule output; `Schedule.passthrough` preserves the latest successful value.

### Poll A Background Job

Write the Effect code used by an API endpoint after it starts a background job.

```ts
import { Effect, Schedule } from "effect"

type JobStatusError = unknown

type JobStatus =
  | { readonly state: "queued"; readonly jobId: string }
  | { readonly state: "running"; readonly jobId: string }
  | { readonly state: "done"; readonly jobId: string }
  | { readonly state: "failed"; readonly jobId: string; readonly reason: string }

declare const jobId: string
declare const readJobStatus: (jobId: string) => Effect.Effect<JobStatus, JobStatusError>

const pollJob = Schedule.spaced("1 second").pipe(
  Schedule.setInputType<JobStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input.state === "queued" || input.state === "running"),
  Schedule.bothLeft(Schedule.during("30 seconds"))
)

const program = readJobStatus(jobId).pipe(Effect.repeat(pollJob))
```

Caution: raw `Effect.repeat(schedule)` returns the schedule output; `Schedule.passthrough` preserves the latest successful value.

### Poll A Payment Until Settled

Write the Effect code used after submitting a payment.

```ts
import { Effect, Schedule } from "effect"

type PaymentReadError = unknown

type PaymentStatus =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Processing" }
  | { readonly _tag: "Settled" }
  | { readonly _tag: "Declined" }

declare const paymentId: string
declare const readPaymentStatus: (paymentId: string) => Effect.Effect<PaymentStatus, PaymentReadError>

const pollPayment = Schedule.spaced("1 second").pipe(
  Schedule.setInputType<PaymentStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input._tag === "Pending" || input._tag === "Processing"),
  Schedule.bothLeft(Schedule.during("30 seconds"))
)

const program = readPaymentStatus(paymentId).pipe(Effect.repeat(pollPayment))
```

Caution: raw `Effect.repeat(schedule)` returns the schedule output; `Schedule.passthrough` preserves the latest successful value.

### Poll An Export Until Ready

Write the Effect code used after requesting a report export.

```ts
import { Effect, Schedule } from "effect"

type ExportStatusError = unknown

type ExportStatus =
  | { readonly state: "queued" }
  | { readonly state: "running" }
  | { readonly state: "ready"; readonly url: string }
  | { readonly state: "failed"; readonly reason: string }

declare const exportId: string
declare const readExportStatus: (exportId: string) => Effect.Effect<ExportStatus, ExportStatusError>

const pollExport = Schedule.spaced("2 seconds").pipe(
  Schedule.setInputType<ExportStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input.state === "queued" || input.state === "running"),
  Schedule.bothLeft(Schedule.during("2 minutes"))
)

const program = readExportStatus(exportId).pipe(Effect.repeat(pollExport))
```

Caution: raw `Effect.repeat(schedule)` returns the schedule output; `Schedule.passthrough` preserves the latest successful value.

### Poll Cloud Provisioning

Write the Effect code used after creating cloud infrastructure.

```ts
import { Effect, Schedule } from "effect"

type ProvisioningReadError = unknown

type ProvisioningStatus =
  | { readonly state: "creating" }
  | { readonly state: "updating" }
  | { readonly state: "ready" }
  | { readonly state: "failed"; readonly reason: string }

declare const resourceId: string
declare const readProvisioningStatus: (resourceId: string) => Effect.Effect<ProvisioningStatus, ProvisioningReadError>

const pollProvisioning = Schedule.spaced("5 seconds").pipe(
  Schedule.setInputType<ProvisioningStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input.state === "creating" || input.state === "updating"),
  Schedule.bothLeft(Schedule.during("5 minutes"))
)

const program = readProvisioningStatus(resourceId).pipe(Effect.repeat(pollProvisioning))
```

Caution: raw `Effect.repeat(schedule)` returns the schedule output; `Schedule.passthrough` preserves the latest successful value.

### Poll Until Completed

Write the Effect code used by a client that waits briefly for completion.

```ts
import { Effect, Schedule } from "effect"

type StatusReadError = unknown

type Status = "Queued" | "Running" | "Completed"

declare const id: string
declare const readStatus: (id: string) => Effect.Effect<Status, StatusReadError>

const untilCompleted = Schedule.spaced("1 second").pipe(
  Schedule.setInputType<Status>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input !== "Completed"),
  Schedule.bothLeft(Schedule.during("30 seconds"))
)

const program = readStatus(id).pipe(Effect.repeat(untilCompleted))
```

Caution: raw `Effect.repeat(schedule)` returns the schedule output; `Schedule.passthrough` preserves the latest successful value.

### Repeat Until A Condition Is True

Write the Effect code used by a command-line tool waiting for work to complete.

```ts
import { Effect, Schedule } from "effect"

type StatusCheckError = unknown

type Status =
  | { readonly _tag: "Working" }
  | { readonly _tag: "Complete" }

declare const checkStatus: Effect.Effect<Status, StatusCheckError>
declare const isComplete: (status: Status) => boolean

const untilComplete = Schedule.spaced("1 second").pipe(
  Schedule.setInputType<Status>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => !isComplete(input))
)

const program = checkStatus.pipe(Effect.repeat(untilComplete))
```

Caution: raw `Effect.repeat(schedule)` returns the schedule output; `Schedule.passthrough` preserves the latest successful value.

### Repeat While Work Remains

Write the Effect code for draining batches from a backlog.

```ts
import { Effect, Schedule } from "effect"

type BatchError = unknown

type BatchResult = {
  readonly processed: number
  readonly remaining: number
}

declare const processBatch: Effect.Effect<BatchResult, BatchError>

const whileWorkRemains = Schedule.spaced("1 second").pipe(
  Schedule.setInputType<BatchResult>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input.remaining > 0)
)

const program = processBatch.pipe(Effect.repeat(whileWorkRemains))
```

Caution: raw `Effect.repeat(schedule)` returns the schedule output; `Schedule.passthrough` preserves the latest successful value.

### Poll Until A Resource Exists

Write the Effect code that waits for a just-created resource to become visible.

```ts
import { Effect, Schedule } from "effect"

type LookupError = unknown
type Resource = unknown

type ResourceLookup =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Found"; readonly resource: Resource }

declare const lookupResource: (id: string) => Effect.Effect<ResourceLookup, LookupError>
declare const id: string

const untilResourceExists = Schedule.spaced("1 second").pipe(
  Schedule.setInputType<ResourceLookup>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input._tag === "Missing"),
  Schedule.bothLeft(Schedule.during("30 seconds"))
)

const program = lookupResource(id).pipe(Effect.repeat(untilResourceExists))
```

Caution: raw `Effect.repeat(schedule)` returns the schedule output; `Schedule.passthrough` preserves the latest successful value.

### Poll Until A Cache Entry Appears

Write the Effect code that waits for a cache entry written by another process.

```ts
import { Effect, Schedule } from "effect"

type CacheReadError = unknown
type CachedValue = unknown

type CacheLookup =
  | { readonly _tag: "Miss" }
  | { readonly _tag: "Hit"; readonly value: CachedValue }

declare const readCacheEntry: (key: string) => Effect.Effect<CacheLookup, CacheReadError>
declare const key: string

const untilCacheHit = Schedule.spaced("500 millis").pipe(
  Schedule.setInputType<CacheLookup>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input._tag === "Miss"),
  Schedule.bothLeft(Schedule.during("10 seconds"))
)

const program = readCacheEntry(key).pipe(Effect.repeat(untilCacheHit))
```

Caution: raw `Effect.repeat(schedule)` returns the schedule output; `Schedule.passthrough` preserves the latest successful value.

### Poll Until Replication Catches Up

Write the Effect code used after writing to the primary database.

```ts
import { Effect, Schedule } from "effect"

type ReplicationReadError = unknown

type ReplicationLag = {
  readonly behindBy: number
}

declare const readReplicationLag: Effect.Effect<ReplicationLag, ReplicationReadError>

const untilCaughtUp = Schedule.spaced("1 second").pipe(
  Schedule.setInputType<ReplicationLag>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input.behindBy > 0),
  Schedule.bothLeft(Schedule.during("1 minute"))
)

const program = readReplicationLag.pipe(Effect.repeat(untilCaughtUp))
```

Caution: raw `Effect.repeat(schedule)` returns the schedule output; `Schedule.passthrough` preserves the latest successful value.

### Poll With An Interval And Deadline

Write the Effect code for a status reader that should keep checking briefly.

```ts
import { Effect, Schedule } from "effect"

type Status = unknown
type StatusReadError = unknown

declare const readStatus: Effect.Effect<Status, StatusReadError>

const polling = Schedule.spaced("1 second").pipe(
  Schedule.passthrough,
  Schedule.bothLeft(Schedule.during("30 seconds"))
)

const program = readStatus.pipe(Effect.repeat(polling))
```

Caution: raw `Effect.repeat(schedule)` returns the schedule output; `Schedule.passthrough` preserves the latest successful value.

### Return A Graceful Poll Timeout

Write the Effect code for an API endpoint that waits briefly for work to finish.

```ts
import { Effect, Schedule } from "effect"

type Result = unknown
type StatusReadError = unknown

type Status =
  | { readonly _tag: "Running" }
  | { readonly _tag: "Finished"; readonly value: Result }

declare const readStatus: Effect.Effect<Status, StatusReadError>

const polling = Schedule.spaced("1 second").pipe(
  Schedule.setInputType<Status>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input._tag === "Running"),
  Schedule.bothLeft(Schedule.during("30 seconds"))
)

const program = readStatus.pipe(
  Effect.repeat(polling),
  Effect.flatMap((status) =>
    status._tag === "Running"
      ? Effect.fail({ _tag: "TimedOut", latest: status } as const)
      : Effect.succeed(status)
  )
)
```

Explanation: exhausting the schedule is not a failure by itself. `Effect.repeat` returns the latest schedule output, so the final `flatMap` turns an unfinished latest status into a domain-specific timeout.

Caution: raw `Effect.repeat(schedule)` returns the schedule output; `Schedule.passthrough` preserves the latest successful value.

### Poll Fast, Then Slow

Write the Effect code used immediately after starting a workflow.

```ts
import { Effect, Schedule } from "effect"

type WorkflowStatus = unknown
type WorkflowStatusError = unknown

declare const readWorkflowStatus: Effect.Effect<WorkflowStatus, WorkflowStatusError>

const fastThenSlow = Schedule.spaced("250 millis").pipe(
  Schedule.bothLeft(Schedule.recurs(8))
)
const slowPolling = Schedule.spaced("2 seconds")
const polling = Schedule.andThen(fastThenSlow, slowPolling).pipe(
  Schedule.setInputType<WorkflowStatus>(),
  Schedule.passthrough
)

const program = readWorkflowStatus.pipe(Effect.repeat(polling))
```

Caution: raw `Effect.repeat(schedule)` returns the schedule output; `Schedule.passthrough` preserves the latest successful value.

### Repeat Until An Effectful Predicate Stops

Write the Effect code for a startup readiness probe.

```ts
import { Effect, Schedule } from "effect"

type ProbeError = unknown

type ServiceProbeResult =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Failed" }

declare const probeService: Effect.Effect<ServiceProbeResult, ProbeError>
declare const recordReadinessProbe: (result: ServiceProbeResult) => Effect.Effect<void>

const program = probeService.pipe(
  Effect.repeat({
    schedule: Schedule.spaced("1 second").pipe(
      Schedule.both(Schedule.recurs(30))
    ),
    until: (result) =>
      recordReadinessProbe(result).pipe(
        Effect.map(() => result._tag === "Ready" || result._tag === "Failed")
      )
  })
)
```

Caution: `recurs(n)` counts follow-up recurrences after the first execution.

## Repeat And Background Work

### Repeat Failed-Record Reprocessing

Write the Effect code for a repair job that reprocesses failed records in passes. After the first successful pass, run at most 3 more passes, waiting about 30 seconds between passes.

```ts
import { Effect, Schedule } from "effect"

type ReprocessBatchError = unknown

declare const reprocessFailedBatch: Effect.Effect<void, ReprocessBatchError>

const reprocessingCadence = Schedule.spaced("30 seconds").pipe(
  Schedule.take(3)
)

const program = reprocessFailedBatch.pipe(
  Effect.repeat(reprocessingCadence)
)
```

Caution: `Effect.repeat` observes successful values and stops on the first failure.

### Repeat CRM Sync

Write the Effect code that repeats successful CRM sync passes, waiting about 5 minutes between completed passes. Return the latest successful sync summary. Failed CRM requests should fail the program; do not turn this into retry logic.

```ts
import { Effect, Schedule } from "effect"

type SyncError = unknown
type SyncSummary = unknown

declare const syncCrmOnce: Effect.Effect<SyncSummary, SyncError>

const crmSyncCadence = Schedule.spaced("5 minutes").pipe(
  Schedule.setInputType<SyncSummary>(),
  Schedule.passthrough
)

const program = syncCrmOnce.pipe(
  Effect.repeat(crmSyncCadence)
)
```

Caution: raw `Effect.repeat(schedule)` returns the schedule output; `Schedule.passthrough` preserves the latest successful value.

### Jitter Periodic Cache Refreshes

This service runs on many instances. Write the Effect code that refreshes the cache in the background after each successful refresh.

```ts
import { Effect, Schedule } from "effect"

type CacheRefreshError = unknown

declare const refreshCache: Effect.Effect<void, CacheRefreshError>

const refreshCadence = Schedule.spaced("1 minute").pipe(
  Schedule.jittered
)

const program = refreshCache.pipe(Effect.repeat(refreshCadence))
```

Caution: jitter spreads delay across callers; it does not add a retry limit.

### Slow A Worker Loop

Write the Effect code for a background worker loop.

```ts
import { Effect, Schedule } from "effect"

type WorkerError = unknown

type WorkerIteration =
  | { readonly _tag: "Processed"; readonly count: number }
  | { readonly _tag: "Idle" }

declare const workerIteration: Effect.Effect<WorkerIteration, WorkerError>

const workerCadence = Schedule.spaced("500 millis")

const program = workerIteration.pipe(
  Effect.repeat(workerCadence)
)
```

Caution: `Effect.repeat` observes successful values and stops on the first failure.

### Drain A Queue Slowly

Write the Effect code for a maintenance process that drains queued work.

```ts
import { Effect, Schedule } from "effect"

type DrainSummary = unknown
type QueueDrainError = unknown

declare const drainQueueOnce: Effect.Effect<DrainSummary, QueueDrainError>

const drainCadence = Schedule.spaced("1 second")
const program = drainQueueOnce.pipe(Effect.repeat(drainCadence))
```

Caution: `Effect.repeat` observes successful values and stops on the first failure.

### Observe Repeat Counts

Write the Effect code for a metrics flush loop that stops after a small number of follow-up flushes.

```ts
import { Effect, Schedule } from "effect"

type MetricsFlushError = unknown

declare const flushMetricsBatch: Effect.Effect<void, MetricsFlushError>

declare const Metrics: {
  readonly recordFlushAttempt: (attempt: number) => Effect.Effect<void>
}

const policy = Schedule.spaced("10 seconds").pipe(
  Schedule.bothRight(Schedule.recurs(6)),
  Schedule.tapOutput((count) => Metrics.recordFlushAttempt(count))
)

const program = flushMetricsBatch.pipe(Effect.repeat(policy))
```

Caution: `recurs(n)` counts follow-up recurrences after the first execution.

### Warm Up Polling, Then Steady Polling

Write the Effect code used right after enabling a new indexer.

```ts
import { Effect, Schedule } from "effect"

type IndexerLag = unknown
type IndexerLagError = unknown

declare const readIndexerLag: Effect.Effect<IndexerLag, IndexerLagError>

const warmup = Schedule.spaced("250 millis").pipe(
  Schedule.bothLeft(Schedule.recurs(8))
)
const steady = Schedule.spaced("5 seconds")
const policy = warmup.pipe(
  Schedule.andThen(steady),
  Schedule.setInputType<IndexerLag>(),
  Schedule.passthrough
)

const program = readIndexerLag.pipe(Effect.repeat(policy))
```

Caution: raw `Effect.repeat(schedule)` returns the schedule output; `Schedule.passthrough` preserves the latest successful value.

### Burst Heartbeats, Then Fixed Heartbeats

Write the Effect code used when a process first joins a cluster.

```ts
import { Effect, Schedule } from "effect"

type HeartbeatError = unknown

declare const sendHeartbeat: Effect.Effect<void, HeartbeatError>

const burst = Schedule.spaced("100 millis").pipe(
  Schedule.bothLeft(Schedule.recurs(3))
)
const steady = Schedule.fixed("30 seconds")
const policy = burst.pipe(Schedule.andThen(steady))

const program = sendHeartbeat.pipe(Effect.repeat(policy))
```

Caution: `recurs(n)` counts follow-up recurrences after the first execution.

### Repeat A Fixed Heartbeat

Write the Effect code for a long-running process heartbeat.

```ts
import { Effect, Schedule } from "effect"

type HeartbeatError = unknown

declare const sendHeartbeat: Effect.Effect<void, HeartbeatError>

const heartbeatCadence = Schedule.fixed("30 seconds")
const program = sendHeartbeat.pipe(Effect.repeat(heartbeatCadence))
```

Caution: `Effect.repeat` observes successful values and stops on the first failure.

### Repeat On Metric Flush Windows

Write the Effect code for flushing metrics on wall-clock minute windows.

```ts
import { Effect, Schedule } from "effect"

type MetricsFlushError = unknown

declare const flushMetrics: Effect.Effect<void, MetricsFlushError>

const flushWindow = Schedule.windowed("1 minute")
const program = flushMetrics.pipe(Effect.repeat(flushWindow))
```

Caution: `Effect.repeat` observes successful values and stops on the first failure.

### Repeat A Nightly Cron Job

Write the Effect code for a database maintenance job.

```ts
import { Effect, Schedule } from "effect"

type CompactionError = unknown

declare const compactDatabase: Effect.Effect<void, CompactionError>

const nightly = Schedule.cron("0 2 * * *")
const program = compactDatabase.pipe(Effect.repeat(nightly))
```

Caution: `Effect.repeat` observes successful values and stops on the first failure.

### Run One Follow-Up Cache Warm

Write the Effect code for a deploy hook that warms the cache once, then performs one follow-up warm after 10 seconds.

```ts
import { Effect, Schedule } from "effect"

type CacheWarmError = unknown

declare const warmCache: Effect.Effect<void, CacheWarmError>

const oneMoreRun = Schedule.duration("10 seconds")
const program = warmCache.pipe(Effect.repeat(oneMoreRun))
```

Caution: `Effect.repeat` observes successful values and stops on the first failure.

### Repeat Until Terminal With Options

Write the Effect code used after starting a file transfer.

```ts
import { Effect, Schedule } from "effect"

type TransferStatusError = unknown

type TransferStatus =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "InProgress" }
  | { readonly _tag: "Completed" }
  | { readonly _tag: "Failed" }

declare const readTransferStatus: Effect.Effect<TransferStatus, TransferStatusError>

const program = readTransferStatus.pipe(
  Effect.repeat({
    schedule: Schedule.spaced("1 second"),
    until: (status) => status._tag === "Completed" || status._tag === "Failed"
  })
)
```

Caution: `Effect.repeat` observes successful values and stops on the first failure.

## Observability

### Log Each Retry Attempt

Write the Effect code for fetching inventory from a provider.

```ts
import { Console, Effect, Schedule } from "effect"

type InventorySnapshot = unknown

type InventoryError =
  | { readonly _tag: "TransientInventoryError" }
  | { readonly _tag: "InvalidSku" }

declare const fetchInventory: Effect.Effect<InventorySnapshot, InventoryError>

const retryInventoryPolicy = Schedule.exponential("100 millis").pipe(
  Schedule.both(Schedule.recurs(5)),
  Schedule.tapInput((error: InventoryError) => Console.log(`retry input: ${error._tag}`)),
  Schedule.tapOutput((output) => Console.log(`retry scheduled: ${String(output)}`))
)

const program = fetchInventory.pipe(
  Effect.retry({
    schedule: retryInventoryPolicy,
    while: (error) => error._tag === "TransientInventoryError"
  })
)
```

Caution: classify permanent failures before applying retry; backoff does not make invalid input transient.

### Log Retry Counts With `bothRight`

Write the Effect code for uploading one chunk.

```ts
import { Console, Effect, Schedule } from "effect"

type UploadError =
  | { readonly _tag: "TransientUploadError" }
  | { readonly _tag: "InvalidUpload" }

declare const uploadChunk: Effect.Effect<void, UploadError>

const policy = Schedule.exponential("100 millis").pipe(
  Schedule.bothRight(Schedule.recurs(4)),
  Schedule.tapOutput((count) => Console.log(`retry attempt ${count}`))
)

const program = uploadChunk.pipe(
  Effect.retry({
    schedule: policy,
    while: (error) => error._tag === "TransientUploadError"
  })
)
```

Caution: classify permanent failures before applying retry; backoff does not make invalid input transient.

### Observe Retry Input Errors

Write the Effect code for an inventory lookup that records retry diagnostics.

```ts
import { Console, Effect, Schedule } from "effect"

type InventorySnapshot = unknown

type InventoryError =
  | { readonly _tag: "TransientInventoryError" }
  | { readonly _tag: "InvalidSku" }

declare const callInventory: Effect.Effect<InventorySnapshot, InventoryError>

const policy = Schedule.exponential("100 millis").pipe(
  Schedule.tapInput((error: InventoryError) => Console.log(`retrying after ${error._tag}`)),
  Schedule.both(Schedule.recurs(4))
)

const program = callInventory.pipe(
  Effect.retry({
    schedule: policy,
    while: (error) => error._tag === "TransientInventoryError"
  })
)
```

Caution: classify permanent failures before applying retry; backoff does not make invalid input transient.

### Observe Retry Output Delays

Write the Effect code for webhook delivery.

```ts
import { Duration, Effect, Schedule } from "effect"

type WebhookError = unknown

declare const sendWebhook: Effect.Effect<void, WebhookError>

declare const Metrics: {
  readonly recordRetryDelay: (delay: Duration.Duration) => Effect.Effect<void>
}

const policy = Schedule.exponential("100 millis").pipe(
  Schedule.tapOutput((delay) => Metrics.recordRetryDelay(delay)),
  Schedule.both(Schedule.recurs(5))
)

const program = sendWebhook.pipe(Effect.retry(policy))
```

Caution: `recurs(n)` counts follow-up recurrences after the first execution.

### Observe Poll Output Statuses

Write the Effect code for a deployment status watcher.

```ts
import { Console, Effect, Schedule } from "effect"

type DeploymentStatusError = unknown

type DeploymentStatus =
  | { readonly _tag: "Queued" }
  | { readonly _tag: "Running" }
  | { readonly _tag: "Complete" }
  | { readonly _tag: "Failed" }

declare const readDeploymentStatus: Effect.Effect<DeploymentStatus, DeploymentStatusError>

const policy = Schedule.spaced("2 seconds").pipe(
  Schedule.setInputType<DeploymentStatus>(),
  Schedule.passthrough,
  Schedule.tapOutput((status) => Console.log(`deployment status: ${status._tag}`)),
  Schedule.while(({ input }) => input._tag === "Queued" || input._tag === "Running")
)

const program = readDeploymentStatus.pipe(Effect.repeat(policy))
```

Caution: raw `Effect.repeat(schedule)` returns the schedule output; `Schedule.passthrough` preserves the latest successful value.

## Runnable Scenario Checks

These examples keep the recipe shape, add small deterministic operations, and use `TestClock` where time must advance.

### Run A Timeout Retry

Use this to check that a retryable timeout is retried and the first success is returned.

```ts runnable deterministic
import { Console, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

type HttpTimeout = { readonly _tag: "HttpTimeout" }
type HttpStatusError = { readonly _tag: "HttpStatusError"; readonly status: number }
type DecodeError = { readonly _tag: "DecodeError" }
type User = { readonly id: string }

const getUser = Effect.fnUntraced(function*(attempts: Ref.Ref<number>) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`getUser attempt ${attempt}`)

  if (attempt < 3) {
    return yield* Effect.fail({ _tag: "HttpTimeout" } as HttpTimeout)
  }

  return { id: "user-123" } satisfies User
})

const isHttpTimeout = (
  error: HttpTimeout | HttpStatusError | DecodeError
): error is HttpTimeout => error._tag === "HttpTimeout"

const retryGetUserTimeouts = Schedule.exponential("10 millis").pipe(
  Schedule.both(Schedule.recurs(3))
)

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)
  const fiber = yield* getUser(attempts).pipe(
    Effect.retry({
      schedule: retryGetUserTimeouts,
      while: isHttpTimeout
    }),
    Effect.forkScoped
  )

  yield* TestClock.adjust("30 millis")
  const user = yield* Fiber.join(fiber)
  yield* Console.log(`loaded ${user.id}`)
})

Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Output:
// getUser attempt 1
// getUser attempt 2
// getUser attempt 3
// loaded user-123
```

### Stop On Permanent Failure

Use this to check that permanent errors do not spend the retry budget.

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type SubmitError =
  | { readonly _tag: "Timeout" }
  | { readonly _tag: "ServiceUnavailable" }
  | { readonly _tag: "ValidationError"; readonly field: string }

const submitForm: Effect.Effect<string, SubmitError> = Effect.gen(function*() {
  yield* Console.log("submit attempt")
  return yield* Effect.fail({ _tag: "ValidationError", field: "email" } as const)
})

const isRetryableSubmitError = (error: SubmitError): boolean =>
  error._tag === "Timeout" || error._tag === "ServiceUnavailable"

const program = submitForm.pipe(
  Effect.retry({
    schedule: Schedule.recurs(3),
    while: isRetryableSubmitError
  }),
  Effect.exit,
  Effect.flatMap((exit) => Console.log(`failed immediately: ${exit._tag === "Failure"}`))
)

Effect.runPromise(program)
// Output:
// submit attempt
// failed immediately: true
```

### Respect Retry-After

Use this to check that a rate-limit response can stretch the selected retry delay.

```ts runnable deterministic
import { Console, Duration, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

type HttpError =
  | { readonly _tag: "RateLimited"; readonly retryAfter: Duration.Duration | undefined }
  | { readonly _tag: "Unauthorized" | "Forbidden" | "BadRequest" | "Unavailable" }

const callApi = Effect.fnUntraced(function*(attempts: Ref.Ref<number>) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`api attempt ${attempt}`)

  if (attempt === 1) {
    return yield* Effect.fail({
      _tag: "RateLimited",
      retryAfter: Duration.seconds(1)
    } as HttpError)
  }

  return "ok"
})

const rateLimitPolicy = Schedule.exponential("10 millis").pipe(
  Schedule.both(Schedule.identity<HttpError>()),
  Schedule.modifyDelay(([_, error], delay) =>
    Effect.succeed(
      error._tag === "RateLimited" && error.retryAfter !== undefined
        ? Duration.max(delay, error.retryAfter)
        : delay
    )
  ),
  Schedule.both(Schedule.recurs(2)),
  Schedule.while(({ input }) => input._tag === "RateLimited")
)

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)
  const fiber = yield* callApi(attempts).pipe(
    Effect.retry(rateLimitPolicy),
    Effect.forkScoped
  )

  yield* TestClock.adjust("999 millis")
  yield* Console.log(`before retry: ${yield* Ref.get(attempts)}`)
  yield* TestClock.adjust("1 millis")
  const result = yield* Fiber.join(fiber)
  yield* Console.log(`result: ${result}`)
})

Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Output:
// api attempt 1
// before retry: 1
// api attempt 2
// result: ok
```

### Reuse An Idempotency Key

Use this to check that a retried write keeps the same logical operation identity.

```ts runnable deterministic
import { Console, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

type Order = { readonly id: string }
type PostOrderError = { readonly _tag: "Timeout" | "InvalidRequest" }

const idempotencyKey = "order-key-123"

const postOrder = Effect.fnUntraced(function*(attempts: Ref.Ref<number>) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`order attempt ${attempt} key=${idempotencyKey}`)

  if (attempt < 2) {
    return yield* Effect.fail({ _tag: "Timeout" } as PostOrderError)
  }

  return { id: "order-1" } satisfies Order
})

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)
  const fiber = yield* postOrder(attempts).pipe(
    Effect.retry({
      schedule: Schedule.spaced("10 millis").pipe(Schedule.both(Schedule.recurs(4))),
      while: (error) => error._tag === "Timeout"
    }),
    Effect.forkScoped
  )

  yield* TestClock.adjust("10 millis")
  const order = yield* Fiber.join(fiber)
  yield* Console.log(`created ${order.id}`)
})

Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Output:
// order attempt 1 key=order-key-123
// order attempt 2 key=order-key-123
// created order-1
```

### Cap Reconnect Backoff

Use this to check that a reconnect policy retries until the socket opens.

```ts runnable deterministic
import { Console, Duration, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

type LiveSocket = { readonly connected: true }
type WebSocketOpenError = { readonly _tag: "ConnectTimeout" | "BadHandshake" }

const openLiveSocket = Effect.fnUntraced(function*(attempts: Ref.Ref<number>) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`socket attempt ${attempt}`)

  if (attempt < 3) {
    return yield* Effect.fail({ _tag: "ConnectTimeout" } as WebSocketOpenError)
  }

  return { connected: true } satisfies LiveSocket
})

const websocketReconnectPolicy = Schedule.exponential("10 millis").pipe(
  Schedule.modifyDelay((_, delay) => Effect.succeed(Duration.min(delay, Duration.seconds(5)))),
  Schedule.both(Schedule.recurs(8))
)

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)
  const fiber = yield* openLiveSocket(attempts).pipe(
    Effect.retry({
      schedule: websocketReconnectPolicy,
      while: (error) => error._tag === "ConnectTimeout"
    }),
    Effect.forkScoped
  )

  yield* TestClock.adjust("30 millis")
  const socket = yield* Fiber.join(fiber)
  yield* Console.log(`connected: ${socket.connected}`)
})

Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Output:
// socket attempt 1
// socket attempt 2
// socket attempt 3
// connected: true
```

### Ask A Circuit Breaker Before Retrying

Use this to check an effectful `while` predicate.

```ts runnable deterministic
import { Console, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

type BillingError =
  | { readonly _tag: "TransientBillingError" }
  | { readonly _tag: "RejectedPayment" }

const callBilling = Effect.fnUntraced(function*(attempts: Ref.Ref<number>) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`billing attempt ${attempt}`)

  if (attempt < 2) {
    return yield* Effect.fail({ _tag: "TransientBillingError" } as BillingError)
  }

  return "receipt"
})

const circuitBreakerAllowsRetry = (error: BillingError): Effect.Effect<boolean> =>
  Console.log(`breaker saw ${error._tag}`).pipe(Effect.as(true))

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)
  const fiber = yield* callBilling(attempts).pipe(
    Effect.retry({
      schedule: Schedule.spaced("10 millis").pipe(Schedule.both(Schedule.recurs(5))),
      while: (error) =>
        error._tag === "TransientBillingError"
          ? circuitBreakerAllowsRetry(error)
          : Effect.succeed(false)
    }),
    Effect.forkScoped
  )

  yield* TestClock.adjust("10 millis")
  const receipt = yield* Fiber.join(fiber)
  yield* Console.log(`result: ${receipt}`)
})

Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Output:
// billing attempt 1
// breaker saw TransientBillingError
// billing attempt 2
// result: receipt
```

### Poll A Job Until Terminal

Use this to check that successful non-terminal states drive `Effect.repeat`.

```ts runnable deterministic
import { Console, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

type JobStatus =
  | { readonly state: "queued"; readonly jobId: string }
  | { readonly state: "running"; readonly jobId: string }
  | { readonly state: "succeeded"; readonly jobId: string; readonly artifactUrl: string }
  | { readonly state: "failed"; readonly jobId: string; readonly reason: string }

const readJobStatus = Effect.fnUntraced(function*(reads: Ref.Ref<number>) {
  const read = yield* Ref.updateAndGet(reads, (n) => n + 1)
  const status: JobStatus = read < 3
    ? { state: "running", jobId: "job-1" }
    : { state: "succeeded", jobId: "job-1", artifactUrl: "/artifact" }
  yield* Console.log(`job ${status.state}`)
  return status
})

const isTerminal = (status: JobStatus): boolean => status.state === "succeeded" || status.state === "failed"

const pollJobStatus = Schedule.spaced("1 second").pipe(
  Schedule.setInputType<JobStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => !isTerminal(input)),
  Schedule.bothLeft(Schedule.during("30 seconds").pipe(Schedule.setInputType<JobStatus>()))
)

const program = Effect.gen(function*() {
  const reads = yield* Ref.make(0)
  const fiber = yield* readJobStatus(reads).pipe(
    Effect.repeat(pollJobStatus),
    Effect.forkScoped
  )

  yield* TestClock.adjust("2 seconds")
  const status = yield* Fiber.join(fiber)
  yield* Console.log(`final ${status.state}`)
})

Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Output:
// job running
// job running
// job succeeded
// final succeeded
```

### Poll Payment Settlement

Use this to check that pending payment states are successes, not retry failures.

```ts runnable deterministic
import { Console, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

type SettlementStatus =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Processing" }
  | { readonly _tag: "Settled" }
  | { readonly _tag: "Declined" }

const fetchSettlementStatus = Effect.fnUntraced(function*(reads: Ref.Ref<number>) {
  const read = yield* Ref.updateAndGet(reads, (n) => n + 1)
  const status: SettlementStatus = read === 1 ? { _tag: "Pending" } : { _tag: "Settled" }
  yield* Console.log(`settlement ${status._tag}`)
  return status
})

const isOpen = (status: SettlementStatus) => status._tag === "Pending" || status._tag === "Processing"

const pollOpenSettlements = Schedule.spaced("1 second").pipe(
  Schedule.setInputType<SettlementStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => isOpen(input)),
  Schedule.bothLeft(Schedule.during("30 seconds"))
)

const program = Effect.gen(function*() {
  const reads = yield* Ref.make(0)
  const fiber = yield* fetchSettlementStatus(reads).pipe(
    Effect.repeat(pollOpenSettlements),
    Effect.forkScoped
  )

  yield* TestClock.adjust("1 second")
  const status = yield* Fiber.join(fiber)
  yield* Console.log(`final ${status._tag}`)
})

Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Output:
// settlement Pending
// settlement Settled
// final Settled
```

### Poll Until A Cache Entry Appears

Use this to check a successful miss-then-hit polling loop.

```ts runnable deterministic
import { Console, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

type CachedValue = string
type CacheLookup =
  | { readonly _tag: "Miss" }
  | { readonly _tag: "Hit"; readonly value: CachedValue }

const readCacheEntry = Effect.fnUntraced(function*(reads: Ref.Ref<number>) {
  const read = yield* Ref.updateAndGet(reads, (n) => n + 1)
  const lookup: CacheLookup = read < 3 ? { _tag: "Miss" } : { _tag: "Hit", value: "cached" }
  yield* Console.log(`cache ${lookup._tag}`)
  return lookup
})

const untilCacheHit = Schedule.spaced("500 millis").pipe(
  Schedule.setInputType<CacheLookup>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input._tag === "Miss"),
  Schedule.bothLeft(Schedule.during("10 seconds"))
)

const program = Effect.gen(function*() {
  const reads = yield* Ref.make(0)
  const fiber = yield* readCacheEntry(reads).pipe(
    Effect.repeat(untilCacheHit),
    Effect.forkScoped
  )

  yield* TestClock.adjust("1 second")
  const lookup = yield* Fiber.join(fiber)
  yield* Console.log(`final ${lookup._tag}`)
})

Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Output:
// cache Miss
// cache Miss
// cache Hit
// final Hit
```

### Return A Timeout Result From Polling

Use this to check that an exhausted polling budget is interpreted after `repeat`.

```ts runnable deterministic
import { Console, Effect, Fiber, Schedule } from "effect"
import { TestClock } from "effect/testing"

type Status =
  | { readonly _tag: "Running" }
  | { readonly _tag: "Finished"; readonly value: string }

const readStatus: Effect.Effect<Status> = Console.log("status Running").pipe(
  Effect.as({ _tag: "Running" } as Status)
)

const polling = Schedule.spaced("1 second").pipe(
  Schedule.setInputType<Status>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input._tag === "Running"),
  Schedule.bothLeft(Schedule.recurs(1))
)

const program = Effect.gen(function*() {
  const fiber = yield* readStatus.pipe(
    Effect.repeat(polling),
    Effect.flatMap((status) =>
      status._tag === "Running"
        ? Effect.fail({ _tag: "TimedOut", latest: status } as const)
        : Effect.succeed(status)
    ),
    Effect.exit,
    Effect.forkScoped
  )

  yield* TestClock.adjust("1 second")
  const exit = yield* Fiber.join(fiber)
  yield* Console.log(`timed out: ${exit._tag === "Failure"}`)
})

Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Output:
// status Running
// status Running
// timed out: true
```

### Poll Fast, Then Slow

Use this to check phased polling with `andThen`.

```ts runnable deterministic
import { Console, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

type WorkflowStatus = { readonly step: number }

const readWorkflowStatus = Effect.fnUntraced(function*(reads: Ref.Ref<number>) {
  const step = yield* Ref.updateAndGet(reads, (n) => n + 1)
  yield* Console.log(`workflow ${step}`)
  return { step } satisfies WorkflowStatus
})

const fastThenSlow = Schedule.spaced("250 millis").pipe(
  Schedule.bothLeft(Schedule.recurs(2))
)
const slowPolling = Schedule.spaced("2 seconds")
const polling = fastThenSlow.pipe(
  Schedule.andThen(slowPolling),
  Schedule.setInputType<WorkflowStatus>(),
  Schedule.passthrough,
  Schedule.bothLeft(Schedule.recurs(3).pipe(Schedule.setInputType<WorkflowStatus>()))
)

const program = Effect.gen(function*() {
  const reads = yield* Ref.make(0)
  const fiber = yield* readWorkflowStatus(reads).pipe(
    Effect.repeat(polling),
    Effect.forkScoped
  )

  yield* TestClock.adjust("3 seconds")
  const status = yield* Fiber.join(fiber)
  yield* Console.log(`final step ${status.step}`)
})

Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Output:
// workflow 1
// workflow 2
// workflow 3
// workflow 4
// final step 4
```

### Repeat A Background Sync

Use this to check that `passthrough` returns the latest successful sync summary.

```ts runnable deterministic
import { Console, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

type SyncSummary = { readonly pass: number }

const syncCrmOnce = Effect.fnUntraced(function*(passes: Ref.Ref<number>) {
  const pass = yield* Ref.updateAndGet(passes, (n) => n + 1)
  yield* Console.log(`sync ${pass}`)
  return { pass } satisfies SyncSummary
})

const crmSyncCadence = Schedule.spaced("5 minutes").pipe(
  Schedule.setInputType<SyncSummary>(),
  Schedule.passthrough,
  Schedule.bothLeft(Schedule.recurs(2).pipe(Schedule.setInputType<SyncSummary>()))
)

const program = Effect.gen(function*() {
  const passes = yield* Ref.make(0)
  const fiber = yield* syncCrmOnce(passes).pipe(
    Effect.repeat(crmSyncCadence),
    Effect.forkScoped
  )

  yield* TestClock.adjust("10 minutes")
  const summary = yield* Fiber.join(fiber)
  yield* Console.log(`latest ${summary.pass}`)
})

Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Output:
// sync 1
// sync 2
// sync 3
// latest 3
```

### Repeat A Repair Pass A Few Times

Use this to check `Schedule.take` on a spaced repeat cadence.

```ts runnable deterministic
import { Console, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

const reprocessFailedBatch = Effect.fnUntraced(function*(passes: Ref.Ref<number>) {
  const pass = yield* Ref.updateAndGet(passes, (n) => n + 1)
  yield* Console.log(`repair pass ${pass}`)
})

const reprocessingCadence = Schedule.spaced("30 seconds").pipe(
  Schedule.take(3)
)

const program = Effect.gen(function*() {
  const passes = yield* Ref.make(0)
  const fiber = yield* reprocessFailedBatch(passes).pipe(
    Effect.repeat(reprocessingCadence),
    Effect.forkScoped
  )

  yield* TestClock.adjust("90 seconds")
  yield* Fiber.join(fiber)
  yield* Console.log(`passes ${yield* Ref.get(passes)}`)
})

Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Output:
// repair pass 1
// repair pass 2
// repair pass 3
// repair pass 4
// passes 4
```

### Slow A Worker Loop

Use this to check that successful worker iterations leave a gap.

```ts runnable deterministic
import { Console, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

type WorkerIteration =
  | { readonly _tag: "Processed"; readonly count: number }
  | { readonly _tag: "Idle" }

const workerIteration = Effect.fnUntraced(function*(iterations: Ref.Ref<number>) {
  const iteration = yield* Ref.updateAndGet(iterations, (n) => n + 1)
  const result: WorkerIteration = iteration === 1 ? { _tag: "Processed", count: 1 } : { _tag: "Idle" }
  yield* Console.log(`worker ${result._tag}`)
  return result
})

const workerCadence = Schedule.spaced("500 millis").pipe(
  Schedule.take(2)
)

const program = Effect.gen(function*() {
  const iterations = yield* Ref.make(0)
  const fiber = yield* workerIteration(iterations).pipe(
    Effect.repeat(workerCadence),
    Effect.forkScoped
  )

  yield* TestClock.adjust("1 second")
  yield* Fiber.join(fiber)
  yield* Console.log(`iterations ${yield* Ref.get(iterations)}`)
})

Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Output:
// worker Processed
// worker Idle
// worker Idle
// iterations 3
```

### Run One Follow-Up

Use this to check `Schedule.duration` for exactly one additional run.

```ts runnable deterministic
import { Console, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

const warmCache = Effect.fnUntraced(function*(runs: Ref.Ref<number>) {
  const run = yield* Ref.updateAndGet(runs, (n) => n + 1)
  yield* Console.log(`warm ${run}`)
})

const oneMoreRun = Schedule.duration("10 seconds")

const program = Effect.gen(function*() {
  const runs = yield* Ref.make(0)
  const fiber = yield* warmCache(runs).pipe(
    Effect.repeat(oneMoreRun),
    Effect.forkScoped
  )

  yield* TestClock.adjust("10 seconds")
  yield* Fiber.join(fiber)
  yield* Console.log(`runs ${yield* Ref.get(runs)}`)
})

Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Output:
// warm 1
// warm 2
// runs 2
```

### Repeat Until A Terminal Value With Options

Use this to check the options-form `until` predicate.

```ts runnable deterministic
import { Console, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

type TransferStatus =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "InProgress" }
  | { readonly _tag: "Completed" }
  | { readonly _tag: "Failed" }

const readTransferStatus = Effect.fnUntraced(function*(reads: Ref.Ref<number>) {
  const read = yield* Ref.updateAndGet(reads, (n) => n + 1)
  const status: TransferStatus = read < 2
    ? { _tag: "InProgress" }
    : read === 2
    ? { _tag: "Completed" }
    : { _tag: "Failed" }
  yield* Console.log(`transfer ${status._tag}`)
  return status
})

const program = Effect.gen(function*() {
  const reads = yield* Ref.make(0)
  const fiber = yield* readTransferStatus(reads).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status._tag === "Completed" || status._tag === "Failed"
    }),
    Effect.forkScoped
  )

  yield* TestClock.adjust("1 second")
  const status = yield* Fiber.join(fiber)
  yield* Console.log(`final ${status._tag}`)
})

Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Output:
// transfer InProgress
// transfer Completed
// final Completed
```

### Repeat Until An Effectful Predicate Stops

Use this to check an effectful `until` predicate that records every successful result.

```ts runnable deterministic
import { Console, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

type ServiceProbeResult =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Failed" }

const probeService = Effect.fnUntraced(function*(reads: Ref.Ref<number>) {
  const read = yield* Ref.updateAndGet(reads, (n) => n + 1)
  const result: ServiceProbeResult = read < 2
    ? { _tag: "Starting" }
    : read === 2
    ? { _tag: "Ready" }
    : { _tag: "Failed" }
  yield* Console.log(`probe ${result._tag}`)
  return result
})

const recordReadinessProbe = (result: ServiceProbeResult): Effect.Effect<void> => Console.log(`recorded ${result._tag}`)

const program = Effect.gen(function*() {
  const reads = yield* Ref.make(0)
  const fiber = yield* probeService(reads).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second").pipe(
        Schedule.both(Schedule.recurs(30))
      ),
      until: (result) =>
        recordReadinessProbe(result).pipe(
          Effect.map(() => result._tag === "Ready" || result._tag === "Failed")
        )
    }),
    Effect.forkScoped
  )

  yield* TestClock.adjust("1 second")
  const result = yield* Fiber.join(fiber)
  yield* Console.log(`final ${result._tag}`)
})

Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Output:
// probe Starting
// recorded Starting
// probe Ready
// recorded Ready
// final Ready
```

### Observe Retry Input And Output

Use this to check schedule diagnostics without changing retry behavior.

```ts runnable deterministic
import { Console, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

type InventoryError =
  | { readonly _tag: "TransientInventoryError" }
  | { readonly _tag: "InvalidSku" }

const fetchInventory = Effect.fnUntraced(function*(attempts: Ref.Ref<number>) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`inventory attempt ${attempt}`)

  if (attempt < 2) {
    return yield* Effect.fail({ _tag: "TransientInventoryError" } as InventoryError)
  }

  return ["sku-1"]
})

const retryInventoryPolicy = Schedule.exponential("10 millis").pipe(
  Schedule.both(Schedule.recurs(5)),
  Schedule.tapInput((error: InventoryError) => Console.log(`retry input: ${error._tag}`)),
  Schedule.tapOutput(([_, count]) => Console.log(`retry scheduled: ${count}`))
)

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)
  const fiber = yield* fetchInventory(attempts).pipe(
    Effect.retry({
      schedule: retryInventoryPolicy,
      while: (error) => error._tag === "TransientInventoryError"
    }),
    Effect.forkScoped
  )

  yield* TestClock.adjust("10 millis")
  const items = yield* Fiber.join(fiber)
  yield* Console.log(`items ${items.length}`)
})

Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Output:
// inventory attempt 1
// retry input: TransientInventoryError
// retry scheduled: 0
// inventory attempt 2
// items 1
```

### Log Retry Counts With `bothRight`

Use this to check that `bothRight` keeps the recurrence count as output.

```ts runnable deterministic
import { Console, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

type UploadError =
  | { readonly _tag: "TransientUploadError" }
  | { readonly _tag: "InvalidUpload" }

const uploadChunk = Effect.fnUntraced(function*(attempts: Ref.Ref<number>) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`upload attempt ${attempt}`)

  if (attempt < 3) {
    return yield* Effect.fail({ _tag: "TransientUploadError" } as UploadError)
  }
})

const policy = Schedule.exponential("10 millis").pipe(
  Schedule.bothRight(Schedule.recurs(4)),
  Schedule.tapOutput((count) => Console.log(`retry count ${count}`))
)

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)
  const fiber = yield* uploadChunk(attempts).pipe(
    Effect.retry({
      schedule: policy,
      while: (error) => error._tag === "TransientUploadError"
    }),
    Effect.forkScoped
  )

  yield* TestClock.adjust("30 millis")
  yield* Fiber.join(fiber)
  yield* Console.log(`done after ${yield* Ref.get(attempts)}`)
})

Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Output:
// upload attempt 1
// retry count 0
// upload attempt 2
// retry count 1
// upload attempt 3
// done after 3
```

## Timing Checks

Use `TestClock` when the timing behavior itself is the recipe contract. Fork the repeated or retried program,
advance virtual time, then check the result.

The examples fork the program because the program is waiting for time to pass. While the fiber is suspended, `TestClock.adjust` moves virtual time forward. `Fiber.join` then waits for the forked program to finish after the expected retries or repeats have run.

### Assert Retry Delay

Use when a retry policy must not run before its configured delay.

```ts runnable deterministic
import { Console, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

const ensure = (condition: boolean, message: string) => condition ? Effect.void : Effect.fail(new Error(message))

const retryPolicy = Schedule.spaced("100 millis").pipe(
  Schedule.both(Schedule.recurs(2))
)

const operation = Effect.fnUntraced(function*(attempts: Ref.Ref<number>) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`attempt ${attempt}`)

  if (attempt < 3) {
    return yield* Effect.fail("transient" as const)
  }

  return "ok" as const
})

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)
  const fiber = yield* operation(attempts).pipe(
    Effect.retry(retryPolicy),
    Effect.forkScoped
  )

  yield* Effect.yieldNow
  yield* TestClock.adjust("99 millis")
  yield* ensure((yield* Ref.get(attempts)) === 1, "retry ran too early")

  yield* TestClock.adjust("1 millis")
  yield* ensure((yield* Ref.get(attempts)) === 2, "first retry did not run")

  yield* TestClock.adjust("100 millis")
  const result = yield* Fiber.join(fiber)
  yield* ensure(result === "ok", "retry did not succeed")
  yield* Console.log(`result: ${result}`)
})

Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Output:
// attempt 1
// attempt 2
// attempt 3
// result: ok
```

### Assert Fixed Cadence

Use when the repeat policy should stay on aligned intervals instead of waiting after each run completes.

```ts runnable deterministic
import { Console, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

const ensure = (condition: boolean, message: string) => condition ? Effect.void : Effect.fail(new Error(message))

const heartbeatCadence = Schedule.fixed("1 second").pipe(
  Schedule.take(2)
)

const heartbeat = Effect.fnUntraced(function*(ticks: Ref.Ref<number>) {
  const tick = yield* Ref.updateAndGet(ticks, (n) => n + 1)
  yield* Console.log(`heartbeat ${tick}`)
})

const program = Effect.gen(function*() {
  const ticks = yield* Ref.make(0)
  const fiber = yield* heartbeat(ticks).pipe(
    Effect.repeat(heartbeatCadence),
    Effect.forkScoped
  )

  yield* Effect.yieldNow
  yield* TestClock.adjust("1 second")
  yield* TestClock.adjust("1 second")
  yield* Fiber.join(fiber)
  yield* ensure((yield* Ref.get(ticks)) === 3, "expected one initial run and two fixed recurrences")
})

Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Output:
// heartbeat 1
// heartbeat 2
// heartbeat 3
```

### Assert Windowed Cadence

Use when the repeat policy should recur on wall-clock windows.

```ts runnable deterministic
import { Console, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

const ensure = (condition: boolean, message: string) => condition ? Effect.void : Effect.fail(new Error(message))

const flushWindow = Schedule.windowed("1 minute").pipe(
  Schedule.take(2)
)

const flushMetrics = Effect.fnUntraced(function*(flushes: Ref.Ref<number>) {
  const flush = yield* Ref.updateAndGet(flushes, (n) => n + 1)
  yield* Console.log(`flush ${flush}`)
})

const program = Effect.gen(function*() {
  yield* TestClock.setTime(0)
  const flushes = yield* Ref.make(0)
  const fiber = yield* flushMetrics(flushes).pipe(
    Effect.repeat(flushWindow),
    Effect.forkScoped
  )

  yield* Effect.yieldNow
  yield* TestClock.adjust("1 minute")
  yield* TestClock.adjust("1 minute")
  yield* Fiber.join(fiber)
  yield* ensure((yield* Ref.get(flushes)) === 3, "expected one initial flush and two windowed recurrences")
})

Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Output:
// flush 1
// flush 2
// flush 3
```

### Assert Cron Cadence

Use when the repeat policy should recur at times selected by a cron expression.

```ts runnable deterministic
import { Console, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

const ensure = (condition: boolean, message: string) => condition ? Effect.void : Effect.fail(new Error(message))

const nightly = Schedule.cron("0 2 * * *").pipe(
  Schedule.take(1)
)

const compactDatabase = Effect.fnUntraced(function*(runs: Ref.Ref<number>) {
  const run = yield* Ref.updateAndGet(runs, (n) => n + 1)
  yield* Console.log(`compaction ${run}`)
})

const program = Effect.gen(function*() {
  yield* TestClock.setTime(new Date(2024, 0, 1, 1, 59, 59).getTime())
  const runs = yield* Ref.make(0)
  const fiber = yield* compactDatabase(runs).pipe(
    Effect.repeat(nightly),
    Effect.forkScoped
  )

  yield* Effect.yieldNow
  yield* TestClock.adjust("1 second")
  yield* Fiber.join(fiber)
  yield* ensure((yield* Ref.get(runs)) === 2, "expected initial run and one cron recurrence")
})

Effect.runPromise(program.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Output:
// compaction 1
// compaction 2
```

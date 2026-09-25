---
name: maple-kotlin-style
description: "Kotlin (Ktor, Spring Boot) OpenTelemetry style for Maple: zero-code Java agent or manual SDK with OTLP HTTP exporters, inline endpoint + ingest key, semconv resource attributes, OTLP-bridged logs."
---

# Maple Kotlin style

Kotlin runs on the JVM, so the same OpenTelemetry Java agent and SDK apply. Prefer the agent for Spring Boot / Ktor servers; fall back to the manual SDK only for native-image or sealed-module builds.

## Zero-code: Java agent (recommended)

```bash
curl -sLO https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar

java \
  -javaagent:./opentelemetry-javaagent.jar \
  -Dotel.service.name=orders-api \
  -Dotel.exporter.otlp.protocol=http/protobuf \
  -Dotel.exporter.otlp.endpoint=https://ingest.maple.dev \
  -Dotel.exporter.otlp.headers="authorization=Bearer MAPLE_TEST" \
  -Dotel.resource.attributes="vcs.repository.url.full=https://github.com/acme/orders-api,vcs.ref.head.revision=${GITHUB_SHA:-}" \
  -jar build/libs/app.jar
```

Replace `MAPLE_TEST` with the project's real Maple ingest key once it exists. EU organizations use `https://ingest.eu.maple.dev` as the endpoint. Keep these flags inline where the JVM is launched (`Procfile`, `Dockerfile`, or `JAVA_TOOL_OPTIONS`). Do not move them behind unset env vars. The agent does not read `application.yml`.

The agent auto-instruments Ktor, Spring Boot (MVC, WebFlux), kotlinx.coroutines context propagation, JDBC (so Exposed), R2DBC, Kafka, gRPC, OkHttp, AWS SDK, and more.

## Manual SDK (Ktor, no agent)

```kotlin
val MAPLE_ENDPOINT = "https://ingest.maple.dev" // EU: https://ingest.eu.maple.dev
val MAPLE_KEY = "MAPLE_TEST" // set by maple-onboard skill on pairing

fun initTelemetry(): OpenTelemetrySdk {
    val headers = mapOf("authorization" to "Bearer $MAPLE_KEY")
    val resource = Resource.getDefault().merge(Resource.create(
        Attributes.builder()
            .put("service.name", "orders-api")
            .put("deployment.environment.name",
                System.getenv("DEPLOYMENT_ENV") ?: "development")
            .put("vcs.repository.url.full", "https://github.com/acme/orders-api")
            .put("vcs.ref.head.revision", System.getenv("GITHUB_SHA") ?: "")
            .build()))

    val spanExporter = OtlpHttpSpanExporter.builder()
        .setEndpoint("$MAPLE_ENDPOINT/v1/traces")
        .setHeaders { headers }
        .build()

    return OpenTelemetrySdk.builder()
        .setTracerProvider(SdkTracerProvider.builder()
            .addSpanProcessor(BatchSpanProcessor.builder(spanExporter).build())
            .setResource(resource)
            .build())
        .buildAndRegisterGlobal()
}
```

Add the equivalent log and metric exporters in the same builder. Resolve versions through `io.opentelemetry:opentelemetry-bom`.

## Bounded business spans

```kotlin
private val tracer = GlobalOpenTelemetry.getTracer("orders.api")

suspend fun submitOrder(orderId: String, tenantId: String) {
    val span = tracer.spanBuilder("order.submit")
        .setAttribute("tenant.id", tenantId)
        .setAttribute("order.id", orderId)
        .startSpan()
    try {
        withContext(span.asContextElement()) {
            chargeOrder(orderId)
        }
    } catch (e: Exception) {
        span.recordException(e)
        span.setStatus(StatusCode.ERROR, e.message ?: "")
        throw e
    } finally {
        span.end()
    }
}
```

`asContextElement()` comes from `io.opentelemetry:opentelemetry-extension-kotlin` (`import io.opentelemetry.extension.kotlin.asContextElement`). Do not call `span.makeCurrent()` in a `suspend` function: the scope is thread-local and leaks or is lost when the coroutine resumes on another thread.

## Logs

Bridge whatever the project uses (Logback, SLF4J, Log4j2). With the agent, Logback and Log4j2 are bridged automatically. With the manual SDK, add `opentelemetry-logback-appender-1.0` (or `opentelemetry-log4j-appender-2.17`), declare its appender in `logback.xml`, and call `OpenTelemetryAppender.install(sdk)` after building the SDK. Existing logger calls then carry `trace_id` / `span_id` and reach Maple. Do not replace the user's existing logger.

## Coexistence

If the project runs a Datadog, New Relic, or Honeycomb agent, leave it in place. Two bytecode agents on one JVM can conflict, so test the combination once before shipping.

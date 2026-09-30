---
name: maple-java-style
description: "Java OpenTelemetry style for Maple: zero-code Java agent or manual SDK with OTLP HTTP exporters, inline endpoint, ingest key from MAPLE_INGEST_KEY, semconv resource attributes, OTLP-bridged Logback / SLF4J logs."
---

# Maple Java style

The fastest path is the OpenTelemetry Java agent. It auto-instruments the JVM with no code changes.

## Zero-code: Java agent

```bash
curl -sLO https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar
```

Inline the endpoint as a JVM system property. The key goes in the `OTEL_EXPORTER_OTLP_HEADERS` environment variable, built from `MAPLE_INGEST_KEY` (the private key) so it never appears in the `java` command line. The agent appends `/v1/traces`, `/v1/logs`, and `/v1/metrics` to the base endpoint:

```bash
# A missing key disables export; it never stops the launch.
if [ -n "${MAPLE_INGEST_KEY:-}" ]; then
  export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer ${MAPLE_INGEST_KEY}"
else
  echo "MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled" >&2
  export OTEL_SDK_DISABLED=true
fi
java \
  -javaagent:./opentelemetry-javaagent.jar \
  -Dotel.service.name=orders-api \
  -Dotel.exporter.otlp.protocol=http/protobuf \
  -Dotel.exporter.otlp.endpoint=https://ingest.maple.dev \
  -Dotel.resource.attributes="vcs.repository.url.full=https://github.com/acme/orders-api,vcs.ref.head.revision=${GITHUB_SHA:-}" \
  -jar build/libs/app.jar
```

EU organizations use `https://ingest.eu.maple.dev` as the endpoint. Keep the flags where the JVM is launched (`Procfile`, entrypoint script, `systemd` unit, or `JAVA_TOOL_OPTIONS`); the `export` line needs a shell, so a Dockerfile uses an entrypoint script or shell-form `CMD`. Without the key the app still starts: the script prints one warning and sets `OTEL_SDK_DISABLED=true`, so the agent sends nothing and no request goes out with an empty bearer. The agent does not read Spring's `application.yml`.

The agent auto-instruments Spring (Boot, MVC, WebFlux), Servlet containers, Apache HttpClient, OkHttp, JDBC, R2DBC, Hibernate, Kafka, gRPC, AWS SDK, and many more.

## Manual SDK (when the agent isn't an option)

Where the agent can't run (GraalVM native image, embedded JVM, sealed module path), use the SDK directly. Import `io.opentelemetry:opentelemetry-bom` and `io.opentelemetry.instrumentation:opentelemetry-instrumentation-bom-alpha` in `<dependencyManagement>` so the artifacts below resolve without explicit versions:

```xml
<dependency>
  <groupId>io.opentelemetry</groupId>
  <artifactId>opentelemetry-api</artifactId>
</dependency>
<dependency>
  <groupId>io.opentelemetry</groupId>
  <artifactId>opentelemetry-sdk</artifactId>
</dependency>
<dependency>
  <groupId>io.opentelemetry</groupId>
  <artifactId>opentelemetry-exporter-otlp</artifactId>
</dependency>
<dependency>
  <groupId>io.opentelemetry.instrumentation</groupId>
  <artifactId>opentelemetry-logback-appender-1.0</artifactId>
</dependency>
```

```java
public final class Telemetry {
    private static final String MAPLE_ENDPOINT = "https://ingest.maple.dev"; // EU: https://ingest.eu.maple.dev

    public static OpenTelemetrySdk init() {
        var key = System.getenv("MAPLE_INGEST_KEY"); // private ingest key (maple_sk_…), a secret
        if (key == null || key.isEmpty()) {
            // A missing key disables export; it never stops the app.
            System.err.println("MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled");
            return OpenTelemetrySdk.builder().build(); // no exporter, nothing sent
        }
        var headers = Map.of("authorization", "Bearer " + key);
        var resource = Resource.getDefault().merge(Resource.create(Attributes.builder()
            .put("service.name", "orders-api")
            .put("deployment.environment.name",
                System.getenv().getOrDefault("DEPLOYMENT_ENV", "development"))
            .put("vcs.repository.url.full", "https://github.com/acme/orders-api")
            .put("vcs.ref.head.revision", System.getenv().getOrDefault("GITHUB_SHA", ""))
            .build()));

        var spanExporter = OtlpHttpSpanExporter.builder()
            .setEndpoint(MAPLE_ENDPOINT + "/v1/traces")
            .setHeaders(() -> headers)
            .build();
        // … same shape for OtlpHttpLogRecordExporter and OtlpHttpMetricExporter

        var sdk = OpenTelemetrySdk.builder()
            .setTracerProvider(SdkTracerProvider.builder()
                .addSpanProcessor(BatchSpanProcessor.builder(spanExporter).build())
                .setResource(resource)
                .build())
            .buildAndRegisterGlobal();
        OpenTelemetryAppender.install(sdk); // Logback bridge, see Logs
        return sdk;
    }
}
```

## Logs

Bridge the existing Logback / SLF4J / Log4j2 setup through OTLP. Do not replace it. With the Java agent, Logback and Log4j2 are bridged automatically. With the manual SDK, add `opentelemetry-logback-appender-1.0` (or `opentelemetry-log4j-appender-2.17`), declare `io.opentelemetry.instrumentation.logback.appender.v1_0.OpenTelemetryAppender` in `logback.xml`, and call `OpenTelemetryAppender.install(sdk)` after building the SDK. Existing logger calls then carry `trace_id` / `span_id` and reach Maple.

## Bounded business spans

Acquire the tracer at class scope. Wrap operations the agent's auto-instrumentation can't see.

```java
private static final Tracer TRACER = GlobalOpenTelemetry.getTracer("orders.api");

public Order submit(String orderId, String tenantId) {
    var span = TRACER.spanBuilder("order.submit")
        .setAttribute("tenant.id", tenantId)
        .setAttribute("order.id", orderId)
        .startSpan();
    try (var scope = span.makeCurrent()) {
        return charge(orderId);
    } catch (Exception e) {
        span.recordException(e);
        span.setStatus(StatusCode.ERROR, e.getMessage());
        throw e;
    } finally {
        span.end();
    }
}
```

## Coexistence

If the project already runs a Datadog, New Relic, or Honeycomb agent, leave it in place. Two bytecode agents on one JVM can conflict, so test the combination once before shipping. Do not strip an incumbent agent unless the user asks.

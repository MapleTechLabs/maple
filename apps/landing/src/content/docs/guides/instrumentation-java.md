---
title: "Java instrumentation"
description: "Instrument a Java application with OpenTelemetry and send traces, logs, and metrics to Maple."
group: "Instrumentation"
order: 10
navLabel: "Java"
sdk: "java"
---

This guide attaches the OpenTelemetry Java agent to your application so it sends traces, logs and metrics to Maple. The agent instruments most popular libraries without code changes. A manual SDK setup is covered further down for runtimes where you cannot attach an agent.

To have a coding agent do this setup, use the [maple-onboard](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-onboard) skill, and [maple-audit](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-audit) to check an existing setup.

## Prerequisites

- Java 8+
- An ingest key from **Settings → Ingestion** in Maple. Use the private key (`maple_sk_…`) for server applications.

## Install

Download the agent jar from the [opentelemetry-java-instrumentation releases](https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases):

```bash
curl -L -o opentelemetry-javaagent.jar \
  https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar
```

## Configure

Start your application with the agent attached and Maple's endpoint configured:

```bash
java \
  -javaagent:opentelemetry-javaagent.jar \
  -Dotel.service.name=my-java-app \
  -Dotel.exporter.otlp.endpoint=https://ingest.maple.dev \
  -Dotel.exporter.otlp.protocol=http/protobuf \
  -Dotel.exporter.otlp.headers="Authorization=Bearer YOUR_INGEST_KEY" \
  -Dotel.resource.attributes="deployment.environment.name=production,vcs.repository.url.full=https://github.com/acme/my-java-app" \
  -jar app.jar
```

For an EU organization, use `https://ingest.eu.maple.dev`. The endpoint is the base URL: the agent appends `/v1/traces`, `/v1/logs` and `/v1/metrics` itself.

The agent (version 2.x) exports traces, metrics and logs over OTLP by default, so there is no separate metrics or logs setup. `http/protobuf` is already its default protocol. Setting it explicitly does no harm and documents what you expect.

## Environment variables

Every `-Dotel.*` property has an environment variable equivalent, which suits containers:

```bash
export JAVA_TOOL_OPTIONS="-javaagent:/opt/opentelemetry-javaagent.jar"
export OTEL_SERVICE_NAME="my-java-app"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production,vcs.repository.url.full=https://github.com/acme/my-java-app"
```

## Auto-instrumentation

The agent instruments Spring (MVC, WebFlux, Boot), servlet containers, JDBC, gRPC, Kafka, JMS, the AWS SDK and [many more libraries](https://github.com/open-telemetry/opentelemetry-java-instrumentation/blob/main/docs/supported-libraries.md). Each incoming request becomes a server span, and JDBC queries and outgoing HTTP calls become child spans. The agent also reports JVM runtime metrics such as memory, garbage collection and thread counts.

## Manual SDK setup

Use this when you cannot attach the agent, for example in GraalVM native images or restricted runtimes.

### Install dependencies

Gradle:

```kotlin
implementation(platform("io.opentelemetry:opentelemetry-bom:1.51.0"))
implementation("io.opentelemetry:opentelemetry-api")
implementation("io.opentelemetry:opentelemetry-sdk")
implementation("io.opentelemetry:opentelemetry-exporter-otlp")
```

Maven:

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>io.opentelemetry</groupId>
      <artifactId>opentelemetry-bom</artifactId>
      <version>1.51.0</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependencies>
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
</dependencies>
```

### Configure the SDK

```java
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.propagation.ContextPropagators;
import io.opentelemetry.exporter.otlp.http.logs.OtlpHttpLogRecordExporter;
import io.opentelemetry.exporter.otlp.http.metrics.OtlpHttpMetricExporter;
import io.opentelemetry.exporter.otlp.http.trace.OtlpHttpSpanExporter;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.logs.SdkLoggerProvider;
import io.opentelemetry.sdk.logs.export.BatchLogRecordProcessor;
import io.opentelemetry.sdk.metrics.SdkMeterProvider;
import io.opentelemetry.sdk.metrics.export.PeriodicMetricReader;
import io.opentelemetry.sdk.resources.Resource;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.export.BatchSpanProcessor;

public final class Telemetry {
    private static final String MAPLE_ENDPOINT = "https://ingest.maple.dev"; // EU: https://ingest.eu.maple.dev
    private static final String MAPLE_AUTH = "Bearer YOUR_INGEST_KEY";

    public static OpenTelemetry init() {
        Resource resource = Resource.getDefault().merge(Resource.create(Attributes.builder()
            .put("service.name", "my-java-app")
            .put("deployment.environment.name", System.getenv().getOrDefault("DEPLOYMENT_ENV", "development"))
            .put("vcs.repository.url.full", "https://github.com/acme/my-java-app")
            .build()));

        SdkTracerProvider tracerProvider = SdkTracerProvider.builder()
            .setResource(resource)
            .addSpanProcessor(BatchSpanProcessor.builder(OtlpHttpSpanExporter.builder()
                .setEndpoint(MAPLE_ENDPOINT + "/v1/traces")
                .addHeader("Authorization", MAPLE_AUTH)
                .build()).build())
            .build();

        SdkMeterProvider meterProvider = SdkMeterProvider.builder()
            .setResource(resource)
            .registerMetricReader(PeriodicMetricReader.builder(OtlpHttpMetricExporter.builder()
                .setEndpoint(MAPLE_ENDPOINT + "/v1/metrics")
                .addHeader("Authorization", MAPLE_AUTH)
                .build()).build())
            .build();

        SdkLoggerProvider loggerProvider = SdkLoggerProvider.builder()
            .setResource(resource)
            .addLogRecordProcessor(BatchLogRecordProcessor.builder(OtlpHttpLogRecordExporter.builder()
                .setEndpoint(MAPLE_ENDPOINT + "/v1/logs")
                .addHeader("Authorization", MAPLE_AUTH)
                .build()).build())
            .build();

        OpenTelemetrySdk sdk = OpenTelemetrySdk.builder()
            .setTracerProvider(tracerProvider)
            .setMeterProvider(meterProvider)
            .setLoggerProvider(loggerProvider)
            .setPropagators(ContextPropagators.create(W3CTraceContextPropagator.getInstance()))
            .buildAndRegisterGlobal();

        Runtime.getRuntime().addShutdownHook(new Thread(sdk::close));
        return sdk;
    }
}
```

The example puts the endpoint and key in source. An ingest key can only write telemetry to your organization. It cannot read data or call the Maple API. Keeping it in source means the SDK always starts with a complete configuration, so a deploy that is missing an environment variable cannot silently turn telemetry off.

Call `Telemetry.init()` once, first thing in `main`. Without the agent, library spans come from the [library instrumentation](https://github.com/open-telemetry/opentelemetry-java-instrumentation/blob/main/docs/supported-libraries.md) packages you add yourself.

## Custom spans

```java
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Scope;

private static final Tracer tracer = GlobalOpenTelemetry.getTracer("my-app");

public void processOrder(String orderId) {
    Span span = tracer.spanBuilder("process-order").startSpan();
    try (Scope scope = span.makeCurrent()) {
        span.setAttribute("order.id", orderId);
        span.setAttribute("payment.method", "card");
        chargePayment(orderId);
    } catch (Exception e) {
        span.recordException(e);
        span.setStatus(StatusCode.ERROR, e.getMessage());
        throw e;
    } finally {
        span.end();
    }
}
```

Service map edges come from instrumented client spans that propagate `traceparent` to an instrumented callee, not from attributes such as `peer.service`. See [Service map](/docs/explore/service-map). With the agent, `opentelemetry-api` is the only dependency this code needs.

## Log correlation

With the agent, Logback, Log4j2 and JUL records are exported as OpenTelemetry log records with the active trace and span IDs, so Maple links each log line to its trace. The agent also puts `trace_id` and `span_id` into the MDC if you want them in your console output:

```xml
<!-- logback.xml -->
<encoder>
    <pattern>%d{HH:mm:ss.SSS} [%thread] %-5level %logger{36} trace_id=%X{trace_id} span_id=%X{span_id} - %msg%n</pattern>
</encoder>
```

With the manual SDK, add the `opentelemetry-logback-appender-1.0` library, register its `OpenTelemetryAppender` in `logback.xml`, and call `OpenTelemetryAppender.install(openTelemetry)` after `Telemetry.init()`.

## Spring Boot

Spring Boot works with the agent as shown above. For GraalVM native images, use the [OpenTelemetry Spring Boot starter](https://opentelemetry.io/docs/zero-code/java/spring-boot-starter/) instead. It reads the same `otel.*` properties from `application.properties` or the environment:

```kotlin
implementation(platform("io.opentelemetry.instrumentation:opentelemetry-instrumentation-bom:2.16.0"))
implementation("io.opentelemetry.instrumentation:opentelemetry-spring-boot-starter")
```

## Verify

1. Start your application and send it a few requests.
2. In Maple, open **Explore → Traces**. The agent sends spans in batches every 5 seconds by default, and metrics every 60 seconds.
3. Each request should show up as one trace with a single root server span, named after the method and route (for example `GET /api/orders`), and child spans for the queries and outgoing calls it made.

Your service also appears on the **Services** page once its first spans arrive.

## Troubleshooting

- **`401` responses.** The key is wrong, was copied from the other region, or the header is malformed. The header must be `Authorization: Bearer YOUR_INGEST_KEY`. In `otel.exporter.otlp.headers` it is written `Authorization=Bearer YOUR_INGEST_KEY`. See [Ingest API status codes](/docs/reference/ingest#status-codes).
- **Wrong protocol or path.** Maple's [ingest API](/docs/reference/ingest) is OTLP over HTTP, so keep `otel.exporter.otlp.protocol` at `http/protobuf`. The agent endpoint is the base URL, while `setEndpoint` in the manual SDK takes the full signal path (`/v1/traces`).
- **Network.** From the machine running the app, run `curl -i https://ingest.maple.dev/v1/traces -X POST`. Any HTTP status code means the host can reach Maple. A timeout or DNS error means a firewall or proxy is blocking outbound HTTPS.
- **Nothing exported.** Check the startup log for a line from the OpenTelemetry agent; if it is missing, the `-javaagent` flag is not reaching the JVM. Add `-Dotel.javaagent.debug=true` to print spans and export errors.

## Next steps

- [Explore traces](/docs/explore/traces)
- [Track errors](/docs/errors/overview)
- [Create alert rules](/docs/alerting/alert-rules)
- [OpenTelemetry conventions](/docs/concepts/otel-conventions)

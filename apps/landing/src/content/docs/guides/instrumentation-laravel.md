---
title: "Laravel instrumentation"
description: "Instrument a Laravel application with OpenTelemetry and send traces, logs, and metrics to Maple."
group: "Instrumentation"
order: 13
navLabel: "Laravel"
sdk: "laravel"
---

This guide instruments a Laravel application with the [`keepsuit/laravel-opentelemetry`](https://github.com/keepsuit/laravel-opentelemetry) package, which hooks OpenTelemetry into Laravel's HTTP kernel, database, queue, cache and logging, and sends traces, logs and metrics to Maple.

To have a coding agent do this setup, use the [maple-onboard](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-onboard) skill, and [maple-audit](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-audit) to check an existing setup.

## Prerequisites

- PHP 8.2+ and Laravel 11.31 or later (the versions the current package release supports)
- Composer
- An ingest key from **Settings → Ingestion** in Maple. Use the private key (`maple_sk_…`) for server applications.

## Install

```bash
composer require keepsuit/laravel-opentelemetry
```

Publish the config file so you can turn individual instrumentations on and off later:

```bash
php artisan vendor:publish \
  --provider="Keepsuit\LaravelOpenTelemetry\LaravelOpenTelemetryServiceProvider" \
  --tag="opentelemetry-config"
```

The package pulls in the OpenTelemetry PHP SDK and OTLP exporter, and registers its middleware and instrumentation through a service provider.

## Configure

The package reads the standard OpenTelemetry environment variables and exports traces, metrics and logs over OTLP by default. Point them at Maple's ingest endpoint with your ingest key:

```env
# .env
OTEL_SERVICE_NAME=my-laravel-app

OTEL_TRACES_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp

OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"

OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production,vcs.repository.url.full=https://github.com/acme/my-laravel-app"
```

For an EU organization, use `https://ingest.eu.maple.dev`. The endpoint is the base URL; the exporters append `/v1/traces`, `/v1/metrics` and `/v1/logs`.

The package applies `OTEL_EXPORTER_OTLP_HEADERS` to every signal. If you run an older release that ignores it, set `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, `OTEL_EXPORTER_OTLP_METRICS_HEADERS` and `OTEL_EXPORTER_OTLP_LOGS_HEADERS` to the same value.

An ingest key can only write telemetry to your organization. It cannot read data or call the Maple API. Still keep it in `.env` or your secret store rather than in committed config.

### `http/protobuf` or `http/json`

Maple accepts both encodings. The difference is on the PHP side:

- `http/protobuf` needs a protobuf implementation. The pure-PHP `google/protobuf` library works but is slow. For production, install the protobuf C extension (`pecl install protobuf`, then `extension=protobuf.so`).
- `http/json` needs no extension. If protobuf export fails in your environment, for example in a minimal Laravel Sail container, set `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`.

## Auto-instrumentation

Once installed, the package creates telemetry for:

- **HTTP requests:** a server span per incoming request, and the `http.server.request.duration` metric
- **HTTP client:** a client span for each request made with the `Http` facade, with the trace context propagated to the service you call, and the `http.client.request.duration` metric
- **Database:** a span per Eloquent or query builder statement, and the `db.client.operation.duration` metric
- **Queue jobs:** producer and consumer spans, with context carried across the queue
- **Redis:** commands
- **Cache:** hits and misses, recorded as span events
- **Views and Livewire components:** a span per render
- **Console commands:** a span per run, for the commands you list in the `ConsoleInstrumentation` config
- **Events:** recorded as span events, with configurable exclusions

Each instrumentation can be turned off with its `OTEL_INSTRUMENTATION_*` variable (for example `OTEL_INSTRUMENTATION_QUERY=false`) or in the published `config/opentelemetry.php`.

## Custom spans

Use the `Tracer` facade. `measure()` starts the span, makes it the active span while the callback runs, and ends it:

```php
use Keepsuit\LaravelOpenTelemetry\Facades\Tracer;

Tracer::newSpan('process-order')
    ->setAttributes([
        'order.id' => $orderId,
        'payment.method' => 'card',
    ])
    ->measure(fn () => $this->chargePayment($orderId));
```

To record an exception or set the status yourself, start and activate the span by hand. The span has the OpenTelemetry PHP API (`setAttribute`, `recordException`, `setStatus`):

```php
use Keepsuit\LaravelOpenTelemetry\Facades\Tracer;
use OpenTelemetry\API\Trace\StatusCode;

$span = Tracer::newSpan('process-order')->start();
$scope = $span->activate();

try {
    return $this->chargePayment($orderId);
} catch (\Throwable $e) {
    $span->recordException($e);
    $span->setStatus(StatusCode::STATUS_ERROR, $e->getMessage());
    throw $e;
} finally {
    $scope->detach();
    $span->end();
}
```

Service map edges come from instrumented client spans that propagate `traceparent` to an instrumented callee, not from attributes such as `peer.service`. See [Service map](/docs/explore/service-map). The facade also has `Tracer::traceId()`, `Tracer::activeSpan()` and `Tracer::propagationHeaders()` for correlating logs and propagating context by hand.

For custom metrics, use the `Meter` facade:

```php
use Keepsuit\LaravelOpenTelemetry\Facades\Meter;

Meter::counter('orders.processed', 'orders', 'Orders processed')->add(1);
```

## Log correlation

The package adds a log channel named `otlp` that sends log records to Maple with the active trace ID attached. Route logs to it with `LOG_CHANNEL=otlp`, or add it to a stack so logs also keep going to your files:

```php
// config/logging.php
'channels' => [
    'stack' => [
        'driver' => 'stack',
        'channels' => ['single', 'otlp'],
    ],
],
```

Logs then line up with the trace that produced them in Maple.

## Local mode and Docker (Laravel Sail)

To send to [Maple Local](/docs/local-mode) running on your host, the exporter inside the Sail container must reach back to the host. Maple Local binds `127.0.0.1` by default, which a container cannot reach, so start it on all interfaces:

```bash
maple start --host 0.0.0.0
```

A non-loopback bind exposes ingest, the UI and queries to your network without authentication, so do this only on a trusted network. See the [CLI reference](/docs/reference/cli#maple-start).

Then point the exporter at `host.docker.internal` and the OTLP/HTTP port `4318`:

```env
# .env (Sail container sending to Maple Local on the host)
OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
```

- Maple Local needs no `Authorization` header, so drop the headers variable.
- On Linux hosts where `host.docker.internal` does not resolve, add `extra_hosts: ["host.docker.internal:host-gateway"]` to the service in `docker-compose.yml`.

## Verify

1. Start your application and send it a few requests, or dispatch a queued job.
2. In Maple, open **Explore → Traces**. If nothing appears after a minute, see [Troubleshooting](#troubleshooting).
3. Each request should show up as one trace with a single root server span, named after the method and route (for example `GET /orders`), and child spans for the queries and jobs it triggered.
4. If you routed logs to the `otlp` channel, open **Explore → Logs** and check that log lines link to their traces.

Your service also appears on the **Services** page once its first spans arrive.

## Troubleshooting

- **`401` responses.** The key is wrong, was copied from the other region, or the header is malformed. `OTEL_EXPORTER_OTLP_HEADERS` takes `Authorization=Bearer YOUR_INGEST_KEY`. See [Ingest API status codes](/docs/reference/ingest#status-codes).
- **Protocol.** Maple accepts OTLP over HTTP as protobuf or JSON. If exports fail with protobuf errors, switch to `http/json`, or install the protobuf extension.
- **Network.** From inside the container or server, run `curl -i https://ingest.maple.dev/v1/traces -X POST`. Any HTTP status code means the host can reach Maple. A timeout or DNS error means a firewall or proxy is blocking outbound HTTPS.
- **Nothing exported.** Run `php artisan config:clear` after changing `.env`; a cached config keeps the old values. Check that `OTEL_SDK_DISABLED` is not set to `true`.

## Next steps

- [Explore traces](/docs/explore/traces)
- [Track errors](/docs/errors/overview)
- [Create alert rules](/docs/alerting/alert-rules)
- [OpenTelemetry conventions](/docs/concepts/otel-conventions)

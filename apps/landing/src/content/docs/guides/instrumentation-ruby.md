---
title: "Ruby instrumentation"
description: "Instrument a Ruby or Rails application with OpenTelemetry and send traces to Maple."
group: "Instrumentation"
order: 14
navLabel: "Ruby"
sdk: "ruby"
---

This guide sets up the OpenTelemetry Ruby SDK so your Rails, Sinatra or plain Ruby application sends traces to Maple, with instrumentation for Rails, Active Record, Sidekiq, Net::HTTP and the other libraries in `opentelemetry-instrumentation-all`.

To have a coding agent do this setup, use the [maple-onboard](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-onboard) skill, and [maple-audit](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-audit) to check an existing setup.

## Prerequisites

- Ruby 3.3+ (the version current releases of `opentelemetry-sdk` require)
- Bundler
- An ingest key from **Settings → Ingestion** in Maple. Use the private key (`maple_sk_…`) for server applications.

## Install

Add the SDK, the OTLP exporter and the instrumentation bundle to your `Gemfile`:

```ruby
# Gemfile
gem "opentelemetry-sdk"
gem "opentelemetry-exporter-otlp"
gem "opentelemetry-instrumentation-all"
```

```bash
bundle install
```

`opentelemetry-instrumentation-all` pulls in the instrumentation for every library it supports. Each one only turns on when its library is loaded, so unused ones cost nothing.

## Configure Rails

Create an initializer. It runs in every Rails process, including the console, runners and Sidekiq workers:

```ruby
# config/initializers/opentelemetry.rb
require "opentelemetry/sdk"
require "opentelemetry/exporter/otlp"
require "opentelemetry/instrumentation/all"

OpenTelemetry::SDK.configure do |c|
  c.service_name = "my-rails-app"
  c.use_all
end
```

`use_all` enables every installed instrumentation: Rails (Action Pack, Action View, Active Record, Active Job, Active Support), Rack, Net::HTTP, Faraday, `pg`, `mysql2`, Redis, Sidekiq and more. Each request becomes a server span, named after the method and route, with child spans for the queries and outgoing calls it made.

The batch span processor restarts its export thread after a fork, so Puma in cluster mode and other forking servers need no extra setup.

## Environment variables

The SDK and the exporter read the standard variables, so the endpoint and key stay out of source:

```bash
export OTEL_SERVICE_NAME="my-rails-app"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production,vcs.repository.url.full=https://github.com/acme/my-rails-app"
```

EU organizations use `https://ingest.eu.maple.dev`. The exporter appends `/v1/traces` to the endpoint itself. `OTEL_SERVICE_NAME` overrides the `service_name` set in the initializer, so you can drop that line once the variable is set everywhere.

The Ruby exporter speaks OTLP over HTTP with protobuf encoding only. Leave `OTEL_EXPORTER_OTLP_PROTOCOL` unset or set it to `http/protobuf`; with `grpc` the SDK logs a warning and exports nothing. To compress batches, set `OTEL_EXPORTER_OTLP_COMPRESSION=gzip`.

## Sinatra and plain Ruby

Outside Rails, configure the SDK before your app is defined. For Sinatra, add `gem "sinatra"` as usual and put the setup at the top of the app file or in `config.ru`:

```ruby
# app.rb
require "opentelemetry/sdk"
require "opentelemetry/exporter/otlp"
require "opentelemetry/instrumentation/all"

OpenTelemetry::SDK.configure do |c|
  c.use_all
end

require "sinatra"

get "/hello" do
  "hello"
end
```

For a script or a one-off job, create your own spans and shut the provider down before exit, so the last batch is sent:

```ruby
require "opentelemetry/sdk"
require "opentelemetry/exporter/otlp"

OpenTelemetry::SDK.configure
at_exit { OpenTelemetry.tracer_provider.shutdown }

tracer = OpenTelemetry.tracer_provider.tracer("nightly-import")

tracer.in_span("import-orders") do |span|
  span.set_attribute("import.source", "s3")
  import_orders
end
```

## Sidekiq

With the Rails initializer, Sidekiq needs no extra setup: the Sidekiq server process loads Rails and runs the initializer, and `use_all` enables the Sidekiq instrumentation. Each enqueue becomes a producer span and each job run a consumer span.

By default the job's span starts a new trace and links back to the span that enqueued it. To make the job a child of the request that enqueued it, so both appear in one trace, set `propagation_style` to `:child`:

```ruby
OpenTelemetry::SDK.configure do |c|
  c.use_all({
    "OpenTelemetry::Instrumentation::Sidekiq" => { propagation_style: :child },
  })
end
```

Long-running jobs that enqueue many others make very large traces with `:child`, so keep the default for those.

## Custom spans

```ruby
class ProcessOrder
  TRACER = OpenTelemetry.tracer_provider.tracer("my-rails-app")

  def call(order_id)
    TRACER.in_span("process-order") do |span|
      span.set_attribute("order.id", order_id)
      span.set_attribute("payment.method", "card")
      charge_payment(order_id)
    end
  end
end
```

`in_span` records any exception raised inside the block on the span, sets its status to error and re-raises. To mark a failure you handle yourself, call `span.record_exception(e)` and `span.status = OpenTelemetry::Trace::Status.error(e.message)`.

Service map edges come from instrumented client spans that propagate `traceparent` to an instrumented callee, not from attributes such as `peer.service`. See [Service map](/docs/explore/service-map).

## Attributes Maple uses

Most attributes are optional. These unlock specific features.

### Commits and GitHub

Set `vcs.ref.head.revision` (the full 40-character commit SHA) and `vcs.repository.url.full` on the resource. They drive deploy markers, the Releases page and, with the [GitHub integration](/docs/integrations/github), commit hover cards on traces. Read the SHA from your CI or host at build time, such as `GITHUB_SHA` or `HEROKU_SLUG_COMMIT`, not from `git` at runtime:

```bash
export OTEL_RESOURCE_ATTRIBUTES="vcs.repository.url.full=https://github.com/acme/api,vcs.ref.head.revision=$GITHUB_SHA"
```

### Databases

The `pg`, `mysql2` and `trilogy` instrumentations set the standard `db.*` attributes for you. The database system and name draw the database node on the [service map](/docs/explore/service-map), and the query text groups statements into query shapes. The `pg` and `mysql2` instrumentations obfuscate literal values in the query text by default; keep that on. See [Database queries](/docs/concepts/otel-conventions#database-queries) for the full list.

## Logs and metrics

The Ruby SDK's trace support is stable. Its metrics and logs SDKs (`opentelemetry-metrics-sdk`, `opentelemetry-logs-sdk` and their OTLP exporters) are still experimental, and their APIs can change between releases. This guide covers traces only. If you try the experimental exporters, they use the same endpoint and headers.

## Verify

1. Start your application and send it a few requests, or enqueue a Sidekiq job.
2. In Maple, open **Explore → Traces**. The SDK sends spans in batches every 5 seconds by default.
3. Each request should show up as one trace with a single root server span, named after the method and route (for example `GET /orders/:id` on Rails 7.1 and later), and child spans for the queries and outgoing calls it made.

Your service also appears on the **Services** page once its first spans arrive.

## Troubleshooting

- **`401` responses.** The key is wrong, was copied from the other region, or the header is malformed. `OTEL_EXPORTER_OTLP_HEADERS` takes `Authorization=Bearer YOUR_INGEST_KEY`. See [Ingest API status codes](/docs/reference/ingest#status-codes).
- **`The grpc transport protocol is not supported` in the log.** `OTEL_EXPORTER_OTLP_PROTOCOL` is set to `grpc`, often inherited from a shared environment. Unset it or set `http/protobuf`.
- **`please add opentelemetry-exporter-otlp to your Gemfile` in the log.** The exporter gem is missing from the bundle, so spans are not exported.
- **Network.** From the machine running the app, run `curl -i https://ingest.maple.dev/v1/traces -X POST`. Any HTTP status code means the host can reach Maple. A timeout or DNS error means a firewall or proxy is blocking outbound HTTPS.
- **Nothing exported.** Set `OTEL_LOG_LEVEL=debug` to print the SDK's export errors. For a quick local check, set `OTEL_TRACES_EXPORTER=console` to print spans to stdout instead of sending them. Scripts that exit right away must call `OpenTelemetry.tracer_provider.shutdown` first.

## Next steps

- [Explore traces](/docs/explore/traces)
- [Track errors](/docs/errors/overview)
- [Create alert rules](/docs/alerting/alert-rules)
- [OpenTelemetry conventions](/docs/concepts/otel-conventions)

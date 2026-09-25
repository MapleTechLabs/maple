---
title: "Python instrumentation"
description: "Instrument a Python application with OpenTelemetry and send traces, logs, and metrics to Maple."
group: "Instrumentation"
order: 7
navLabel: "Python"
sdk: "python"
---

This guide sets up the OpenTelemetry Python SDK so your application sends traces, logs and metrics to Maple, with instrumentation for FastAPI, Django, Flask and common client libraries.

To have a coding agent do this setup, use the [maple-onboard](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-onboard) skill, and [maple-audit](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-audit) to check an existing setup.

## Prerequisites

- Python 3.9+
- An ingest key from **Settings → Ingestion** in Maple. Use the private key (`maple_sk_…`) for server applications.

## Install

```bash
pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
```

## Configure

Create a `telemetry.py` module that sets up traces, metrics and logs:

```python
# telemetry.py
import logging
import os

from opentelemetry import metrics, trace
from opentelemetry._logs import set_logger_provider
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

MAPLE_ENDPOINT = "https://ingest.maple.dev"  # EU: https://ingest.eu.maple.dev
MAPLE_KEY = "YOUR_INGEST_KEY"
HEADERS = {"authorization": f"Bearer {MAPLE_KEY}"}

resource = Resource.create({
    "service.name": "my-python-app",
    "deployment.environment.name": os.getenv("DEPLOYMENT_ENV", "development"),
    "vcs.repository.url.full": "https://github.com/acme/my-python-app",
    "vcs.ref.head.revision": os.getenv("GITHUB_SHA") or os.getenv("GIT_COMMIT", ""),
})

# Traces
tracer_provider = TracerProvider(resource=resource)
tracer_provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{MAPLE_ENDPOINT}/v1/traces", headers=HEADERS))
)
trace.set_tracer_provider(tracer_provider)

# Metrics
metric_reader = PeriodicExportingMetricReader(
    OTLPMetricExporter(endpoint=f"{MAPLE_ENDPOINT}/v1/metrics", headers=HEADERS)
)
metrics.set_meter_provider(MeterProvider(resource=resource, metric_readers=[metric_reader]))

# Logs: records from the standard logging module go to Maple
logger_provider = LoggerProvider(resource=resource)
logger_provider.add_log_record_processor(
    BatchLogRecordProcessor(OTLPLogExporter(endpoint=f"{MAPLE_ENDPOINT}/v1/logs", headers=HEADERS))
)
set_logger_provider(logger_provider)
logging.getLogger().addHandler(LoggingHandler(logger_provider=logger_provider))
```

The example puts the endpoint and key in source. An ingest key can only write telemetry to your organization. It cannot read data or call the Maple API. Keeping it in source means the SDK always starts with a complete configuration, so a deploy that is missing an environment variable cannot silently turn telemetry off. To keep the key out of source, use [environment variables](#environment-variables) instead.

Import the module first thing at startup, before the modules you want traced:

```python
import telemetry  # noqa: F401  (sets up OpenTelemetry)
from myapp import create_app

app = create_app()
```

## Environment variables

Without any code, the `opentelemetry-instrument` wrapper configures the SDK from the standard environment variables and instruments every supported library it finds. Install the distro and exporter, then install the instrumentation packages that match your dependencies:

```bash
pip install opentelemetry-distro opentelemetry-exporter-otlp-proto-http
opentelemetry-bootstrap -a install
```

Set the variables and start your app through the wrapper:

```bash
export OTEL_SERVICE_NAME="my-python-app"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_TRACES_EXPORTER="otlp"
export OTEL_METRICS_EXPORTER="otlp"
export OTEL_LOGS_EXPORTER="otlp"
export OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED="true"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production,vcs.repository.url.full=https://github.com/acme/my-python-app"

opentelemetry-instrument python app.py
```

`OTEL_EXPORTER_OTLP_PROTOCOL` matters here: the distro defaults to gRPC, which needs a different exporter package. `OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED` attaches the log exporter to the standard `logging` module. Use either this path or `telemetry.py`, not both.

## Auto-instrumentation

With `telemetry.py`, install the instrumentation package for each library you use and enable it in code. Each incoming request becomes a server span, and outgoing HTTP calls and database queries become child spans.

### FastAPI

```bash
pip install opentelemetry-instrumentation-fastapi
```

```python
import telemetry  # noqa: F401
from fastapi import FastAPI
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

app = FastAPI()
FastAPIInstrumentor.instrument_app(app)
```

### Django

```bash
pip install opentelemetry-instrumentation-django
```

```python
# manage.py and wsgi.py / asgi.py, before Django loads
import telemetry  # noqa: F401
from opentelemetry.instrumentation.django import DjangoInstrumentor

DjangoInstrumentor().instrument()
```

Database queries need the instrumentation for your driver, for example `opentelemetry-instrumentation-psycopg2` or `opentelemetry-instrumentation-sqlite3`.

### Flask and HTTP clients

```bash
pip install opentelemetry-instrumentation-flask \
  opentelemetry-instrumentation-requests \
  opentelemetry-instrumentation-httpx
```

```python
from opentelemetry.instrumentation.flask import FlaskInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.instrumentation.requests import RequestsInstrumentor

FlaskInstrumentor().instrument_app(app)
RequestsInstrumentor().instrument()
HTTPXClientInstrumentor().instrument()
```

The HTTP client instrumentations propagate trace context, so the services you call join the same trace.

## Custom spans

```python
from opentelemetry import trace
from opentelemetry.trace import StatusCode

tracer = trace.get_tracer("my-app")

def process_order(order_id: str):
    with tracer.start_as_current_span("process-order") as span:
        span.set_attribute("order.id", order_id)
        span.set_attribute("payment.method", "card")

        try:
            return charge_payment(order_id)
        except Exception as e:
            span.record_exception(e)
            span.set_status(StatusCode.ERROR, str(e))
            raise
```

Service map edges come from instrumented client spans that propagate `traceparent` to an instrumented callee, not from attributes such as `peer.service`. See [Service map](/docs/explore/service-map).

## Log correlation

`telemetry.py` attaches a `LoggingHandler` to the root logger. Records logged during an active span carry its trace and span IDs, so Maple links each log line to its trace:

```python
import logging

logging.getLogger(__name__).warning("Payment retry for order %s", order_id)
```

The root logger's level still applies. Python defaults it to `WARNING`, so call `logging.basicConfig(level=logging.INFO)` or set the level yourself to send `INFO` records.

## Verify

1. Start your application and send it a few requests.
2. In Maple, open **Explore → Traces**. The SDK sends spans in batches every 5 seconds by default, and metrics every 60 seconds.
3. Each request should show up as one trace with a single root server span, named after the method and route (for example `GET /api/orders`), and child spans for the queries and outgoing calls it made.

Your service also appears on the **Services** page once its first spans arrive.

## Troubleshooting

- **`401` responses.** The key is wrong, was copied from the other region, or the header is malformed. The header must be `Authorization: Bearer YOUR_INGEST_KEY`. In `OTEL_EXPORTER_OTLP_HEADERS` it is written `Authorization=Bearer YOUR_INGEST_KEY`. See [Ingest API status codes](/docs/reference/ingest#status-codes).
- **Wrong protocol or path.** Maple accepts OTLP over HTTP. Use `opentelemetry-exporter-otlp-proto-http`, and set `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` when using `opentelemetry-instrument`. Endpoints set in code need the full signal path (`/v1/traces`); `OTEL_EXPORTER_OTLP_ENDPOINT` takes only the base URL.
- **Network.** From the machine running the app, run `curl -i https://ingest.maple.dev/v1/traces -X POST`. Any HTTP status code means the host can reach Maple. A timeout or DNS error means a firewall or proxy is blocking outbound HTTPS.
- **Nothing exported.** Import `telemetry` before the framework. With gunicorn or uWSGI worker processes, set up the SDK in each worker (for example in gunicorn's `post_fork` hook), because batch processor threads do not survive a fork. A short script can exit before its batch is sent; call `tracer_provider.shutdown()`, `logger_provider.shutdown()` and the meter provider's `shutdown()` before exit.

## Next steps

- [Explore traces](/docs/explore/traces)
- [Track errors](/docs/errors/overview)
- [Create alert rules](/docs/alerting/alert-rules)
- [OpenTelemetry conventions](/docs/concepts/otel-conventions)

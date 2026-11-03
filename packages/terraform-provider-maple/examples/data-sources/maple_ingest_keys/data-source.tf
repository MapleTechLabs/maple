data "maple_ingest_keys" "this" {}

# Hand the private key to a service's OpenTelemetry exporter.
resource "kubernetes_secret" "otel" {
  metadata { name = "maple-ingest" }
  data = { MAPLE_INGEST_KEY = data.maple_ingest_keys.this.private_key }
}

resource "maple_scrape_target" "node_exporter" {
  name                    = "node-exporter"
  url                     = "https://metrics.example.com/metrics"
  scrape_interval_seconds = 30
  auth_type               = "bearer"
  auth_credentials        = var.metrics_token
  service_name            = "infra"
}

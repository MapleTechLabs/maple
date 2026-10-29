resource "time_rotating" "quarterly" {
  rotation_days = 90
}

resource "maple_api_key" "grafana" {
  name   = "grafana-readonly"
  scopes = ["dashboards:read", "traces:read", "metrics:read"]
  # Changing this rolls the key: the old key is revoked and a new one issued.
  rotate = time_rotating.quarterly.id
}

output "grafana_key" {
  value     = maple_api_key.grafana.secret
  sensitive = true
}

resource "maple_uptime_monitor" "api" {
  name = "Public API"
  config = jsonencode({
    type   = "http"
    url    = "https://api.example.com/health"
    method = "GET"
    assertions = [
      { type = "status", op = "is", value = "2xx" },
      { type = "latency", under_ms = 1000 },
    ]
  })
  interval_seconds = 60
  failures_to_down = 2
  service_name     = "api"
  destination_ids  = [maple_alert_destination.pagerduty.id]
}

# A heartbeat: your job pings heartbeat_url, Maple alerts when it stops.
resource "maple_uptime_monitor" "nightly_backup" {
  name = "Nightly backup"
  config = jsonencode({
    type          = "heartbeat"
    schedule      = { type = "cron", expression = "0 3 * * *", timezone = "Europe/Berlin" }
    grace_seconds = 900
  })
  destination_ids = [maple_alert_destination.pagerduty.id]
}

output "backup_heartbeat_url" {
  value = maple_uptime_monitor.nightly_backup.heartbeat_url
}

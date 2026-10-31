resource "maple_alert_rule" "checkout_errors" {
  name            = "Checkout error rate"
  signal_type     = "error_rate"
  comparator      = "gt"
  severity        = "critical"
  threshold       = 0.05 # error rates are 0 to 1 ratios
  window_minutes  = 5
  service_names   = ["checkout"]
  tags            = ["checkout"]
  destination_ids = [maple_alert_destination.pagerduty.id]
  notes           = "Runbook: https://wiki.example.com/checkout"
}

# Warn early, page later: one rule, two tiers.
resource "maple_alert_rule" "checkout_latency" {
  name           = "Checkout p95 latency"
  signal_type    = "p95_latency"
  comparator     = "gt"
  window_minutes = 10
  service_names  = ["checkout"]
  thresholds = jsonencode([
    { severity = "warning", value = 800, destination_ids = [maple_alert_destination.team_email.id] },
    { severity = "critical", value = 2000, destination_ids = [maple_alert_destination.pagerduty.id] },
  ])
}

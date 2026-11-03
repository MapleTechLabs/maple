resource "maple_alert_destination" "pagerduty" {
  type            = "pagerduty"
  name            = "Primary on-call"
  integration_key = var.pagerduty_integration_key
}

resource "maple_alert_destination" "webhook" {
  type           = "webhook"
  name           = "Incident bot"
  url            = "https://hooks.example.com/maple"
  signing_secret = var.webhook_signing_secret
}

resource "maple_alert_destination" "team_email" {
  type            = "email"
  name            = "Checkout team"
  member_user_ids = ["user_2abc…"]
}

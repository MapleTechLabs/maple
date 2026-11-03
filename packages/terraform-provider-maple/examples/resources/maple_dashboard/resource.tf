resource "maple_dashboard" "checkout" {
  name        = "Checkout"
  description = "Golden signals for the checkout flow"
  tags        = ["checkout"]
  time_range  = jsonencode({ type = "relative", value = "12h" })

  # Widget documents in the v2 wire shape. Build the dashboard in Maple once,
  # then copy them from `terraform import` or GET /v2/dashboards/{id}.
  widgets = jsonencode([
    {
      id            = "error-rate"
      visualization = "chart"
      data_source   = { kind = "route", endpoint = "traces_timeseries" }
      display       = { title = "Error rate" }
      layout        = { x = 0, y = 0, w = 6, h = 4 }
    },
  ])
}

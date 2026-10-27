package provider

import (
	"fmt"
	"regexp"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	"github.com/hashicorp/terraform-plugin-go/tfprotov6"
	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

var factories = map[string]func() (tfprotov6.ProviderServer, error){
	"maple": providerserver.NewProtocol6WithError(New("test")()),
}

func providerBlock(api *fakeAPI) string {
	return fmt.Sprintf(`
provider "maple" {
  api_url = %q
  api_key = "maple_ak_test"
}
`, api.server.URL)
}

func TestDashboardLifecycle(t *testing.T) {
	api := newFakeAPI(t)
	widgets := `widgets = jsonencode([
    { id = "w1", visualization = "chart", layout = { x = 0, y = 0, w = 6, h = 4 } },
  ])`
	configWith := func(name, description, widgets string) string {
		desc := ""
		if description != "" {
			desc = fmt.Sprintf("description = %q", description)
		}
		return providerBlock(api) + fmt.Sprintf(`
resource "maple_dashboard" "ops" {
  name = %q
  %s
  tags = ["production"]
  %s
}
`, name, desc, widgets)
	}
	config := func(name, description string) string { return configWith(name, description, widgets) }
	var firstID string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories,
		Steps: []resource.TestStep{
			{
				Config: config("Operations", "Golden signals"),
				Check: resource.ComposeTestCheckFunc(
					resource.TestMatchResourceAttr("maple_dashboard.ops", "id", regexp.MustCompile(`^dash_`)),
					// The API's default, unset in config, is read back.
					resource.TestCheckResourceAttr("maple_dashboard.ops", "time_range", `{"type":"relative","value":"12h"}`),
					captureID("maple_dashboard.ops", &firstID),
				),
			},
			{
				// Removing the description clears it with an explicit null.
				Config: config("Operations v2", ""),
				Check: resource.ComposeTestCheckFunc(
					resource.TestCheckResourceAttr("maple_dashboard.ops", "name", "Operations v2"),
					resource.TestCheckNoResourceAttr("maple_dashboard.ops", "description"),
					func(*terraform.State) error {
						body := api.lastBody("PATCH", "/v2/dashboards/")
						if v, ok := body["description"]; !ok || v != nil {
							return fmt.Errorf("PATCH body should clear description, got %v", body)
						}
						return nil
					},
					sameID("maple_dashboard.ops", &firstID),
				),
			},
			{
				// A widget edited in the UI shows up as drift and is put back.
				PreConfig: func() {
					api.mutate("/v2/dashboards/"+firstID, func(obj map[string]any) {
						obj["widgets"] = []any{map[string]any{"id": "w1", "visualization": "table"}}
					})
				},
				Config: config("Operations v2", ""),
				ConfigPlanChecks: resource.ConfigPlanChecks{
					PreApply: []plancheck.PlanCheck{plancheck.ExpectResourceAction("maple_dashboard.ops", plancheck.ResourceActionUpdate)},
				},
			},
			{
				// Removing widgets empties the list with [], which the API accepts.
				Config: configWith("Operations v2", "", ""),
				Check: resource.ComposeTestCheckFunc(
					resource.TestCheckNoResourceAttr("maple_dashboard.ops", "widgets"),
					func(*terraform.State) error {
						body := api.lastBody("PATCH", "/v2/dashboards/")
						if w, ok := body["widgets"].([]any); !ok || len(w) != 0 {
							return fmt.Errorf("PATCH should send widgets = [], got %v", body)
						}
						return nil
					},
				),
			},
			{
				ResourceName: "maple_dashboard.ops",
				ImportState:  true,
				// jsonencode output and the imported canonical JSON are byte-identical.
				ImportStateVerify: true,
			},
		},
		CheckDestroy: func(*terraform.State) error {
			if api.count("DELETE", "/v2/dashboards/") != 1 {
				return fmt.Errorf("expected one DELETE")
			}
			return nil
		},
	})
}

func TestAlertRuleWithDestination(t *testing.T) {
	api := newFakeAPI(t)
	config := func(notes string) string {
		n := ""
		if notes != "" {
			n = fmt.Sprintf("notes = %q", notes)
		}
		return providerBlock(api) + fmt.Sprintf(`
resource "maple_alert_destination" "oncall" {
  type           = "webhook"
  name           = "On-call"
  url            = "https://hooks.example.com/maple"
  signing_secret = "s3cret"
}

resource "maple_alert_rule" "errors" {
  name            = "Checkout error rate"
  severity        = "critical"
  signal_type     = "error_rate"
  comparator      = "gt"
  threshold       = 0.05
  window_minutes  = 5
  service_names   = ["checkout"]
  tags            = ["checkout", "tier-1"]
  destination_ids = [maple_alert_destination.oncall.id]
  %s
}
`, n)
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories,
		Steps: []resource.TestStep{
			{
				Config: config("Page the checkout team"),

				Check: resource.ComposeTestCheckFunc(
					// Write-only: kept from config though the API never echoes it.
					resource.TestCheckResourceAttr("maple_alert_destination.oncall", "url", "https://hooks.example.com/maple"),
					resource.TestCheckResourceAttr("maple_alert_destination.oncall", "enabled", "true"),
					resource.TestCheckResourceAttrPair("maple_alert_rule.errors", "destination_ids.0", "maple_alert_destination.oncall", "id"),
					resource.TestCheckResourceAttr("maple_alert_rule.errors", "consecutive_breaches_required", "2"),
					resource.TestCheckResourceAttr("maple_alert_rule.errors", "thresholds", `[{"destination_ids":["dest_1"],"recovery_value":null,"severity":"critical","upper":null,"value":0.05}]`),
					func(*terraform.State) error {
						body := api.lastBody("POST", "/v2/alerts/destinations")
						if body["signing_secret"] != "s3cret" || body["url"] != "https://hooks.example.com/maple" {
							return fmt.Errorf("destination create body missing channel fields: %v", body)
						}
						return nil
					},
				),
			},
			{
				Config: config(""),
				Check: func(*terraform.State) error {
					body := api.lastBody("PATCH", "/v2/alerts/rules/")
					if v, ok := body["notes"]; !ok || v != nil {
						return fmt.Errorf("PATCH should clear notes, got %v", body)
					}
					return nil
				},
			},
			{
				ResourceName:      "maple_alert_rule.errors",
				ImportState:       true,
				ImportStateVerify: true,
			},
		},
	})
}

func TestAlertRuleRejectsUppercaseTags(t *testing.T) {
	api := newFakeAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories,
		Steps: []resource.TestStep{{
			Config: providerBlock(api) + `
resource "maple_alert_rule" "r" {
  name           = "r"
  signal_type    = "throughput"
  comparator     = "lt"
  window_minutes = 5
  tags           = ["Checkout"]
}
`,
			ExpectError: regexp.MustCompile(`Tag must be lowercase`),
		}},
	})
}

func TestApiKeyRotateAndRevoke(t *testing.T) {
	api := newFakeAPI(t)
	config := func(rotate string) string {
		return providerBlock(api) + fmt.Sprintf(`
resource "maple_api_key" "ci" {
  name   = "ci"
  scopes = ["dashboards:read"]
  rotate = %q
}
`, rotate)
	}
	var firstID, firstSecret, rolledID string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories,
		Steps: []resource.TestStep{
			{
				Config: config("2026-10"),
				Check: resource.ComposeTestCheckFunc(
					resource.TestMatchResourceAttr("maple_api_key.ci", "secret", regexp.MustCompile(`^maple_ak_new`)),
					resource.TestCheckResourceAttr("maple_api_key.ci", "kind", "standard"),
					captureID("maple_api_key.ci", &firstID),
					captureAttr("maple_api_key.ci", "secret", &firstSecret),
				),
			},
			{
				// Changing the keeper rolls the key (an update, not destroy + create):
				// the old key is revoked and its replacement has a new ID.
				Config: config("2026-11"),
				ConfigPlanChecks: resource.ConfigPlanChecks{
					PreApply: []plancheck.PlanCheck{plancheck.ExpectResourceAction("maple_api_key.ci", plancheck.ResourceActionUpdate)},
				},
				Check: resource.ComposeTestCheckFunc(
					resource.TestMatchResourceAttr("maple_api_key.ci", "secret", regexp.MustCompile(`^maple_ak_rolled`)),
					captureID("maple_api_key.ci", &rolledID),
					func(*terraform.State) error {
						if rolledID == firstID {
							return fmt.Errorf("rolled key kept ID %s", firstID)
						}
						return nil
					},
				),
			},
			{
				// A key revoked outside Terraform is created again.
				PreConfig: func() {
					api.mutate("/v2/api_keys/"+rolledID, func(obj map[string]any) { obj["revoked"] = true })
				},
				Config: config("2026-11"),
				ConfigPlanChecks: resource.ConfigPlanChecks{
					PreApply: []plancheck.PlanCheck{plancheck.ExpectResourceAction("maple_api_key.ci", plancheck.ResourceActionCreate)},
				},
			},
		},
	})
	if api.count("POST", "/v2/api_keys/"+firstID+"/roll") != 1 {
		t.Fatalf("expected exactly one roll of %s", firstID)
	}
}

func TestUptimeMonitorTypeChangeReplaces(t *testing.T) {
	api := newFakeAPI(t)
	httpConfig := providerBlock(api) + `
resource "maple_uptime_monitor" "site" {
  name = "Website"
  config = jsonencode({
    type       = "http"
    url        = "https://example.com/health"
    assertions = [{ type = "status", op = "is", value = "2xx" }]
  })
  interval_seconds = 60
}
`
	heartbeatConfig := providerBlock(api) + `
resource "maple_uptime_monitor" "site" {
  name = "Website"
  config = jsonencode({
    type          = "heartbeat"
    schedule      = { type = "interval", seconds = 300 }
    grace_seconds = 60
  })
}
`
	var firstID string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories,
		Steps: []resource.TestStep{
			{
				// The API adds method = "GET"; that is not drift.
				Config: httpConfig,
				Check: resource.ComposeTestCheckFunc(
					resource.TestCheckResourceAttr("maple_uptime_monitor.site", "kind", "http"),
					captureID("maple_uptime_monitor.site", &firstID),
					func(*terraform.State) error {
						if kind := api.lastBody("POST", "/v2/uptime_monitors")["kind"]; kind != "http" {
							return fmt.Errorf("create body kind = %v, want http", kind)
						}
						return nil
					},
				),
			},
			{
				Config: heartbeatConfig,
				ConfigPlanChecks: resource.ConfigPlanChecks{
					PreApply: []plancheck.PlanCheck{plancheck.ExpectResourceAction("maple_uptime_monitor.site", plancheck.ResourceActionDestroyBeforeCreate)},
				},
				Check: resource.ComposeTestCheckFunc(
					resource.TestCheckResourceAttr("maple_uptime_monitor.site", "kind", "heartbeat"),
					resource.TestMatchResourceAttr("maple_uptime_monitor.site", "heartbeat_url", regexp.MustCompile(`/hb/upm_`)),
				),
			},
		},
	})
}

func TestScrapeTargetCredentialsAreWriteOnly(t *testing.T) {
	api := newFakeAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories,
		Steps: []resource.TestStep{
			{
				Config: providerBlock(api) + `
resource "maple_scrape_target" "node" {
  name             = "node-exporter"
  url              = "https://metrics.example.com/metrics"
  auth_type        = "bearer"
  auth_credentials = "token-123"
}
`,
				Check: resource.ComposeTestCheckFunc(
					resource.TestCheckResourceAttr("maple_scrape_target.node", "auth_credentials", "token-123"),
					resource.TestCheckResourceAttr("maple_scrape_target.node", "target_type", "prometheus"),
					resource.TestCheckResourceAttr("maple_scrape_target.node", "scrape_interval_seconds", "15"),
				),
			},
			{
				ResourceName:            "maple_scrape_target.node",
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"auth_credentials"},
			},
		},
	})
}

func TestIngestKeysDataSource(t *testing.T) {
	api := newFakeAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories,
		Steps: []resource.TestStep{{
			Config: providerBlock(api) + `data "maple_ingest_keys" "this" {}`,
			Check: resource.ComposeTestCheckFunc(
				resource.TestCheckResourceAttr("data.maple_ingest_keys.this", "private_key", "maple_sk_test"),
				resource.TestCheckResourceAttr("data.maple_ingest_keys.this", "public_rotated_at", "2026-10-01T00:00:00Z"),
			),
		}},
	})
}

func TestMissingAPIKey(t *testing.T) {
	t.Setenv("MAPLE_API_KEY", "")
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories,
		Steps: []resource.TestStep{{
			Config:      `data "maple_ingest_keys" "this" {}`,
			ExpectError: regexp.MustCompile(`Missing Maple API key`),
		}},
	})
}

func captureID(name string, into *string) resource.TestCheckFunc {
	return captureAttr(name, "id", into)
}

func captureAttr(name, attr string, into *string) resource.TestCheckFunc {
	return func(s *terraform.State) error {
		rs, ok := s.RootModule().Resources[name]
		if !ok {
			return fmt.Errorf("%s not in state", name)
		}
		*into = rs.Primary.Attributes[attr]
		return nil
	}
}

func sameID(name string, want *string) resource.TestCheckFunc {
	return func(s *terraform.State) error {
		if got := s.RootModule().Resources[name].Primary.ID; got != *want {
			return fmt.Errorf("%s id changed from %s to %s", name, *want, got)
		}
		return nil
	}
}

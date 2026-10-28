package provider

import (
	"context"
	"fmt"
	"net/url"

	"github.com/MapleTechLabs/terraform-provider-maple/internal/client"
	"github.com/hashicorp/terraform-plugin-framework-validators/setvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/listplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-go/tftypes"
)

func dashboardDef() resourceDef {
	return resourceDef{
		typeName:   "dashboard",
		collection: "/v2/dashboards",
		fields: map[string]field{
			"time_range": {json: true},
			"widgets":    {json: true, jsonList: true},
			"sections":   {json: true, jsonList: true},
			"variables":  {json: true, jsonList: true},
		},
		schema: schema.Schema{
			Description: "A Maple dashboard. Widget, section and variable documents use the v2 wire shape: build the dashboard in the UI and copy them from `GET /v2/dashboards/{id}`, or import it.",
			Attributes: map[string]schema.Attribute{
				"id":          idAttribute("dash"),
				"name":        schema.StringAttribute{Required: true, Description: "Dashboard name."},
				"description": schema.StringAttribute{Optional: true, Description: "Shown under the dashboard name."},
				"tags":        stringList("Tags for filtering the dashboard list.", false),
				"time_range":  jsonAttribute("Default time range, e.g. `{ type = \"relative\", value = \"12h\" }` or `{ type = \"absolute\", start_time = \"…\", end_time = \"…\" }`. Defaults to the API's default when unset.", false, true),
				"widgets":     jsonAttribute("List of widget documents.", false, false),
				"sections":    jsonAttribute("List of collapsible widget groups. Widgets join one with `section_id` and `tab_id`; their `layout` is relative to the section's grid.", false, false),
				"variables":   jsonAttribute("List of dashboard variables.", false, false),
				"refresh_interval_seconds": schema.Int64Attribute{
					Optional:    true,
					Description: "Auto-refresh interval: one of 0, 5, 10, 30, 60, 300 or 900. Unset means no auto-refresh.",
				},
			},
		},
	}
}

func alertDestinationDef() resourceDef {
	secret := func(description string) schema.StringAttribute {
		return schema.StringAttribute{Optional: true, Sensitive: true, Description: description}
	}
	return resourceDef{
		typeName:   "alert_destination",
		collection: "/v2/alerts/destinations",
		fields: map[string]field{
			"integration_key": {writeOnly: true},
			"url":             {writeOnly: true},
			"signing_secret":  {writeOnly: true},
			"webhook_url":     {writeOnly: true},
			"bot_token":       {writeOnly: true},
			"chat_id":         {writeOnly: true},
			"workspace_id":    {writeOnly: true, createOnly: true},
			"channel_id":      {writeOnly: true},
			"channel_label":   {readOnly: true},
			"summary":         {readOnly: true},
		},
		schema: schema.Schema{
			Description: "A notification channel that alert rules and uptime monitors deliver to. Credentials are write-only in the API, so Terraform cannot detect changes made to them outside Terraform.",
			Attributes: map[string]schema.Attribute{
				"id": idAttribute("dest"),
				"type": schema.StringAttribute{
					Required:      true,
					Description:   "Channel type: `pagerduty`, `webhook`, `discord`, `telegram`, `email` or `chat`. Changing it replaces the destination.",
					Validators:    oneOf("pagerduty", "webhook", "discord", "telegram", "email", "chat"),
					PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
				},
				"name":            schema.StringAttribute{Required: true, Description: "Display name."},
				"enabled":         schema.BoolAttribute{Optional: true, Computed: true, Description: "Whether deliveries are sent. Defaults to `true`."},
				"integration_key": secret("`pagerduty`: the Events API v2 integration key."),
				"url":             schema.StringAttribute{Optional: true, Sensitive: true, Description: "`webhook`: the URL Maple POSTs to. Sensitive, since webhook URLs often carry a token."},
				"signing_secret":  secret("`webhook`: secret used to sign each request (optional)."),
				"webhook_url":     secret("`discord`: the channel webhook URL."),
				"bot_token":       secret("`telegram`: the bot token."),
				"chat_id":         schema.StringAttribute{Optional: true, Description: "`telegram`: the chat to post to."},
				"member_user_ids": stringList("`email`: the organization members to email.", false),
				"workspace_id": schema.StringAttribute{
					Optional:      true,
					Description:   "`chat`: the linked chat workspace. Changing it replaces the destination.",
					PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
				},
				"channel_id":    schema.StringAttribute{Optional: true, Description: "`chat`: the channel to post to."},
				"channel_label": schema.StringAttribute{Computed: true, Description: "Human-readable channel, as shown in Maple."},
				"summary":       schema.StringAttribute{Computed: true, Description: "One-line description of where alerts go."},
			},
		},
	}
}

func alertRuleDef() resourceDef {
	intOC := func(description string) schema.Int64Attribute {
		return schema.Int64Attribute{Optional: true, Computed: true, Description: description}
	}
	intOptional := func(description string) schema.Int64Attribute {
		return schema.Int64Attribute{Optional: true, Description: description}
	}
	return resourceDef{
		typeName:   "alert_rule",
		collection: "/v2/alerts/rules",
		fields: map[string]field{
			"thresholds":            {json: true},
			"query_builder_draft":   {json: true},
			"notification_template": {json: true},
		},
		schema: schema.Schema{
			Description: "A Maple alert rule. Signal-specific fields (`apdex_threshold_ms`, `query_builder_draft`, `raw_query_*`) are validated by the API against `signal_type`.",
			Attributes: map[string]schema.Attribute{
				"id":   idAttribute("alrt"),
				"name": schema.StringAttribute{Required: true, Description: "Rule name, unique in the organization."},
				"signal_type": schema.StringAttribute{
					Required:    true,
					Description: "What the rule measures: `error_rate`, `p95_latency`, `p99_latency`, `apdex`, `throughput`, `builder_query`, `raw_query` or `uptime`.",
					Validators:  oneOf("error_rate", "p95_latency", "p99_latency", "apdex", "throughput", "builder_query", "raw_query", "uptime"),
				},
				"comparator": schema.StringAttribute{
					Required:    true,
					Description: "`gt`, `gte`, `lt`, `lte`, `eq`, `neq`, `between` or `not_between`.",
					Validators:  oneOf("gt", "gte", "lt", "lte", "eq", "neq", "between", "not_between"),
				},
				"window_minutes": schema.Int64Attribute{Required: true, Description: "Evaluation window, up to 1440."},
				"severity": schema.StringAttribute{
					Optional:    true,
					Computed:    true,
					Description: "`warning` or `critical`. Derived from `thresholds` when those are set.",
					Validators:  oneOf("warning", "critical"),
				},
				"threshold":       schema.NumberAttribute{Optional: true, Computed: true, Description: "Breach threshold. Error rates are 0 to 1 ratios."},
				"threshold_upper": schema.NumberAttribute{Optional: true, Description: "Upper bound for `between` and `not_between`."},
				"thresholds":      jsonAttribute("Tiered thresholds, one per severity, as an alternative to `severity` + `threshold`: a list of `{ severity, value, upper, recovery_value, destination_ids }`. Read back from the API when unset.", false, true),
				"destination_ids": schema.ListAttribute{
					ElementType: types.StringType, Optional: true, Computed: true,
					Description: "`dest_…` IDs to notify, typically `maple_alert_destination.<name>.id`.",
				},
				"notes":   schema.StringAttribute{Optional: true, Description: "Runbook notes included in notifications."},
				"enabled": schema.BoolAttribute{Optional: true, Computed: true, Description: "Whether the rule is evaluated. Defaults to `true`."},
				"tags": schema.SetAttribute{
					ElementType: types.StringType,
					Optional:    true,
					Description: "Up to 20 lowercase tags.",
					Validators:  []validator.Set{setvalidator.ValueStringsAre(lowercaseValidator{})},
				},
				"service_names":                 stringList("Only evaluate these services.", false),
				"exclude_service_names":         stringList("Skip these services.", false),
				"environments":                  stringList("Only evaluate these `deployment.environment` values.", false),
				"group_by":                      stringList("Evaluate each group separately, e.g. `[\"service.name\"]`.", false),
				"evaluation_interval_minutes":   intOptional("How often the rule runs: 1, 5, 10, 15, 30 or 60. Unset uses Maple's default schedule."),
				"minimum_sample_count":          intOC("Skip windows with fewer samples than this."),
				"consecutive_breaches_required": intOC("Breaching evaluations in a row before the rule fires."),
				"breaches_out_of":               intOptional("Fire on `consecutive_breaches_required` breaches out of this many evaluations instead of in a row (up to 30)."),
				"consecutive_healthy_required":  intOC("Healthy evaluations in a row before an incident resolves."),
				"renotify_interval_minutes":     intOC("Re-send notifications for an open incident this often."),
				"apdex_threshold_ms":            schema.NumberAttribute{Optional: true, Description: "`apdex`: the satisfied-latency threshold T in milliseconds."},
				"query_builder_draft":           jsonAttribute("`builder_query`: the query builder draft, as the dashboard's query builder saves it.", false, false),
				"raw_query_sql":                 schema.StringAttribute{Optional: true, Description: "`raw_query`: the SQL to evaluate."},
				"raw_query_reducer": schema.StringAttribute{
					Optional:    true,
					Description: "`raw_query`: how rows reduce to one value: `identity`, `sum`, `avg`, `min` or `max`.",
					Validators:  oneOf("identity", "sum", "avg", "min", "max"),
				},
				"alert_on_no_data":      schema.BoolAttribute{Optional: true, Computed: true, Description: "Count a window with no data as a breach instead of skipping it."},
				"notification_template": jsonAttribute("Custom notification `title` and `body`, with optional per-channel `overrides`.", false, false),
			},
		},
	}
}

func apiKeyDef() resourceDef {
	replace := []planmodifier.String{stringplanmodifier.RequiresReplace()}
	return resourceDef{
		typeName:   "api_key",
		collection: "/v2/api_keys",
		fields: map[string]field{
			"expires_in_seconds": {writeOnly: true, createOnly: true},
			// A keeper: Terraform-side only, never sent.
			"rotate":     {writeOnly: true, readOnly: true},
			"key_prefix": {readOnly: true},
			"secret":     {readOnly: true},
			"expires_at": {readOnly: true},
		},
		gone: func(obj client.Object) bool { return obj["revoked"] == true },
		update: func(ctx context.Context, c *client.Client, id string, plan, prior map[string]tftypes.Value) (client.Object, error) {
			// Every other input forces replacement, so an update is a rotation. A roll
			// revokes the key and returns its replacement under a new ID.
			if plan["rotate"].Equal(prior["rotate"]) {
				return c.Get(ctx, "/v2/api_keys/"+url.PathEscape(id))
			}
			return c.Post(ctx, "/v2/api_keys/"+url.PathEscape(id)+"/roll", nil)
		},
		schema: schema.Schema{
			Description: "A Maple API key. The secret is only returned when the key is created or rolled, and is stored in state: treat the state as sensitive. Destroying the resource revokes the key.",
			Attributes: map[string]schema.Attribute{
				"id": schema.StringAttribute{
					Computed:      true,
					Description:   "The `key_…` public ID. Rolling the key (changing `rotate`) issues a new ID.",
					PlanModifiers: []planmodifier.String{rotateChangesID{}},
				},
				"name":        schema.StringAttribute{Required: true, Description: "Key name. Changing it replaces the key.", PlanModifiers: replace},
				"description": schema.StringAttribute{Optional: true, Description: "Changing it replaces the key.", PlanModifiers: replace},
				"scopes": schema.ListAttribute{
					ElementType: types.StringType, Optional: true,
					Description:   "Scopes like `dashboards:read` or `alerts:write`. Unset means full access. Changing them replaces the key.",
					PlanModifiers: []planmodifier.List{listplanmodifier.RequiresReplace()},
				},
				"kind": schema.StringAttribute{
					Optional: true, Computed: true,
					Description:   "`standard` (default) or `mcp`. Changing it replaces the key.",
					Validators:    oneOf("standard", "mcp"),
					PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplaceIfConfigured()},
				},
				"expires_in_seconds": schema.Int64Attribute{
					Optional: true, Description: "Lifetime from creation. Unset means the key does not expire. Changing it replaces the key.",
					PlanModifiers: []planmodifier.Int64{int64planmodifier.RequiresReplace()},
				},
				"rotate": schema.StringAttribute{
					Optional:    true,
					Description: "Any value; changing it rolls the key: Maple revokes it and issues a replacement with the same name, description, kind and scopes, a new ID and a new secret. For example the `id` of a `time_rotating` resource.",
				},
				"key_prefix": schema.StringAttribute{Computed: true, Description: "The visible start of the secret, as shown in Maple."},
				"secret":     schema.StringAttribute{Computed: true, Sensitive: true, Description: "The `maple_ak_…` secret."},
				"expires_at": schema.StringAttribute{Computed: true, Description: "When the key expires, if it does."},
			},
		},
	}
}

func scrapeTargetDef() resourceDef {
	return resourceDef{
		typeName:   "scrape_target",
		collection: "/v2/scrape_targets",
		fields: map[string]field{
			"target_type":      {createOnly: true},
			"auth_credentials": {writeOnly: true},
		},
		schema: schema.Schema{
			Description: "A Prometheus-format endpoint Maple scrapes for metrics.",
			Attributes: map[string]schema.Attribute{
				"id":   idAttribute("scrp"),
				"name": schema.StringAttribute{Required: true, Description: "Display name."},
				"target_type": schema.StringAttribute{
					Optional: true, Computed: true,
					Description:   "`prometheus` (default), `planetscale` or `supabase`. Changing it replaces the target.",
					Validators:    oneOf("prometheus", "planetscale", "supabase"),
					PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplaceIfConfigured()},
				},
				"url":                     schema.StringAttribute{Optional: true, Computed: true, Description: "The metrics endpoint to scrape."},
				"organization":            schema.StringAttribute{Optional: true, Description: "`planetscale`: the PlanetScale organization."},
				"include_branches":        stringList("`planetscale`: only scrape these branches.", false),
				"exclude_branches":        stringList("`planetscale`: skip these branches.", false),
				"scrape_interval_seconds": schema.Int64Attribute{Optional: true, Computed: true, Description: "Seconds between scrapes, 5 to 300."},
				"labels_json":             schema.StringAttribute{Optional: true, Description: "Extra labels added to every series, as a JSON object string."},
				"auth_type": schema.StringAttribute{
					Optional: true, Computed: true,
					Description: "`none` (default), `bearer`, `basic` or `token`.",
					Validators:  oneOf("none", "bearer", "basic", "token", "planetscale_oauth", "supabase_oauth"),
				},
				"auth_credentials": schema.StringAttribute{Optional: true, Sensitive: true, Description: "Credentials for `auth_type`. Write-only in the API."},
				"service_name":     schema.StringAttribute{Optional: true, Description: "`service.name` given to the scraped series."},
				"enabled":          schema.BoolAttribute{Optional: true, Computed: true, Description: "Whether the target is scraped. Defaults to `true`."},
			},
		},
	}
}

func uptimeMonitorDef() resourceDef {
	return resourceDef{
		typeName:   "uptime_monitor",
		collection: "/v2/uptime_monitors",
		fields: map[string]field{
			"config":        {json: true},
			"kind":          {readOnly: true},
			"heartbeat_url": {readOnly: true},
			"alert_rule_id": {readOnly: true},
		},
		prepareBody: func(body map[string]any, create bool) error {
			if !create {
				return nil
			}
			config, _ := body["config"].(map[string]any)
			kind, _ := config["type"].(string)
			if kind == "" {
				return fmt.Errorf("config must have a type: http, tcp, dns or heartbeat")
			}
			body["kind"] = kind
			return nil
		},
		schema: schema.Schema{
			Description: "An HTTP, TCP, DNS or heartbeat uptime monitor.",
			Attributes: map[string]schema.Attribute{
				"id":   idAttribute("upm"),
				"name": schema.StringAttribute{Required: true, Description: "Display name."},
				"config": schema.StringAttribute{
					Required: true,
					Description: "The check, with `type` `http`, `tcp`, `dns` or `heartbeat`. Write it with `jsonencode(...)`. " +
						"Changing `type` replaces the monitor.",
					Validators:    []validator.String{jsonValidator{}},
					PlanModifiers: []planmodifier.String{configTypeChangeReplaces()},
				},
				"kind":             schema.StringAttribute{Computed: true, Description: "The monitor kind, from `config.type`."},
				"interval_seconds": schema.Int64Attribute{Optional: true, Computed: true, Description: "Seconds between checks, 30 to 3600."},
				"failures_to_down": schema.Int64Attribute{Optional: true, Computed: true, Description: "Failed checks in a row before the monitor is down, 1 to 10."},
				"service_name":     schema.StringAttribute{Optional: true, Description: "Attach the monitor to this service."},
				"enabled":          schema.BoolAttribute{Optional: true, Computed: true, Description: "Whether checks run. Defaults to `true`."},
				"destination_ids":  stringList("`dest_…` IDs notified when the monitor goes down or recovers.", false),
				"heartbeat_url":    readOnlyString("`heartbeat`: the URL your job pings."),
				"alert_rule_id":    schema.StringAttribute{Computed: true, Description: "The alert rule that delivers this monitor's notifications."},
			},
		},
	}
}

func configTypeChangeReplaces() planmodifier.String {
	return stringplanmodifier.RequiresReplaceIf(
		func(_ context.Context, req planmodifier.StringRequest, resp *stringplanmodifier.RequiresReplaceIfFuncResponse) {
			if req.StateValue.IsNull() || req.PlanValue.IsUnknown() {
				return
			}
			before, errBefore := parseJSON(req.StateValue.ValueString())
			after, errAfter := parseJSON(req.PlanValue.ValueString())
			if errBefore != nil || errAfter != nil {
				return
			}
			typeOf := func(v any) any {
				m, _ := v.(map[string]any)
				return m["type"]
			}
			resp.RequiresReplace = typeOf(before) != typeOf(after)
		},
		"Changing config.type replaces the monitor.",
		"Changing `config.type` replaces the monitor.",
	)
}

// rotateChangesID keeps the API key ID across plans, except when `rotate`
// changes: the roll returns the replacement key under a new ID.
type rotateChangesID struct{}

func (rotateChangesID) Description(context.Context) string {
	return "The ID changes when the key is rolled."
}

func (m rotateChangesID) MarkdownDescription(ctx context.Context) string { return m.Description(ctx) }

func (rotateChangesID) PlanModifyString(ctx context.Context, req planmodifier.StringRequest, resp *planmodifier.StringResponse) {
	if req.StateValue.IsNull() || req.Plan.Raw.IsNull() {
		return
	}
	var planned, prior types.String
	resp.Diagnostics.Append(req.Plan.GetAttribute(ctx, path.Root("rotate"), &planned)...)
	resp.Diagnostics.Append(req.State.GetAttribute(ctx, path.Root("rotate"), &prior)...)
	if planned.Equal(prior) {
		resp.PlanValue = req.StateValue
	} else {
		resp.PlanValue = types.StringUnknown()
	}
}

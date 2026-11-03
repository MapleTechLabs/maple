// Package provider implements the Maple Terraform provider on the public v2 API.
package provider

import (
	"context"
	"os"

	"github.com/MapleTechLabs/terraform-provider-maple/internal/client"
	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

type mapleProvider struct {
	version string
}

type providerModel struct {
	APIKey types.String `tfsdk:"api_key"`
	APIURL types.String `tfsdk:"api_url"`
}

func New(version string) func() provider.Provider {
	return func() provider.Provider { return &mapleProvider{version: version} }
}

func (p *mapleProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "maple"
	resp.Version = p.version
}

func (p *mapleProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Manage Maple dashboards, alerts, uptime monitors, scrape targets and API keys through the public v2 API.",
		Attributes: map[string]schema.Attribute{
			"api_key": schema.StringAttribute{
				Optional:  true,
				Sensitive: true,
				Description: "A Maple API key (`maple_ak_…`). Defaults to the `MAPLE_API_KEY` environment variable. " +
					"Alert rules, alert destinations, API keys and ingest keys need a key created by an org admin; " +
					"a scoped key needs the matching `:write` scope for each resource it manages.",
			},
			"api_url": schema.StringAttribute{
				Optional:    true,
				Description: "Base URL of the Maple API. Defaults to the `MAPLE_API_URL` environment variable, then `https://api.maple.dev`. Use `https://api.eu.maple.dev` for the EU region.",
			},
		},
	}
}

func (p *mapleProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var config providerModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if config.APIKey.IsUnknown() || config.APIURL.IsUnknown() {
		// Configured from another resource's output that is not known yet.
		return
	}
	apiKey := os.Getenv("MAPLE_API_KEY")
	if !config.APIKey.IsNull() {
		apiKey = config.APIKey.ValueString()
	}
	apiURL := os.Getenv("MAPLE_API_URL")
	if !config.APIURL.IsNull() {
		apiURL = config.APIURL.ValueString()
	}
	if apiURL == "" {
		apiURL = client.DefaultBaseURL
	}
	if apiKey == "" {
		resp.Diagnostics.AddAttributeError(
			path.Root("api_key"),
			"Missing Maple API key",
			"Set api_key in the provider block or the MAPLE_API_KEY environment variable. Create one under Settings → Keys in Maple.",
		)
		return
	}
	c := client.New(apiURL, apiKey, "terraform-provider-maple/"+p.version)
	resp.ResourceData = c
	resp.DataSourceData = c
}

func (p *mapleProvider) Resources(_ context.Context) []func() resource.Resource {
	return []func() resource.Resource{
		newResource(alertDestinationDef()),
		newResource(alertRuleDef()),
		newResource(apiKeyDef()),
		newResource(dashboardDef()),
		newResource(scrapeTargetDef()),
		newResource(uptimeMonitorDef()),
	}
}

func (p *mapleProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return []func() datasource.DataSource{newIngestKeysDataSource}
}

package provider

import (
	"context"
	"fmt"

	"github.com/MapleTechLabs/terraform-provider-maple/internal/client"
	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

type ingestKeysDataSource struct {
	client *client.Client
}

type ingestKeysModel struct {
	PublicKey        types.String `tfsdk:"public_key"`
	PrivateKey       types.String `tfsdk:"private_key"`
	PublicRotatedAt  types.String `tfsdk:"public_rotated_at"`
	PrivateRotatedAt types.String `tfsdk:"private_rotated_at"`
}

func newIngestKeysDataSource() datasource.DataSource { return &ingestKeysDataSource{} }

func (d *ingestKeysDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_ingest_keys"
}

func (d *ingestKeysDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "The organization's ingest keys, for wiring OpenTelemetry exporters without copying keys by hand. Reading them needs an org-admin API key.",
		Attributes: map[string]schema.Attribute{
			"public_key":         schema.StringAttribute{Computed: true, Sensitive: true, Description: "The public ingest key (`maple_pk_…`), safe for browsers and mobile apps."},
			"private_key":        schema.StringAttribute{Computed: true, Sensitive: true, Description: "The private ingest key (`maple_sk_…`) for servers."},
			"public_rotated_at":  schema.StringAttribute{Computed: true, Description: "When the public key was last rolled."},
			"private_rotated_at": schema.StringAttribute{Computed: true, Description: "When the private key was last rolled."},
		},
	}
}

func (d *ingestKeysDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}
	c, ok := req.ProviderData.(*client.Client)
	if !ok {
		resp.Diagnostics.AddError("Unexpected provider data", fmt.Sprintf("expected *client.Client, got %T", req.ProviderData))
		return
	}
	d.client = c
}

func (d *ingestKeysDataSource) Read(ctx context.Context, _ datasource.ReadRequest, resp *datasource.ReadResponse) {
	obj, err := d.client.Get(ctx, "/v2/ingest_keys")
	if err != nil {
		resp.Diagnostics.AddError("Reading ingest keys", err.Error())
		return
	}
	str := func(key string) types.String {
		s, _ := obj[key].(string)
		return types.StringValue(s)
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, ingestKeysModel{
		PublicKey:        str("public_key"),
		PrivateKey:       str("private_key"),
		PublicRotatedAt:  str("public_rotated_at"),
		PrivateRotatedAt: str("private_rotated_at"),
	})...)
}

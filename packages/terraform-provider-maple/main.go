package main

import (
	"context"
	"flag"
	"log"

	"github.com/MapleTechLabs/terraform-provider-maple/internal/provider"
	"github.com/hashicorp/terraform-plugin-framework/providerserver"
)

//go:generate go tool tfplugindocs generate --provider-name maple

// Set by goreleaser.
var version = "dev"

func main() {
	var debug bool
	flag.BoolVar(&debug, "debug", false, "run the provider with support for debuggers like delve")
	flag.Parse()

	err := providerserver.Serve(context.Background(), provider.New(version), providerserver.ServeOpts{
		Address: "registry.terraform.io/mapletechlabs/maple",
		Debug:   debug,
	})
	if err != nil {
		log.Fatal(err.Error())
	}
}

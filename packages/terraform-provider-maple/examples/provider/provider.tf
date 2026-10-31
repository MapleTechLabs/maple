terraform {
  required_providers {
    maple = {
      source  = "mapletechlabs/maple"
      version = "~> 0.1"
    }
  }
}

# Reads MAPLE_API_KEY (and MAPLE_API_URL, if set) from the environment.
provider "maple" {}

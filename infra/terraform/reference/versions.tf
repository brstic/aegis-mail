terraform {
  required_version = ">= 1.8"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
  # Partial on purpose: pass bucket, key, region and dynamodb_table at init. `tofu init -backend=false` validates without it.
  backend "s3" {
    encrypt = true
  }
}

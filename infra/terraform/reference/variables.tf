variable "region" {
  description = "AWS region."
  type        = string
}

variable "name" {
  description = "Prefix for every resource."
  type        = string
  default     = "aegis"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.name))
    error_message = "Use lower case letters, digits and hyphens, at most 21 characters."
  }
}

variable "vpc_cidr" {
  description = "VPC range. Must be a /16 or larger: each tier takes /24s."
  type        = string
  default     = "10.40.0.0/16"
}

variable "availability_zones" {
  description = "Exactly two availability zones."
  type        = list(string)
  validation {
    condition     = length(var.availability_zones) == 2
    error_message = "This reference uses exactly two availability zones."
  }
}

variable "app_origin" {
  description = "Public origin of the web app, for example https://mail.example.com."
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate for the load balancer. TLS is not optional."
  type        = string
}

variable "ingress_cidrs" {
  description = "Who can reach the load balancer."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "key_admin_arns" {
  description = "IAM principals that administer KMS keys. They can't use them. Must include whoever runs this, or AWS refuses the policy."
  type        = list(string)
}

variable "web_image" {
  description = "Image built from infra/docker/Dockerfile, target web."
  type        = string
}

variable "worker_image" {
  description = "Image built from infra/docker/Dockerfile, target worker. Also runs the migration task."
  type        = string
}

variable "clamd_image" {
  description = "Image built from infra/docker/Dockerfile, target clamd, which carries the required AlertExceedsMax setting."
  type        = string
}

variable "postgres_engine_version" {
  description = "PostgreSQL major version. Migration 003 uses GRANT ... WITH SET, which needs 16 or later."
  type        = string
  default     = "17"
  validation {
    condition     = tonumber(split(".", var.postgres_engine_version)[0]) >= 16
    error_message = "PostgreSQL 16 or later is required."
  }
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 100
}

variable "backup_retention_days" {
  description = "How long automated backups last. Deletion promises depend on this: state the same number to your users."
  type        = number
  default     = 14
  validation {
    condition     = var.backup_retention_days >= 7 && var.backup_retention_days <= 35
    error_message = "Between 7 and 35 days."
  }
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "worker_egress_ports" {
  description = "TCP ports workers may open to public addresses: HTTPS for provider APIs, then IMAP, POP3 and SMTP submission."
  type        = list(number)
  default     = [143, 443, 465, 587, 993, 995]
}

variable "web_desired_count" {
  type    = number
  default = 2
}

variable "worker_desired_count" {
  type    = number
  default = 2
}

variable "optional_secrets" {
  description = "Which optional secrets this deployment sets: GOOGLE_CLIENT_SECRET, MICROSOFT_CLIENT_SECRET, OPENAI_API_KEY, ANTHROPIC_API_KEY."
  type        = list(string)
  default     = []
}

variable "extra_environment" {
  description = "Non-secret settings for web and worker, such as GOOGLE_CLIENT_ID. DEMO_MODE must never be here."
  type        = map(string)
  default     = {}
  validation {
    condition     = !contains(keys(var.extra_environment), "DEMO_MODE")
    error_message = "DEMO_MODE exposes seeded logins and must stay unset in a deployment."
  }
}

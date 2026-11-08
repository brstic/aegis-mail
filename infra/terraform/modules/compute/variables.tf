variable "name" {
  type = string
}

variable "region" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "web_subnet_ids" {
  type = list(string)
}

variable "worker_subnet_ids" {
  type = list(string)
}

variable "services_subnet_ids" {
  type = list(string)
}

variable "alb_security_group_id" {
  type = string
}

variable "web_security_group_id" {
  type = string
}

variable "worker_security_group_id" {
  type = string
}

variable "clamd_security_group_id" {
  type = string
}

variable "certificate_arn" {
  type = string
}

variable "app_origin" {
  type = string
}

variable "web_image" {
  type = string
}

variable "worker_image" {
  type = string
}

variable "clamd_image" {
  type = string
}

variable "web_desired_count" {
  type = number
}

variable "worker_desired_count" {
  type = number
}

variable "log_retention_days" {
  type = number
}

variable "infrastructure_key_arn" {
  type = string
}

variable "app_key_arn" {
  type = string
}

variable "secret_arns" {
  type = map(string)
}

variable "extra_environment" {
  type = map(string)
}

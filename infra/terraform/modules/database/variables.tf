variable "name" {
  type = string
}

variable "engine_version" {
  type = string
}

variable "instance_class" {
  type = string
}

variable "allocated_storage_gb" {
  type = number
}

variable "backup_retention_days" {
  type = number
}

variable "log_retention_days" {
  type = number
}

variable "subnet_ids" {
  type = list(string)
}

variable "security_group_id" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

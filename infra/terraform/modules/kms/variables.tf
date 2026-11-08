variable "name" {
  type = string
}

variable "region" {
  type = string
}

variable "key_admin_arns" {
  type = list(string)
}

variable "app_role_arns" {
  description = "Task roles that wrap and unwrap tenant keys."
  type        = list(string)
}

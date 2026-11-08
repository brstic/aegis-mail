variable "name" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "optional_secrets" {
  type = list(string)
}

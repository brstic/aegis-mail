variable "name" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "availability_zones" {
  type = list(string)
}

variable "ingress_cidrs" {
  type = list(string)
}

variable "worker_egress_ports" {
  type = list(number)
}

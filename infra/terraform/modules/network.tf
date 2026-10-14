resource "aws_vpc" "main" {
  count                = var.create_network ? 1 : 0
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "comprova-${var.environment}" }
}

resource "aws_subnet" "private" {
  count             = length(var.availability_zones)
  vpc_id            = aws_vpc.main[0].id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index)
  availability_zone = var.availability_zones[count.index]

  tags = { Name = "comprova-private-${var.availability_zones[count.index]}", "karpenter.sh/discovery/comprova" = "comprova" }
}

resource "aws_vpc_endpoint" "s3" {
  count           = var.create_network ? 1 : 0
  vpc_id          = aws_vpc.main[0].id
  service_name    = "com.amazonaws.sa-east-1.s3"
  route_table_ids = [aws_vpc.main[0].default_route_table_id]
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "availability_zones" {
  type    = list(string)
  default = ["sa-east-1a", "sa-east-1b", "sa-east-1c"]
}

variable "create_network" {
  type    = bool
  default = false
}

variable "environment" {
  type    = string
  default = "dev"
}

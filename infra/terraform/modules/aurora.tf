resource "aws_rds_cluster" "postgres" {
  count                          = var.create_aurora ? 1 : 0
  cluster_identifier             = "comprova"
  engine                         = "aurora-postgresql"
  engine_version                 = "16.4"
  database_name                  = "comprova"
  master_username                = "comprova_admin"
  master_password                = var.db_master_password
  db_subnet_group_name           = var.db_subnet_group
  storage_encrypted              = true
  backup_retention_period        = 14
  enabled_cloudwatch_logs_exports = ["postgresql"]

  # PostGIS: habilitar via parameter group custom (rds.custom_postgis) quando aplicavel
}

resource "aws_rds_cluster_instance" "writer" {
  count           = var.create_aurora ? 1 : 0
  cluster_identifier = aws_rds_cluster.postgres[0].id
  instance_class  = var.instance_class
  engine          = "aurora-postgresql"
  identifier      = "comprova-writer"
}

resource "aws_rds_cluster_instance" "readers" {
  count           = var.create_aurora ? var.replica_count : 0
  cluster_identifier = aws_rds_cluster.postgres[0].id
  instance_class  = var.instance_class
  engine          = "aurora-postgresql"
  identifier      = "comprova-reader-${count.index}"
}

variable "create_aurora" {
  type    = bool
  default = false
}

variable "instance_class" {
  type    = string
  default = "db.r6g.large"
}

variable "replica_count" {
  type    = number
  default = 1
}

variable "db_master_password" {
  type    = string
  default = "CHANGE-ME-VIA-SECRETS-MANAGER"
}

variable "db_subnet_group" {
  type    = string
  default = "comprova-db-subnets"
}

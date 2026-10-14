module "network" {
  source = "./modules"

  vpc_cidr             = "10.0.0.0/16"
  availability_zones    = ["sa-east-1a", "sa-east-1b", "sa-east-1c"]
  cluster_name         = "comprova"
}

module "aurora" {
  source              = "./modules"
  instance_class       = "db.r6g.large"
  replica_count        = 1
  backup_window        = "03:00-04:00"
}

module "redis" {
  source        = "./modules"
  node_type     = "cache.r6g.large"
  shard_count   = 1
}

module "eks" {
  source      = "./modules"
  k8s_version = "1.31"
}

module "storage" {
  source           = "./modules"
  evidence_retention_days = 365
}

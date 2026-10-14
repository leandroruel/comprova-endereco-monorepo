resource "aws_eks_cluster" "main" {
  count    = var.create_eks ? 1 : 0
  name     = "comprova"
  role_arn = var.eks_role_arn
  version  = var.k8s_version

  vpc_config {
    subnet_ids              = var.private_subnet_ids
    endpoint_private_access = true
    endpoint_public_access  = false
  }
}

resource "aws_eks_node_group" "api" {
  count           = var.create_eks ? 1 : 0
  cluster_name    = aws_eks_cluster.main[0].name
  node_group_name = "api-on-demand"
  instance_types = ["m6g.large"]
  scaling_config {
    desired_size = 3
    max_size     = 30
    min_size     = 3
  }
}

variable "create_eks" {
  type    = bool
  default = false
}

variable "k8s_version" {
  type    = string
  default = "1.31"
}

variable "eks_role_arn" {
  type    = string
  default = "arn:aws:iam::000000000000:role/placeholder"
}

variable "private_subnet_ids" {
  type    = list(string)
  default = []
}

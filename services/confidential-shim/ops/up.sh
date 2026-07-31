#!/usr/bin/env bash
#
# Provision the Confidential VM for the attester shim: an n2d-standard-16 with
# AMD SEV-SNP (a real hardware TEE), Ubuntu 22.04, 80GB balanced disk. The
# static IP is assumed already reserved (gcloud compute addresses create) so
# the sslip.io hostname and the app's CONFIDENTIAL_AI_BASE_URL never change
# across stop/start cycles.
#
# Usage:
#   PROJECT=my-gcp-project STATIC_IP=confidential-shim-ip ./up.sh
#
# Env:
#   PROJECT    (required) GCP project id
#   STATIC_IP  (required) name of the reserved static address, or a literal IP
#   ZONE       default us-central1-a
#   INSTANCE   default confidential-shim

set -euo pipefail

PROJECT="${PROJECT:?set PROJECT to the GCP project id}"
STATIC_IP="${STATIC_IP:?set STATIC_IP to the reserved static address name or IP}"
ZONE="${ZONE:-us-central1-a}"
INSTANCE="${INSTANCE:-confidential-shim}"

# Ingress for Caddy (80 for the ACME challenge, 443 for the shim itself),
# scoped to the confidential-shim tag. Safe to rerun; create fails politely
# when the rule already exists.
gcloud compute firewall-rules create confidential-shim-web \
  --project="$PROJECT" \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:80,tcp:443 \
  --target-tags=confidential-shim \
  || echo "firewall rule confidential-shim-web already exists, continuing"

gcloud compute instances create "$INSTANCE" \
  --project="$PROJECT" \
  --zone="$ZONE" \
  --machine-type=n2d-standard-16 \
  --confidential-compute-type=SEV_SNP \
  --min-cpu-platform="AMD Milan" \
  --maintenance-policy=TERMINATE \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=80GB \
  --boot-disk-type=pd-balanced \
  --address="$STATIC_IP" \
  --tags=confidential-shim

echo
echo "instance created. next steps (see ../ops/RUNBOOK.md):"
echo "  gcloud compute ssh $INSTANCE --project=$PROJECT --zone=$ZONE"
echo "  install docker, clone the repo, cd services/confidential-shim"
echo "  write .env with SHIM_API_KEY and SHIM_DOMAIN=<A-B-C-D>.sslip.io"
echo "  docker compose up -d --build"
echo "  docker compose exec ollama ollama pull gemma3:4b-it-qat"

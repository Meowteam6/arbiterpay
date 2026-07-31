#!/usr/bin/env bash
#
# Stop (not delete) the Confidential VM. The boot disk persists, so the pulled
# model weights, the docker images, and the job journal all survive; the next
# up is `gcloud compute instances start`, not a re-provision. Stopped SEV-SNP
# instances stop billing for cores and RAM; the disk and static IP keep
# accruing their (small) charges.
#
# Usage:
#   PROJECT=my-gcp-project ./down.sh

set -euo pipefail

PROJECT="${PROJECT:?set PROJECT to the GCP project id}"
ZONE="${ZONE:-us-central1-a}"
INSTANCE="${INSTANCE:-confidential-shim}"

gcloud compute instances stop "$INSTANCE" \
  --project="$PROJECT" \
  --zone="$ZONE"

echo "stopped $INSTANCE. restart with:"
echo "  gcloud compute instances start $INSTANCE --project=$PROJECT --zone=$ZONE"

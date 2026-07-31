# Confidential attester shim - runbook

Chainlink's hosted Confidential AI Attester returns 503 service_disabled
between hackathon events. This shim replicates its HTTP contract exactly
(submit, poll, models, same verdict JSON), runs gemma3 on Ollama inside a GCP
Confidential VM (AMD SEV-SNP, hardware TEE), and the app switches to it by
changing one env var. Document bytes stay in memory; only verdict metadata is
journaled.

## App env flips (Vercel and local)

| Var | Value |
| --- | --- |
| `CONFIDENTIAL_AI_BASE_URL` | `https://<A-B-C-D>.sslip.io` (VM static IP with dashes) |
| `CONFIDENTIAL_AI_API_KEY` | the shim's `SHIM_API_KEY` value |
| `DEMO_MODE` | UNSET it. With the shim live there is no reason to allow the mock verified-true path |

Nothing else changes. `app/lib/server/judge.ts` already speaks this contract.

## First-time provisioning

1. Reserve a static IP once: `gcloud compute addresses create confidential-shim-ip --region=us-central1`
2. `PROJECT=<gcp-project> STATIC_IP=confidential-shim-ip ops/up.sh`
3. SSH in, install docker (`curl -fsSL https://get.docker.com | sh`), clone the repo
4. `cd services/confidential-shim` and write `.env` (never committed):
   - `SHIM_API_KEY=<long random string>` (this becomes the app's `CONFIDENTIAL_AI_API_KEY`)
   - `SHIM_DOMAIN=<A-B-C-D>.sslip.io` (static IP `A.B.C.D` with dashes)
5. `docker compose up -d --build`
6. `docker compose exec ollama ollama pull gemma3:4b-it-qat` (about 3.3GB, once; survives restarts in the models volume)
7. From your laptop: `SHIM_BASE_URL=https://<A-B-C-D>.sslip.io SHIM_API_KEY=<key> ops/smoke.sh`

## Demo-morning checklist

1. `gcloud compute instances start confidential-shim --project=<gcp-project> --zone=us-central1-a` (skip if never stopped)
2. Wait about a minute; SSH in and `docker compose ps` in `services/confidential-shim` - all three services up (compose has `restart: unless-stopped`, so they self-start with the VM)
3. `curl https://<A-B-C-D>.sslip.io/healthz` returns `"status":"ok"` - proves Ollama is up and the model is present
4. Run `ops/smoke.sh` and read the verdict JSON with your own eyes
5. Confirm the three app env values above in Vercel (and that `DEMO_MODE` is absent), redeploy if any changed
6. Upload a real document through the app; watch the verdict complete
7. First inference after boot is slow (model load, about a minute); fire one throwaway inference before going on stage

## Stop / start

- Stop (billing off for cores/RAM, disk and model survive): `PROJECT=<gcp-project> ops/down.sh`
- Start again: `gcloud compute instances start confidential-shim --project=<gcp-project> --zone=us-central1-a`
- The static IP means the sslip.io hostname, the TLS cert, and the app env all stay valid across stop/start

## Troubleshooting

- `healthz` says model missing: rerun the `ollama pull` from step 6
- TLS errors: Caddy needs ports 80 and 443 open (the `confidential-shim-web` firewall rule) and `SHIM_DOMAIN` resolving to this VM's IP
- Verdict polls stuck on `verifying`: `docker compose logs shim ollama --tail 100`; a shim restart marks in-flight jobs failed, the app fails closed to unverified and the user resubmits
- 401 from the app: the Vercel `CONFIDENTIAL_AI_API_KEY` and the VM `.env` `SHIM_API_KEY` have drifted

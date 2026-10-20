# Check a DockClock evidence pack yourself

```bash
npm ci
npm run verify:pack -- docs/evidence/SMOKE-mve8yfv3.pack.json
```

The script needs no AWS account. It checks the ECDSA P-256 signature over the pack's canonical bytes against [`public-key.pem`](public-key.pem), prints the pack digest, and shows that a copy with the amount changed by $1 fails.

What the pack is, how it was produced and what its signature does and does not prove: [`MANIFEST.json`](MANIFEST.json). It is the pack attached to the claim email of load `SMOKE-mve8yfv3`, whose driver messages were synthetic and whose approval was a real tap.

## Message ids in a pack
Packs sealed from 2026-10-20 on record each WhatsApp, RCS and SES message id as `msg-sha256:<first 16 hex of sha256(id)>`, not the raw id. A WhatsApp message id (`wamid.…`) base64-encodes the sender's phone number, so a pack that is shared must not carry it. The full ids stay in DockClock's table; anyone holding one can recompute the reference and match it. The signature covers the reference exactly as it does any other field, so `npm run verify:pack` is unchanged.

The frozen pack above was sealed before this change and is kept as signed. Its ids are raw, but its driver messages were synthetic (`SMOKE-` load), so they encode no real number.

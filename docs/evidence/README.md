# Check a DockClock evidence pack yourself

```bash
npm ci
npm run verify:pack -- docs/evidence/SMOKE-mve8yfv3.pack.json
```

The script needs no AWS account. It checks the ECDSA P-256 signature over the pack's canonical bytes against [`public-key.pem`](public-key.pem), prints the pack digest, and shows that a copy with the amount changed by $1 fails.

What the pack is, how it was produced and what its signature does and does not prove: [`MANIFEST.json`](MANIFEST.json). It is the pack attached to the claim email of load `SMOKE-mve8yfv3`, whose driver messages were synthetic and whose approval was a real tap.

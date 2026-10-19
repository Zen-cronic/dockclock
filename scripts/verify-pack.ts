// Verifies a DockClock evidence pack offline, with no AWS access: the ECDSA P-256 signature over
// the pack's canonical bytes, checked against a public key in PEM form.
//   npm run verify:pack -- docs/evidence/SMOKE-mve8yfv3.pack.json [--key docs/evidence/public-key.pem]
// Also prints the pack digest and checks that a copy with one changed amount fails.
import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { packBytes, sha256Hex, verifyPack, type SignedPack } from "@dockclock/evidence";

// Accepts the pack path anywhere, and the key as --key <file> or --key=<file>. Anything else, or a
// --key with no value, is an error rather than a silent fallback to the bundled key.
function parseArgs(args: string[]): { file: string; keyFile: string } {
  const usage = (why: string): never => {
    console.error(`${why}\nusage: npm run verify:pack -- <pack.json> [--key <public-key.pem>]`);
    process.exit(2);
  };
  let file: string | undefined;
  let keyFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--key") {
      keyFile = args[++i] ?? usage("--key needs a file");
    } else if (arg.startsWith("--key=")) {
      keyFile = arg.slice("--key=".length) || usage("--key needs a file");
    } else if (arg.startsWith("--")) {
      usage(`unknown option ${arg}`);
    } else if (file) {
      usage(`unexpected argument ${arg}`);
    } else {
      file = arg;
    }
  }
  return { file: file ?? usage("no pack file given"), keyFile: keyFile ?? "docs/evidence/public-key.pem" };
}

const { file, keyFile } = parseArgs(process.argv.slice(2));

const signed = JSON.parse(readFileSync(file, "utf8")) as SignedPack;
const publicKeyDer = createPublicKey(readFileSync(keyFile, "utf8")).export({ format: "der", type: "spki" });
const valid = verifyPack(signed, publicKeyDer);
const tampered: SignedPack = { ...signed, pack: { ...signed.pack, evaluation: { ...signed.pack.evaluation, amountUsd: signed.pack.evaluation.amountUsd + 1 } } };

console.log(`pack ${signed.pack.packId} (load ${signed.pack.loadId})`);
console.log(`  digest sha256 ${sha256Hex(packBytes(signed.pack))}`);
console.log(`  verdict ${signed.pack.evaluation.verdict}, amount $${signed.pack.evaluation.amountUsd.toFixed(2)}`);
console.log(`  key ${keyFile} (sha256 ${sha256Hex(publicKeyDer)})`);
console.log(`  signature verifies: ${valid}`);
console.log(`  copy with the amount changed by $1 verifies: ${verifyPack(tampered, publicKeyDer)}`);
process.exit(valid ? 0 : 1);

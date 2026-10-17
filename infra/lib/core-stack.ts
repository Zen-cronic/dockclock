import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

// State that outlives any deploy: the load table, the signing key, the locked evidence bucket and
// the key that turns phone numbers into opaque driver ids.
export class CoreStack extends Stack {
  readonly table: dynamodb.TableV2;
  readonly evidenceBucket: s3.Bucket;
  readonly mediaBucket: s3.Bucket;
  readonly evidenceKey: kms.Key;
  readonly identitySecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    this.table = new dynamodb.TableV2(this, "Loads", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: "expires",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.evidenceKey = new kms.Key(this, "EvidenceKey", {
      description: "Signs DockClock evidence packs (ECDSA P-256). Public key verifies them offline.",
      keySpec: kms.KeySpec.ECC_NIST_P256,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      alias: "alias/dockclock-evidence",
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.evidenceBucket = new s3.Bucket(this, "EvidencePacks", {
      objectLockEnabled: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.governance(Duration.days(30)),
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Driver photos land here straight from WhatsApp; sealing copies them under the evidence lock.
    this.mediaBucket = new s3.Bucket(this, "DriverMedia", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(90) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.identitySecret = new secretsmanager.Secret(this, "DriverIdentityKey", {
      description: "HMAC key for DockClock driver ids derived from phone numbers.",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}

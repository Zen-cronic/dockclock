import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { FunctionUrlOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { WORKSPACE_INDEX } from "./core-stack.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Only names and ARNs are needed: the API never gets a grant method's broader permissions.
interface TableRef {
  tableName: string;
  tableArn: string;
}
interface BucketRef {
  bucketName: string;
  arnForObjects(pattern: string): string;
}

export interface ReadApiProps {
  table: TableRef;
  evidenceBucket: BucketRef;
  mediaBucket: BucketRef;
  account: string;
  // The private demo yard (DOCKCLOCK_DEMO_FACILITY), so its pins can be checked. Never returned.
  demoFacility?: string;
  // Needs an account concurrency limit above 10 + this number.
  reservedConcurrency?: number;
}

// The console read API: one Lambda behind a function URL that only CloudFront can call (origin
// access control, IAM auth), served at /api/* on the desk's distribution. Its role can only read:
// Query and BatchGetItem on the load table and its byWorkspace index, GetObject on packs and driver
// media. Polling is absorbed by CloudFront's 3-second cache and a short timeout. Reserved concurrency
// is an option (reservedConcurrency), but an account still on the default limit of 10 concurrent
// executions cannot reserve any: Lambda keeps 10 unreserved.
export class ReadApi extends Construct {
  readonly fn: NodejsFunction;
  readonly url: lambda.FunctionUrl;
  readonly cachePolicy: cloudfront.CachePolicy;

  constructor(scope: Construct, id: string, props: ReadApiProps) {
    super(scope, id);
    const manifest = JSON.parse(readFileSync(join(repoRoot, "docs", "evidence", "MANIFEST.json"), "utf8")) as { publicKey: { spkiSha256: string } };
    this.fn = new NodejsFunction(this, "Handler", {
      entry: join(repoRoot, "services", "api", "handler.ts"),
      projectRoot: repoRoot,
      depsLockFilePath: join(repoRoot, "package-lock.json"),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(10),
      ...(props.reservedConcurrency ? { reservedConcurrentExecutions: props.reservedConcurrency } : {}),
      tracing: lambda.Tracing.ACTIVE,
      loggingFormat: lambda.LoggingFormat.JSON,
      logGroup: new logs.LogGroup(this, "Logs", { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY }),
      environment: {
        TABLE_NAME: props.table.tableName,
        EVIDENCE_BUCKET: props.evidenceBucket.bucketName,
        MEDIA_BUCKET: props.mediaBucket.bucketName,
        ACCOUNT_ID: props.account,
        EVIDENCE_SPKI_SHA256: manifest.publicKey.spkiSha256,
        NODE_OPTIONS: "--enable-source-maps",
        ...(props.demoFacility ? { DEMO_FACILITY: props.demoFacility } : {}),
      },
      bundling: { format: OutputFormat.CJS, minify: true, sourceMap: true, externalModules: [], esbuildArgs: { "--conditions": "source" } },
    });
    this.fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["dynamodb:Query"], resources: [props.table.tableArn, `${props.table.tableArn}/index/${WORKSPACE_INDEX}`] }));
    this.fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["dynamodb:BatchGetItem"], resources: [props.table.tableArn] }));
    this.fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [props.evidenceBucket.arnForObjects("packs/*"), props.mediaBucket.arnForObjects("media/*"), props.mediaBucket.arnForObjects("rcs-inbound/*")] }));
    this.url = this.fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    // About 3 s for JSON (it says max-age=3), longer for photos (max-age=300); query strings count.
    this.cachePolicy = new cloudfront.CachePolicy(this, "Cache", {
      comment: "DockClock read API: honour the API's short max-age",
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(3),
      maxTtl: Duration.seconds(300),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
  }

  // The /api/* behaviour for the desk's distribution.
  behavior(): cloudfront.BehaviorOptions {
    return {
      origin: FunctionUrlOrigin.withOriginAccessControl(this.url),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
      cachePolicy: this.cachePolicy,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
    };
  }
}

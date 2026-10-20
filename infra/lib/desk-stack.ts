import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import type { DockClockConfig } from "./config.js";
import type { CoreStack } from "./core-stack.js";
import { ReadApi } from "./read-api.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// What the desk serves: the built site when site/dist exists, otherwise a placeholder page.
export function deskSource(root = repoRoot): string {
  const built = join(root, "site", "dist");
  return existsSync(join(built, "index.html")) ? built : join(root, "infra", "desk-placeholder");
}

export interface DeskStackProps extends StackProps {
  core: CoreStack;
  config: DockClockConfig;
  source?: string;
}

// The console and judge desk: a static app in a private bucket, served only through CloudFront
// (origin access control) over HTTPS, with the read-only console API at /api/* on the same origin
// (so no CORS). Nothing here can write to a load.
export class DeskStack extends Stack {
  readonly distribution: cloudfront.Distribution;
  readonly api: ReadApi;

  constructor(scope: Construct, id: string, props: DeskStackProps) {
    super(scope, id, props);
    const bucket = new s3.Bucket(this, "DeskSite", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    // Bucket declares isWebsite as optional, which IBucket does not under exactOptionalPropertyTypes.
    const site = bucket as unknown as s3.IBucket;
    // Paths without a file extension (for example /d/<token>) load the page; files keep real 404s,
    // so a missing replay file is reported as missing, not served as HTML.
    const rewrite = new cloudfront.Function(this, "PageRewrite", {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        "function handler(event) { var r = event.request; if (r.uri.indexOf('.') === -1) { r.uri = '/index.html'; } return r; }",
      ),
    });
    this.api = new ReadApi(this, "ReadApi", {
      table: props.core.table,
      evidenceBucket: props.core.evidenceBucket,
      mediaBucket: props.core.mediaBucket,
      account: props.config.account,
      ...(props.config.demoFacility ? { demoFacility: props.config.demoFacility } : {}),
    });
    this.distribution = new cloudfront.Distribution(this, "Desk", {
      comment: "DockClock judge desk",
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [{ function: rewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      // The page rewrite is on the default behaviour only, so /api/* reaches the API untouched.
      additionalBehaviors: { "/api/*": this.api.behavior() },
    });
    new BucketDeployment(this, "DeployDesk", {
      sources: [Source.asset(props.source ?? deskSource())],
      destinationBucket: site,
      distribution: this.distribution,
      distributionPaths: ["/*"],
      memoryLimit: 512,
    });
    new CfnOutput(this, "DeskUrl", { value: `https://${this.distribution.distributionDomainName}` });
  }
}

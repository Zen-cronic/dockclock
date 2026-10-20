import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// What the desk serves: the built site when site/dist exists, otherwise a placeholder page.
export function deskSource(root = repoRoot): string {
  const built = join(root, "site", "dist");
  return existsSync(join(built, "index.html")) ? built : join(root, "infra", "desk-placeholder");
}

// The judge desk: a static page in a private bucket, served only through CloudFront (origin access
// control) over HTTPS. It reads published replay files; it has no API and no write path.
export class DeskStack extends Stack {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: StackProps & { source?: string }) {
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

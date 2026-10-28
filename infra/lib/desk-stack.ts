import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Annotations, CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import type { DockClockConfig } from "./config.js";
import type { CoreStack } from "./core-stack.js";
import { ReadApi } from "./read-api.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Asking for the placeholder page on purpose: DOCKCLOCK_DESK_PLACEHOLDER=1, or the CDK context
// value dockclock:deskPlaceholder=1 (cdk deploy -c dockclock:deskPlaceholder=1).
export const DESK_PLACEHOLDER_ENV = "DOCKCLOCK_DESK_PLACEHOLDER";
export const DESK_PLACEHOLDER_CONTEXT = "dockclock:deskPlaceholder";

// What the desk serves: the built site (site/dist). The deployment prunes the bucket, so deploying
// the placeholder by accident would take the live console down. Without a build, and without the
// placeholder asked for, the result carries an error that the DeskStack records as an annotation:
// the CDK CLI then refuses to synthesize or deploy the desk. The CLI checks annotations on every
// stack it was asked for, so `cdk deploy --all` would stop every stack; `npm run deploy` therefore
// stops before deploying anything when there is no build, unless --allow-skip-desk ships the other
// stacks without the desk (deploy-stacks.ts).
export interface DeskSource {
  path: string;
  error: string | null;
}

export function deskSource(root = repoRoot, placeholder = process.env[DESK_PLACEHOLDER_ENV] === "1"): DeskSource {
  const built = join(root, "site", "dist");
  if (existsSync(join(built, "index.html"))) return { path: built, error: null };
  const page = join(root, "infra", "desk-placeholder");
  if (placeholder) return { path: page, error: null };
  return {
    path: page,
    error: `site/dist/index.html is missing: run npm run build -w @dockclock/site before deploying the desk, or set ${DESK_PLACEHOLDER_ENV}=1 to deploy the placeholder page (it replaces the live console).`,
  };
}

export const DESK_DOMAIN_ENV = "DOCKCLOCK_DESK_DOMAIN";
export const DESK_CERT_ARN_ENV = "DOCKCLOCK_DESK_CERT_ARN";

export interface DeskDomain {
  domainNames: string[];
  certificateArn: string;
}

// The desk's optional custom domain: the apex and www, on an ACM certificate that CloudFront can use
// (us-east-1 only). Neither value set: null, and the distribution keeps only its default hostname.
// One without the other, or a value CloudFront would reject, throws so the synth fails here instead
// of half-way through a deploy.
export function deskDomain(config: Pick<DockClockConfig, "deskDomain" | "deskCertArn">): DeskDomain | null {
  const domain = config.deskDomain.trim().toLowerCase();
  const certificateArn = config.deskCertArn.trim();
  if (!domain && !certificateArn) return null;
  if (!domain || !certificateArn) {
    const [set, missing] = domain ? [DESK_DOMAIN_ENV, DESK_CERT_ARN_ENV] : [DESK_CERT_ARN_ENV, DESK_DOMAIN_ENV];
    throw new Error(`${set} is set but ${missing} is not: set both for a custom desk domain, or neither (see .env.example).`);
  }
  // Each label is letters, digits and hyphens, and starts and ends with a letter or digit.
  if (!/^(?!www\.)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw new Error(`${DESK_DOMAIN_ENV} must be a bare domain such as example.com (no scheme, path or www.; www. is added): got "${domain}".`);
  }
  if (!/^arn:aws:acm:us-east-1:[^:]+:certificate\/.+$/.test(certificateArn)) {
    throw new Error(`${DESK_CERT_ARN_ENV} must be an ACM certificate ARN in us-east-1 (CloudFront uses certificates from there only).`);
  }
  return { domainNames: [domain, `www.${domain}`], certificateArn };
}

export interface DeskStackProps extends StackProps {
  core: CoreStack;
  config: DockClockConfig;
  source?: string;
  // The repository root the site build is looked for in (tests point it at a temporary folder).
  root?: string;
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
      // Caps what judge polling can use, so the console can never crowd out the driver loop. The
      // account limit is 1000 (quota L-B99A9384, granted 2026-10-20).
      reservedConcurrency: 50,
    });
    const domain = deskDomain(props.config);
    this.distribution = new cloudfront.Distribution(this, "Desk", {
      comment: "DockClock judge desk",
      // The default *.cloudfront.net hostname keeps working alongside the custom names.
      ...(domain
        ? {
            domainNames: domain.domainNames,
            certificate: acm.Certificate.fromCertificateArn(this, "DeskCertificate", domain.certificateArn),
          }
        : {}),
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
    const source = props.source
      ? { path: props.source, error: null }
      : deskSource(props.root ?? repoRoot, process.env[DESK_PLACEHOLDER_ENV] === "1" || String(this.node.tryGetContext(DESK_PLACEHOLDER_CONTEXT)) === "1");
    if (source.error) Annotations.of(this).addError(source.error);
    new BucketDeployment(this, "DeployDesk", {
      sources: [Source.asset(source.path)],
      destinationBucket: site,
      distribution: this.distribution,
      distributionPaths: ["/*"],
      memoryLimit: 512,
    });
    new CfnOutput(this, "DeskUrl", { value: `https://${this.distribution.distributionDomainName}` });
    if (domain) {
      // Point these names at the DeskUrl hostname at the DNS host (CNAME, or ALIAS for the apex).
      new CfnOutput(this, "DeskDomainNames", { value: domain.domainNames.join(",") });
      new CfnOutput(this, "DeskCustomUrl", { value: `https://${domain.domainNames[0]}` });
    }
  }
}

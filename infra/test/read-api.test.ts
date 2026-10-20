import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import { describe, expect, it } from "vitest";
import { ReadApi } from "../lib/read-api.js";

describe("read API construct", () => {
  const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
  const stack = new Stack(app, "ReadApiTest", { env: { account: "111122223333", region: "us-east-1" } });
  const table = new dynamodb.TableV2(stack, "Loads", { partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING }, sortKey: { name: "sk", type: dynamodb.AttributeType.STRING } });
  const evidence = new s3.Bucket(stack, "Evidence");
  const media = new s3.Bucket(stack, "Media");
  const site = new s3.Bucket(stack, "Site");
  const api = new ReadApi(stack, "Api", { table, evidenceBucket: evidence, mediaBucket: media, account: "111122223333" });
  new cloudfront.Distribution(stack, "Desk", { defaultBehavior: { origin: S3BucketOrigin.withOriginAccessControl(site as unknown as s3.IBucket) }, additionalBehaviors: { "/api/*": api.behavior() } });
  const t = Template.fromStack(stack);

  it("can only read: no write, delete or scan action anywhere in its role", () => {
    const policies = JSON.stringify(t.findResources("AWS::IAM::Policy"));
    for (const action of ["dynamodb:Query", "dynamodb:BatchGetItem", "s3:GetObject"]) expect(policies).toContain(action);
    expect(policies).not.toMatch(/dynamodb:(Put|Update|Delete|Scan|BatchWrite)|s3:(Put|Delete)/);
    expect(policies).toContain("/index/byWorkspace");
  });

  it("is reachable only through CloudFront, with capped concurrency", () => {
    t.hasResourceProperties("AWS::Lambda::Url", { AuthType: "AWS_IAM" });
    t.hasResourceProperties("AWS::Lambda::Function", { ReservedConcurrentExecutions: 10 });
    t.resourceCountIs("AWS::CloudFront::OriginAccessControl", 2);
    t.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({ CacheBehaviors: [Match.objectLike({ PathPattern: "/api/*", ViewerProtocolPolicy: "redirect-to-https", AllowedMethods: ["GET", "HEAD"] })] }),
    });
    t.hasResourceProperties("AWS::CloudFront::CachePolicy", { CachePolicyConfig: Match.objectLike({ DefaultTTL: 3, ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({ QueryStringsConfig: { QueryStringBehavior: "all" } }) }) });
  });
});

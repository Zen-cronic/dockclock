import * as iam from "aws-cdk-lib/aws-iam";
import type * as s3 from "aws-cdk-lib/aws-s3";
import * as smsvoice from "aws-cdk-lib/aws-smsvoice";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";

export const RCS_TOPIC_NAME = "dockclock-rcs-events";
export const RCS_CONFIGURATION_SET_NAME = "dockclock-rcs";
// End User Messaging stores inbound media at {prefix}/rcs/{messageId}#{fileName}.
export const RCS_MEDIA_PREFIX = "rcs-inbound";

export interface RcsChannelProps {
  account: string;
  region: string;
  agentId: string;
  mediaBucket: s3.Bucket;
}

// The RCS lane for drivers without WhatsApp, and the failover for those whose WhatsApp fails. One
// topic receives both the agent's two-way traffic (taps, pins, photos) and its delivery events, and
// feeds the same ingest queue as WhatsApp. Two-way itself is switched on outside CloudFormation
// (update-rcs-agent), because the agent was created by hand and is not managed by this app.
export class RcsChannel extends Construct {
  readonly topic: sns.Topic;
  readonly twoWayRole: iam.Role;
  readonly mediaRole: iam.Role;
  readonly sendRcs: iam.PolicyStatement;
  readonly environment: Record<string, string>;

  constructor(scope: Construct, id: string, props: RcsChannelProps) {
    super(scope, id);
    const service = new iam.ServicePrincipal("sms-voice.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": props.account } } });

    this.topic = new sns.Topic(this, "Events", { topicName: RCS_TOPIC_NAME, enforceSSL: true });
    // Delivery events from the configuration set are published by the service itself.
    this.topic.addToResourcePolicy(new iam.PolicyStatement({ principals: [service], actions: ["sns:Publish"], resources: [this.topic.topicArn] }));

    this.twoWayRole = new iam.Role(this, "TwoWayRole", { assumedBy: service, description: "Lets End User Messaging publish inbound RCS messages to the DockClock topic." });
    this.topic.grantPublish(this.twoWayRole);

    this.mediaRole = new iam.Role(this, "MediaRole", { assumedBy: service, description: "Lets End User Messaging store inbound RCS photos for DockClock." });
    this.mediaRole.addToPolicy(new iam.PolicyStatement({ actions: ["s3:PutObject"], resources: [props.mediaBucket.arnForObjects(`${RCS_MEDIA_PREFIX}/*`)] }));

    new smsvoice.CfnConfigurationSet(this, "ConfigurationSet", {
      configurationSetName: RCS_CONFIGURATION_SET_NAME,
      eventDestinations: [{ eventDestinationName: "dockclock-rcs-ingest", enabled: true, matchingEventTypes: ["RCS_ALL"], snsDestination: { topicArn: this.topic.topicArn } }],
    });

    const arn = (resource: string) => `arn:aws:sms-voice:${props.region}:${props.account}:${resource}`;
    this.sendRcs = new iam.PolicyStatement({
      actions: ["sms-voice:SendRcsMessage"],
      resources: [arn(`rcs-agent/${props.agentId}`), arn(`configuration-set/${RCS_CONFIGURATION_SET_NAME}`)],
    });
    this.environment = { RCS_AGENT_ID: props.agentId, RCS_TOPIC_ARN: this.topic.topicArn, RCS_CONFIGURATION_SET: RCS_CONFIGURATION_SET_NAME };
  }
}

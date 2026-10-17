import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sns from "aws-cdk-lib/aws-sns";
import type { Construct } from "constructs";

export const CONFIGURATION_SET_NAME = "dockclock-claims";

// Every notice and claim email goes out through this configuration set. Bounces, complaints,
// rejects and deliveries are published to SNS (consumed by the email packet to mark a load's contact
// undeliverable), and account reputation alarms fire well below the SES review thresholds.
export class EmailStack extends Stack {
  readonly configurationSet: ses.ConfigurationSet;
  readonly emailEvents: sns.Topic;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    this.emailEvents = new sns.Topic(this, "EmailEvents", { displayName: "DockClock email delivery events", enforceSSL: true });
    this.configurationSet = new ses.ConfigurationSet(this, "Claims", {
      configurationSetName: CONFIGURATION_SET_NAME,
      reputationMetrics: true,
      sendingEnabled: true,
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
    });
    this.configurationSet.addEventDestination("ToSns", {
      destination: ses.EventDestination.snsTopic(this.emailEvents),
      events: [ses.EmailSendingEvent.BOUNCE, ses.EmailSendingEvent.COMPLAINT, ses.EmailSendingEvent.REJECT, ses.EmailSendingEvent.DELIVERY],
    });

    const reputation = (metricName: string, threshold: number, description: string) =>
      new cloudwatch.Alarm(this, metricName.replace(".", ""), {
        alarmDescription: description,
        metric: new cloudwatch.Metric({ namespace: "AWS/SES", metricName, statistic: "Maximum", period: Duration.hours(1) }),
        threshold,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    reputation("Reputation.BounceRate", 0.02, "SES account bounce rate above 2%.");
    reputation("Reputation.ComplaintRate", 0.001, "SES account complaint rate above 0.1%.");

    new CfnOutput(this, "ConfigurationSetName", { value: CONFIGURATION_SET_NAME });
    new CfnOutput(this, "EmailEventsTopicArn", { value: this.emailEvents.topicArn });
  }
}

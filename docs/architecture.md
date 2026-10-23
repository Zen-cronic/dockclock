# DockClock architecture

![DockClock architecture: driver and dispatcher phones, AWS End User Messaging, the Step Functions load lifecycle, sealed evidence, the AgentCore claims agent behind Cedar, Amazon SES, and the judge console on CloudFront](architecture.png)

Source: [`architecture.mmd`](architecture.mmd) (Mermaid). Vector copy: [`architecture.svg`](architecture.svg). Re-render both with `npx tsx scripts/render-architecture.ts`.

**The trust split.** The model reads and drafts: it reads the bill-of-lading photo and writes the claim email. Code and Cedar decide: the deterministic clause engine sets the verdict and the amount, the dispatcher's tap approves, Cedar allows the claim tool only with an approval and an amount under the cap, and the tool refuses unless the amount and pack digest equal the sealed values.

## Key

| Color | Meaning |
|---|---|
| Yellow | People and their inboxes |
| Blue | AWS services and DockClock Lambdas |
| Grey, rounded | Step Functions states, numbered in order |
| Teal | Stored state, evidence and keys |
| Green, thick border | Where code or Cedar decides |
| Purple | Where the model reads and drafts |

## AWS services, one job each

| Service | Its one job in DockClock |
|---|---|
| AWS End User Messaging Social | Sends and receives every WhatsApp message: the dispatch and approval templates, location requests, Flows and photo media. |
| AWS End User Messaging SMS-Voice v2 | Runs the RCS agent that reaches drivers without WhatsApp and takes over when a WhatsApp send fails. |
| Amazon SNS | Carries inbound WhatsApp and RCS events (and SES delivery events) from the messaging services to DockClock. |
| Amazon SQS | Buffers every inbound event for the ingest Lambda, and parks an event that fails five times in a dead-letter queue. |
| AWS Lambda | Runs DockClock's code: ingest, dispatch, the wait steps, sealing, notices, approval requests, outcomes to the driver, the agent's tools, the agent invoker and the console's read API. |
| Amazon DynamoDB | Holds each load in one table, and the ingest Lambda writes one transaction per event that dedupes it, appends the timeline and queues the outbox. |
| AWS Step Functions | Runs one load lifecycle per load, waiting on task tokens for the driver's pins and Flow and the dispatcher's approval. |
| Amazon EventBridge Scheduler | Fires a one-time schedule, set after the Arrived pin, that sends the detention notice before free time ends. |
| Amazon S3 | Keeps the driver's photos (hashed) in a media bucket, the signed evidence packs and sent emails in an Object Lock bucket, and the console's static site. |
| AWS KMS | Signs each evidence pack with an ECDSA P-256 key whose public half lets anyone verify it offline. |
| AWS Secrets Manager | Holds the key that turns a phone number into an opaque driver id. |
| Amazon Bedrock | Runs Claude Sonnet 4.5, which reads the bill-of-lading photo and drafts the claim email. |
| Amazon Bedrock AgentCore Harness | Runs the claims agent's managed loop, whose only tools are DockClock's. |
| Amazon Bedrock AgentCore Gateway | Serves DockClock's tools to the agent over MCP with IAM auth. |
| AgentCore Policy (Cedar) | Authorizes every tool call in ENFORCE mode, default deny, and allows the claim tool only with an approval and an amount under the cap. |
| Amazon SES | Sends the detention notice and the claim with its signed pack to the broker or shipper, and escalations to dispatch, through the `dockclock-claims` configuration set. |
| Amazon CloudFront | Serves the judge console with no login, and routes `/api/*` to the read API, whose read-only role sees only demo-workspace loads and which refuses to send any response that would leak a phone number, location or id. |
| Amazon CloudWatch | Logs every function and alarms on dead-lettered events, failed lifecycles and SES bounce or complaint rates. |
| AWS X-Ray | Traces the load lifecycle and its Lambdas, so one load's path through the services can be followed. |
| AWS CDK | Deploys all of the above as five stacks: core, messaging, email, agent and desk (the console). |

// DynamoDB single-table keys. Every item a load owns shares its partition, so one Query returns
// the load's whole timeline.
export const keys = {
  load: (loadId: string) => ({ pk: `LOAD#${loadId}`, sk: "META" }),
  event: (loadId: string, serverAt: string, wamid: string) => ({ pk: `LOAD#${loadId}`, sk: `EVENT#${serverAt}#${wamid}` }),
  pack: (loadId: string, packId: string) => ({ pk: `LOAD#${loadId}`, sk: `PACK#${packId}` }),
  // An outbound message as the recipient saw it, in the load's own partition (no recipient).
  send: (loadId: string, sentAt: string, messageId: string) => ({ pk: `LOAD#${loadId}`, sk: `SEND#${sentAt}#${messageId}` }),
  dedupe: (wamid: string) => ({ pk: `WAMID#${wamid}`, sk: "DEDUPE" }),
  driver: (driverKey: string) => ({ pk: `DRIVER#${driverKey}`, sk: "ACTIVE" }),
  receipt: (messageId: string) => ({ pk: `MSG#${messageId}`, sk: "RECEIPT" }),
  optOut: (driverKey: string) => ({ pk: `OPTOUT#${driverKey}`, sk: "OPTOUT" }),
  demoUser: (driverKey: string) => ({ pk: `DEMOUSER#${driverKey}`, sk: "DEMO" }),
  demoQuota: (day: string, scope: string) => ({ pk: `DEMOQUOTA#${day}`, sk: scope }),
  approvalRequest: (loadId: string) => ({ pk: `LOAD#${loadId}`, sk: "APPROVAL_REQUEST" }),
  approval: (loadId: string) => ({ pk: `LOAD#${loadId}`, sk: "APPROVAL" }),
};

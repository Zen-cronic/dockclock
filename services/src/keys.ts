// DynamoDB single-table keys. Every item a load owns shares its partition, so one Query returns
// the load's whole timeline.
export const keys = {
  load: (loadId: string) => ({ pk: `LOAD#${loadId}`, sk: "META" }),
  event: (loadId: string, serverAt: string, wamid: string) => ({ pk: `LOAD#${loadId}`, sk: `EVENT#${serverAt}#${wamid}` }),
  pack: (loadId: string, packId: string) => ({ pk: `LOAD#${loadId}`, sk: `PACK#${packId}` }),
  dedupe: (wamid: string) => ({ pk: `WAMID#${wamid}`, sk: "DEDUPE" }),
  driver: (driverKey: string) => ({ pk: `DRIVER#${driverKey}`, sk: "ACTIVE" }),
  receipt: (messageId: string) => ({ pk: `MSG#${messageId}`, sk: "RECEIPT" }),
  optOut: (driverKey: string) => ({ pk: `OPTOUT#${driverKey}`, sk: "OPTOUT" }),
};

// Submits every template language in packages/whatsapp/templates.json to Meta through AWS End User
// Messaging Social. Existing name+language pairs are skipped, so the script is safe to re-run.
import { readFileSync } from "node:fs";
import {
  CreateWhatsAppMessageTemplateCommand,
  ListWhatsAppMessageTemplatesCommand,
  SocialMessagingClient,
} from "@aws-sdk/client-socialmessaging";

interface Version {
  body: string;
  footer?: string;
  buttons?: string[];
  sample: string[];
}
interface TemplateFile {
  category: string;
  templates: Array<{ name: string; languages: Record<string, Version> }>;
}

const wabaId = process.env.DOCKCLOCK_WABA_ID ?? "waba-b2da293205004d808d988d2a9e4bbaf8";
const file = JSON.parse(readFileSync(new URL("../packages/whatsapp/templates.json", import.meta.url), "utf8")) as TemplateFile;
const client = new SocialMessagingClient({});

const existing = new Set<string>();
let nextToken: string | undefined;
do {
  const page = await client.send(new ListWhatsAppMessageTemplatesCommand({ id: wabaId, nextToken }));
  for (const t of page.templates ?? []) existing.add(`${t.templateName}|${t.templateLanguage}`);
  nextToken = page.nextToken;
} while (nextToken);

function definition(name: string, language: string, v: Version) {
  const components: Record<string, unknown>[] = [{ type: "BODY", text: v.body, example: { body_text: [v.sample] } }];
  if (v.footer) components.push({ type: "FOOTER", text: v.footer });
  if (v.buttons?.length) components.push({ type: "BUTTONS", buttons: v.buttons.map((text) => ({ type: "QUICK_REPLY", text })) });
  return { name, language, category: file.category, components };
}

let failed = 0;
for (const template of file.templates) {
  for (const [language, version] of Object.entries(template.languages)) {
    const label = `${template.name} ${language}`;
    if (existing.has(`${template.name}|${language}`)) {
      console.log(`skip   ${label} (already exists)`);
      continue;
    }
    try {
      const out = await client.send(
        new CreateWhatsAppMessageTemplateCommand({
          id: wabaId,
          templateDefinition: Buffer.from(JSON.stringify(definition(template.name, language, version))),
        }),
      );
      console.log(`sent   ${label} -> ${out.templateStatus ?? "?"} (${out.category ?? "?"}, meta id ${out.metaTemplateId ?? "?"})`);
    } catch (error) {
      failed++;
      console.log(`FAILED ${label}: ${(error as Error).name}: ${(error as Error).message}`);
    }
  }
}
process.exit(failed ? 1 : 0);

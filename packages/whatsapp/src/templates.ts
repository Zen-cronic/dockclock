// The approved wording of each WhatsApp template, so a send can be recorded as the text the
// driver actually read. Must equal packages/whatsapp/templates.json (pinned by a test).
export interface TemplateText {
  body: string;
  footer?: string;
  buttons?: string[];
}

export const TEMPLATE_TEXT: Record<string, Record<string, TemplateText>> = {
  "dockclock_load_dispatch": {
    "en_US": {
      "body": "Load {{1}} is booked: {{2}}, appointment {{3}}. When you are parked at the dock, tap Arrived and we will start the detention clock.",
      "footer": "Reply STOP to stop load messages.",
      "buttons": [
        "Arrived",
        "Talk to dispatch"
      ]
    },
    "es_MX": {
      "body": "La carga {{1}} está confirmada: {{2}}, cita {{3}}. Cuando esté estacionado en el andén, toque Llegué y empezaremos a contar el tiempo de espera.",
      "footer": "Responda STOP para dejar de recibir estos mensajes.",
      "buttons": [
        "Llegué",
        "Hablar con despacho"
      ]
    },
    "fr_CA": {
      "body": "Le chargement {{1}} est confirmé : {{2}}, rendez-vous {{3}}. Une fois stationné au quai, appuyez sur Arrivé et nous lancerons le chrono d'attente.",
      "footer": "Répondez STOP pour arrêter ces messages.",
      "buttons": [
        "Arrivé",
        "Parler à la répartition"
      ]
    }
  },
  "dockclock_notice_sent": {
    "en_US": {
      "body": "Load {{1}}: free time ends at {{2}}. We emailed {{3}} the detention notice your contract requires. Updates will arrive in this chat."
    },
    "es_MX": {
      "body": "Carga {{1}}: el tiempo libre termina a las {{2}}. Enviamos por correo a {{3}} el aviso de demora que exige su contrato. Las novedades llegarán a este chat."
    },
    "fr_CA": {
      "body": "Chargement {{1}} : le temps alloué se termine à {{2}}. Nous avons envoyé par courriel à {{3}} l'avis de temps d'attente exigé par votre contrat. Les mises à jour arriveront dans cette conversation."
    }
  },
  "dockclock_dispatch_approval": {
    "en_US": {
      "body": "Load {{1}} needs your decision before any claim is sent: {{2}}. Proposed claim: {{3}}. Nothing goes to the broker until you approve.",
      "buttons": [
        "Approve claim",
        "Hold"
      ]
    },
    "es_MX": {
      "body": "La carga {{1}} necesita su decisión antes de enviar cualquier reclamo: {{2}}. Reclamo propuesto: {{3}}. Nada se envía al bróker hasta que usted lo apruebe.",
      "buttons": [
        "Aprobar reclamo",
        "Retener"
      ]
    },
    "fr_CA": {
      "body": "Le chargement {{1}} demande votre décision avant l'envoi de toute réclamation : {{2}}. Réclamation proposée : {{3}}. Rien n'est envoyé au courtier avant votre approbation.",
      "buttons": [
        "Approuver la réclamation",
        "Mettre en attente"
      ]
    }
  }
};

// Fills {{1}}, {{2}}, ... with the send's body parameters. Null when the template or language is unknown.
export function renderTemplate(name: string, language: string, parameters: readonly string[]): (TemplateText & { body: string }) | null {
  const text = TEMPLATE_TEXT[name]?.[language];
  if (!text) return null;
  const body = text.body.replace(/\{\{(\d+)\}\}/g, (whole, n: string) => parameters[Number(n) - 1] ?? whole);
  return { ...text, body };
}

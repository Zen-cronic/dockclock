import type { MessageKey } from "./lifecycle.js";

export type Language = "en_US" | "es_MX" | "fr_CA";
export const LANGUAGES: readonly Language[] = ["en_US", "es_MX", "fr_CA"];

interface Copy {
  locale: string;
  locationArrived: string;
  locationReleased: string;
  checkedIn: (facility: string, time: string) => string;
  released: string;
  talkToDispatch: string;
  releaseFlowBody: (facility: string) => string;
  releaseFlowCta: string;
  replies: Record<MessageKey, string>;
  // The RCS twin of the dockclock_notice_sent template, same wording.
  noticeSent: (loadId: string, freeTimeEnds: string, counterparty: string) => string;
  // The one retake request, with the time the first photo is used if no clearer one arrives.
  retakeAsk: (fallbackAt: string) => string;
  stopped: string;
  resumed: string;
  rcs: RcsCopy;
}

// RCS has no templates and no Flows: the dispatch is a rich card, the bill of lading a photo reply.
interface RcsCopy {
  arrived: string;
  shareLocation: string;
  dispatchTitle: (loadId: string) => string;
  dispatch: (facility: string, appointment: string) => string;
  checkedIn: (facility: string, time: string) => string;
  bolRequest: (facility: string) => string;
}

// Free-form driver messages, sent inside the 24-hour window the dispatch template opens. Template
// wording lives in packages/whatsapp/templates.json; these are the in-conversation replies.
export const COPY: Record<Language, Copy> = {
  en_US: {
    locale: "en-US",
    locationArrived: "Share your location to start the dock clock. Only send it while parked.",
    locationReleased: "Share your location once more to stop the dock clock.",
    checkedIn: (facility, time) => `Checked in at ${facility} at ${time} (WhatsApp server time). Tap Released when you are unloaded and leaving the door.`,
    released: "Released",
    talkToDispatch: "Talk to dispatch",
    releaseFlowBody: (facility) => `Clock stopped at ${facility}. Add a photo of the signed bill of lading so the times on paper back up your pins.`,
    releaseFlowCta: "Add BOL photo",
    replies: {
      tap_arrived_first: "Tap Arrived and share your location first.",
      dispatch_notified: "Dispatch has been notified and will contact you shortly.",
      bol_received: "Got it. Your photo and times are saved with this load's evidence.",
      bol_incomplete: "We need at least one photo and your OK to share it. Please try again.",
      bol_partial: "Some pages could not be saved. Dispatch has been told and will follow up.",
      bol_times_unreadable: "We could not read one of the times. Please enter them like 13:52 or 1:52 PM.",
      flow_limit: "We could not save your paperwork. Dispatch has been told and will follow up.",
      load_closed: "That load is already closed. Please use the newest message from dispatch.",
      use_bol_button: "Please send the bill of lading with the Add BOL photo button so it is saved with this load.",
      bol_photo_received: "Got it. Your photo is saved with this load's evidence.",
    },
    retakeAsk: (at) => `That photo is hard to read. Please take one more of the bill of lading: flat, in good light and in focus. If none arrives by ${at}, we use the first photo.`,
    noticeSent: (loadId, ends, counterparty) => `Load ${loadId}: free time ends at ${ends}. We emailed ${counterparty} the detention notice your contract requires. Updates will arrive in this chat.`,
    stopped: "You will not get more load messages from DockClock. Reply START to turn them back on.",
    resumed: "Load messages are back on.",
    rcs: {
      arrived: "Arrived",
      shareLocation: "Share location",
      dispatchTitle: (loadId) => `Load ${loadId}`,
      dispatch: (facility, appointment) =>
        `Booked: ${facility}, appointment ${appointment}. When you are parked at the dock, tap Arrived and we will start the detention clock. Reply STOP to stop load messages.`,
      checkedIn: (facility, time) => `Checked in at ${facility} at ${time} (server time). Tap Released when you are unloaded and leaving the door.`,
      bolRequest: (facility) =>
        `Clock stopped at ${facility}. Reply with a photo of the signed bill of lading. It is saved with this load's evidence and shared with the broker on this load only.`,
    },
  },
  es_MX: {
    locale: "es-MX",
    locationArrived: "Comparta su ubicación para iniciar el reloj en el andén. Envíela solo cuando esté estacionado.",
    locationReleased: "Comparta su ubicación otra vez para detener el reloj.",
    checkedIn: (facility, time) => `Registro en ${facility} a las ${time} (hora del servidor de WhatsApp). Toque Liberado cuando termine la descarga y salga del andén.`,
    released: "Liberado",
    talkToDispatch: "Hablar con despacho",
    releaseFlowBody: (facility) => `Reloj detenido en ${facility}. Agregue una foto del BOL firmado para que las horas en papel respalden sus ubicaciones.`,
    releaseFlowCta: "Agregar foto del BOL",
    replies: {
      tap_arrived_first: "Primero toque Llegué y comparta su ubicación.",
      dispatch_notified: "Avisamos a despacho; se comunicarán con usted pronto.",
      bol_received: "Listo. Su foto y sus horas quedaron guardadas con la evidencia de esta carga.",
      bol_incomplete: "Necesitamos al menos una foto y su permiso para compartirla. Intente de nuevo.",
      bol_partial: "Algunas páginas no se pudieron guardar. Avisamos a despacho y le darán seguimiento.",
      bol_times_unreadable: "No pudimos leer una de las horas. Escríbalas como 13:52 o 1:52 PM.",
      flow_limit: "No pudimos guardar sus documentos. Avisamos a despacho y le darán seguimiento.",
      load_closed: "Esa carga ya está cerrada. Use el mensaje más reciente de despacho.",
      use_bol_button: "Envíe el BOL con el botón Agregar foto del BOL para guardarlo con esta carga.",
      bol_photo_received: "Listo. Su foto quedó guardada con la evidencia de esta carga.",
    },
    retakeAsk: (at) => `Esa foto no se lee bien. Tome otra del BOL: plano, con buena luz y enfocado. Si no llega antes de las ${at}, usamos la primera foto.`,
    noticeSent: (loadId, ends, counterparty) => `Carga ${loadId}: el tiempo libre termina a las ${ends}. Enviamos por correo a ${counterparty} el aviso de demora que exige su contrato. Las novedades llegarán a este chat.`,
    stopped: "Ya no recibirá mensajes de cargas de DockClock. Responda START para activarlos otra vez.",
    resumed: "Los mensajes de cargas están activos otra vez.",
    rcs: {
      arrived: "Llegué",
      shareLocation: "Compartir ubicación",
      dispatchTitle: (loadId) => `Carga ${loadId}`,
      dispatch: (facility, appointment) =>
        `Confirmada: ${facility}, cita ${appointment}. Cuando esté estacionado en el andén, toque Llegué y empezaremos a contar el tiempo de espera. Responda STOP para dejar de recibir estos mensajes.`,
      checkedIn: (facility, time) => `Registro en ${facility} a las ${time} (hora del servidor). Toque Liberado cuando termine la descarga y salga del andén.`,
      bolRequest: (facility) =>
        `Reloj detenido en ${facility}. Responda con una foto del BOL firmado. Se guarda con la evidencia de esta carga y se comparte solo con el bróker de esta carga.`,
    },
  },
  fr_CA: {
    locale: "fr-CA",
    locationArrived: "Partagez votre position pour lancer le chrono au quai. Envoyez-la seulement une fois stationné.",
    locationReleased: "Partagez votre position encore une fois pour arrêter le chrono.",
    checkedIn: (facility, time) => `Arrivée enregistrée à ${facility} à ${time} (heure du serveur WhatsApp). Appuyez sur Libéré une fois déchargé et sorti du quai.`,
    released: "Libéré",
    talkToDispatch: "Joindre répartiteur",
    releaseFlowBody: (facility) => `Chrono arrêté à ${facility}. Ajoutez une photo du connaissement signé pour que les heures sur papier confirment vos positions.`,
    releaseFlowCta: "Ajouter la photo",
    replies: {
      tap_arrived_first: "Appuyez d'abord sur Arrivé et partagez votre position.",
      dispatch_notified: "La répartition a été avisée et vous contactera sous peu.",
      bol_received: "C'est noté. Votre photo et vos heures sont enregistrées avec la preuve de ce chargement.",
      bol_incomplete: "Il faut au moins une photo et votre accord pour la partager. Veuillez réessayer.",
      bol_partial: "Certaines pages n'ont pas pu être enregistrées. La répartition a été avisée et fera le suivi.",
      bol_times_unreadable: "Nous n'avons pas pu lire une des heures. Inscrivez-les comme 13:52 ou 13 h 52.",
      flow_limit: "Nous n'avons pas pu enregistrer vos documents. La répartition a été avisée et fera le suivi.",
      load_closed: "Ce chargement est déjà fermé. Utilisez le message le plus récent de la répartition.",
      use_bol_button: "Envoyez le connaissement avec le bouton Ajouter la photo pour l'enregistrer avec ce chargement.",
      bol_photo_received: "C'est noté. Votre photo est enregistrée avec la preuve de ce chargement.",
    },
    retakeAsk: (at) => `Cette photo est difficile à lire. Prenez-en une autre du connaissement : à plat, bien éclairé et net. Si aucune n'arrive avant ${at}, nous utilisons la première photo.`,
    noticeSent: (loadId, ends, counterparty) => `Chargement ${loadId} : le temps alloué se termine à ${ends}. Nous avons envoyé par courriel à ${counterparty} l'avis de temps d'attente exigé par votre contrat. Les mises à jour arriveront dans cette conversation.`,
    stopped: "Vous ne recevrez plus de messages de chargement de DockClock. Répondez START pour les réactiver.",
    resumed: "Les messages de chargement sont réactivés.",
    rcs: {
      arrived: "Arrivé",
      shareLocation: "Partager ma position",
      dispatchTitle: (loadId) => `Chargement ${loadId}`,
      dispatch: (facility, appointment) =>
        `Confirmé : ${facility}, rendez-vous ${appointment}. Une fois stationné au quai, appuyez sur Arrivé et nous lancerons le chrono d'attente. Répondez STOP pour ne plus recevoir ces messages.`,
      checkedIn: (facility, time) => `Arrivée enregistrée à ${facility} à ${time} (heure du serveur). Appuyez sur Libéré une fois déchargé et sorti du quai.`,
      bolRequest: (facility) =>
        `Chrono arrêté à ${facility}. Répondez avec une photo du connaissement signé. Elle est enregistrée avec la preuve de ce chargement et partagée seulement avec le courtier de ce chargement.`,
    },
  },
};

export function formatAppointment(iso: string, timeZone: string, language: Language): string {
  return new Intl.DateTimeFormat(COPY[language].locale, { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

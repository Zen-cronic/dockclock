import { RELEASE_PIN_WINDOW_MINUTES } from "@dockclock/clause-engine";
import type { MessageKey } from "./lifecycle.js";

// How long the driver has after Released to share the location that confirms it.
const PIN_MINUTES = RELEASE_PIN_WINDOW_MINUTES;

export type Language = "en_US" | "es_MX" | "fr_CA";
export const LANGUAGES: readonly Language[] = ["en_US", "es_MX", "fr_CA"];

interface Copy {
  locale: string;
  locationArrived: string;
  // Sent after the Released tap: the zone-labelled time the clock stopped ("14:32 EDT"), then the
  // request for the pin that confirms it. An empty time (a load from before the tap was kept) drops the first line.
  locationReleased: (time: string) => string;
  // The time arrives zone-labelled ("14:25 EDT").
  checkedIn: (facility: string, time: string) => string;
  released: string;
  talkToDispatch: string;
  // The release time, zone-labelled, so the driver has both times in the chat before the form.
  releaseFlowBody: (facility: string, time: string) => string;
  releaseFlowCta: string;
  replies: Record<MessageKey, string>;
  // The RCS twin of the dockclock_notice_sent template. RCS has no template review, so this is the
  // shorter wording the template would get if it were resubmitted.
  noticeSent: (loadId: string, freeTimeEnds: string, counterparty: string) => string;
  // The one retake request: a zone-labelled clock time and the minutes left, after which the first
  // photo is used. A demo load asks for "the paper" (judges photograph any paper); others for the BOL.
  retakeAsk: (minutes: number, at: string, zone: string, demo: boolean) => string;
  stopped: string;
  resumed: string;
  rcs: RcsCopy;
}

// RCS has no templates and no Flows: the dispatch is a rich card, the bill of lading a photo reply.
// The check-in card uses the WhatsApp wording (checkedIn above).
interface RcsCopy {
  arrived: string;
  shareLocation: string;
  dispatchTitle: (loadId: string) => string;
  dispatch: (facility: string, appointment: string) => string;
  bolRequest: (facility: string, time: string) => string;
}

// Free-form driver messages, sent inside the 24-hour window the dispatch template opens. Template
// wording lives in packages/whatsapp/templates.json; these are the in-conversation replies.
// One message, one job: the first line says what happened or what to do now. Kept short enough to
// read on a phone without scrolling (services/test/copy-length.test.ts holds them to it).
export const COPY: Record<Language, Copy> = {
  en_US: {
    locale: "en-US",
    locationArrived: "Share your location to start the dock clock. Only send it while parked.",
    locationReleased: (time) => `${time ? `Clock stopped at ${time}.\n` : ""}Share your location within ${PIN_MINUTES} minutes to confirm the release.`,
    checkedIn: (facility, time) => `Checked in at ${facility}, ${time}.\nTap Released when you are unloaded and leaving the door.`,
    released: "Released",
    talkToDispatch: "Talk to dispatch",
    releaseFlowBody: (facility, time) => `Clock stopped at ${facility}, ${time}.\nAdd a photo of the signed bill of lading to back up your times.`,
    releaseFlowCta: "Add BOL photo",
    replies: {
      tap_arrived_first: "Tap Arrived and share your location first.",
      dispatch_notified: "We emailed dispatch. They will contact you.",
      bol_received: "Got it. Your photo and times are saved with this load.",
      bol_incomplete: "We need at least one photo and your OK to share it. Please try again.",
      bol_partial: "Some pages could not be saved. Dispatch has been told and will follow up.",
      bol_times_unreadable: "We could not read one of the times. Please enter them like 13:52 or 1:52 PM.",
      flow_limit: "We could not save your paperwork. Dispatch has been told and will follow up.",
      load_closed: "That load is already closed. Please use the newest message from dispatch.",
      use_bol_button: "Please use the Add BOL photo button, so the photo is saved with this load.",
      bol_photo_received: "Got it. Your photo is saved with this load.",
    },
    retakeAsk: (minutes, at, zone, demo) =>
      `That photo is hard to read. Please take one more of ${demo ? "the paper" : "the signed bill of lading"}: flat, well lit and in focus.\nIf none arrives by ${at} ${zone} (${minutes} ${minutes === 1 ? "minute" : "minutes"}), we use the first photo.`,
    noticeSent: (loadId, ends, counterparty) => `Detention notice sent to ${counterparty} for load ${loadId}. Free time ends at ${ends}.`,
    stopped: "You will not get more load messages from DockClock. Reply START to turn them back on.",
    resumed: "Load messages are back on.",
    rcs: {
      arrived: "Arrived",
      shareLocation: "Share location",
      dispatchTitle: (loadId) => `Load ${loadId}`,
      dispatch: (facility, appointment) =>
        `${facility}, appointment ${appointment}.\nTap Arrived when you are parked at the dock to start the detention clock.\nReply STOP to stop load messages.`,
      bolRequest: (facility, time) =>
        `Clock stopped at ${facility}, ${time}.\nReply with a photo of the signed bill of lading. We share it only with the broker on this load.`,
    },
  },
  es_MX: {
    locale: "es-MX",
    locationArrived: "Comparta su ubicación para iniciar el reloj en el andén. Envíela solo cuando esté estacionado.",
    locationReleased: (time) => `${time ? `Reloj detenido a las ${time}.\n` : ""}Comparta su ubicación en los próximos ${PIN_MINUTES} minutos para confirmar la salida.`,
    checkedIn: (facility, time) => `Registro en ${facility}, ${time}.\nToque Liberado cuando termine la descarga y salga del andén.`,
    released: "Liberado",
    talkToDispatch: "Hablar con despacho",
    releaseFlowBody: (facility, time) => `Reloj detenido en ${facility}, ${time}.\nAgregue una foto del BOL firmado para respaldar sus horas.`,
    releaseFlowCta: "Agregar foto del BOL",
    replies: {
      tap_arrived_first: "Primero toque Llegué y comparta su ubicación.",
      dispatch_notified: "Avisamos a despacho por correo. Se comunicarán con usted.",
      bol_received: "Listo. Su foto y sus horas quedaron guardadas con esta carga.",
      bol_incomplete: "Necesitamos al menos una foto y su permiso para compartirla. Intente de nuevo.",
      bol_partial: "Algunas páginas no se pudieron guardar. Avisamos a despacho y le darán seguimiento.",
      bol_times_unreadable: "No pudimos leer una de las horas. Escríbalas como 13:52 o 1:52 PM.",
      flow_limit: "No pudimos guardar sus documentos. Avisamos a despacho y le darán seguimiento.",
      load_closed: "Esa carga ya está cerrada. Use el mensaje más reciente de despacho.",
      use_bol_button: "Use el botón Agregar foto del BOL, para que la foto quede guardada con esta carga.",
      bol_photo_received: "Listo. Su foto quedó guardada con esta carga.",
    },
    retakeAsk: (minutes, at, zone, demo) =>
      `Esa foto no se lee bien. Tome otra ${demo ? "del papel" : "del BOL firmado"}: plano, con buena luz y enfocado.\nSi no llega antes de las ${at} ${zone} (${minutes} ${minutes === 1 ? "minuto" : "minutos"}), usamos la primera foto.`,
    noticeSent: (loadId, ends, counterparty) => `Aviso de demora enviado a ${counterparty} para la carga ${loadId}. El tiempo libre termina a las ${ends}.`,
    stopped: "Ya no recibirá mensajes de cargas de DockClock. Responda START para activarlos otra vez.",
    resumed: "Los mensajes de cargas están activos otra vez.",
    rcs: {
      arrived: "Llegué",
      shareLocation: "Compartir ubicación",
      dispatchTitle: (loadId) => `Carga ${loadId}`,
      dispatch: (facility, appointment) =>
        `${facility}, cita ${appointment}.\nToque Llegué cuando esté estacionado en el andén para empezar a contar el tiempo de espera.\nResponda STOP para dejar de recibir estos mensajes.`,
      bolRequest: (facility, time) =>
        `Reloj detenido en ${facility}, ${time}.\nResponda con una foto del BOL firmado. Solo la compartimos con el bróker de esta carga.`,
    },
  },
  fr_CA: {
    locale: "fr-CA",
    locationArrived: "Partagez votre position pour lancer le chrono au quai. Envoyez-la seulement une fois stationné.",
    locationReleased: (time) => `${time ? `Chrono arrêté à ${time}.\n` : ""}Partagez votre position d'ici ${PIN_MINUTES} minutes pour confirmer le départ.`,
    checkedIn: (facility, time) => `Arrivée enregistrée à ${facility}, ${time}.\nAppuyez sur Libéré une fois déchargé et sorti du quai.`,
    released: "Libéré",
    talkToDispatch: "Joindre répartiteur",
    releaseFlowBody: (facility, time) => `Chrono arrêté à ${facility}, ${time}.\nAjoutez une photo du connaissement signé pour appuyer vos heures.`,
    releaseFlowCta: "Ajouter la photo",
    replies: {
      tap_arrived_first: "Appuyez d'abord sur Arrivé et partagez votre position.",
      dispatch_notified: "Nous avons avisé la répartition par courriel. Elle vous contactera.",
      bol_received: "C'est noté. Votre photo et vos heures sont enregistrées avec ce chargement.",
      bol_incomplete: "Il faut au moins une photo et votre accord pour la partager. Veuillez réessayer.",
      bol_partial: "Certaines pages n'ont pas pu être enregistrées. La répartition a été avisée et fera le suivi.",
      bol_times_unreadable: "Nous n'avons pas pu lire une des heures. Inscrivez-les comme 13:52 ou 13 h 52.",
      flow_limit: "Nous n'avons pas pu enregistrer vos documents. La répartition a été avisée et fera le suivi.",
      load_closed: "Ce chargement est déjà fermé. Utilisez le message le plus récent de la répartition.",
      use_bol_button: "Utilisez le bouton Ajouter la photo, pour que la photo soit enregistrée avec ce chargement.",
      bol_photo_received: "C'est noté. Votre photo est enregistrée avec ce chargement.",
    },
    retakeAsk: (minutes, at, zone, demo) =>
      `Cette photo est difficile à lire. Prenez-en une autre ${demo ? "du papier" : "du connaissement signé"} : à plat, bien éclairé et net.\nSi aucune n'arrive avant ${at} ${zone} (${minutes} ${minutes === 1 ? "minute" : "minutes"}), nous utilisons la première photo.`,
    noticeSent: (loadId, ends, counterparty) => `Avis de temps d'attente envoyé à ${counterparty} pour le chargement ${loadId}. Le temps alloué se termine à ${ends}.`,
    stopped: "Vous ne recevrez plus de messages de chargement de DockClock. Répondez START pour les réactiver.",
    resumed: "Les messages de chargement sont réactivés.",
    rcs: {
      arrived: "Arrivé",
      shareLocation: "Partager ma position",
      dispatchTitle: (loadId) => `Chargement ${loadId}`,
      dispatch: (facility, appointment) =>
        `${facility}, rendez-vous ${appointment}.\nUne fois stationné au quai, appuyez sur Arrivé pour lancer le chrono d'attente.\nRépondez STOP pour ne plus recevoir ces messages.`,
      bolRequest: (facility, time) =>
        `Chrono arrêté à ${facility}, ${time}.\nRépondez avec une photo du connaissement signé. Nous la partageons seulement avec le courtier de ce chargement.`,
    },
  },
};

export function formatAppointment(iso: string, timeZone: string, language: Language): string {
  return new Intl.DateTimeFormat(COPY[language].locale, { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

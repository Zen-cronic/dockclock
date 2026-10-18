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
  stopped: string;
  resumed: string;
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
    },
    stopped: "You will not get more load messages from DockClock. Reply START to turn them back on.",
    resumed: "Load messages are back on.",
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
    },
    stopped: "Ya no recibirá mensajes de cargas de DockClock. Responda START para activarlos otra vez.",
    resumed: "Los mensajes de cargas están activos otra vez.",
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
    },
    stopped: "Vous ne recevrez plus de messages de chargement de DockClock. Répondez START pour les réactiver.",
    resumed: "Les messages de chargement sont réactivés.",
  },
};

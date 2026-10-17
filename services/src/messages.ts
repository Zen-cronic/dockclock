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
    },
  },
};

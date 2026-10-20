// Line icons drawn for the console (24px grid, 1.8 stroke). No icon font, no third-party set.
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const base = (p: P) => ({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, ...p });

export const IconOverview = (p: P) => (<svg {...base(p)}><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="5" rx="1.5" /><rect x="13" y="10" width="8" height="11" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /></svg>);
export const IconMessages = (p: P) => (<svg {...base(p)}><path d="M4 5h16v10H9l-5 4z" /><path d="M8 9h8M8 12h5" /></svg>);
export const IconLoads = (p: P) => (<svg {...base(p)}><rect x="3" y="4" width="18" height="16" rx="1.5" /><path d="M3 9h18M3 13h18M3 17h18" /></svg>);
export const IconJudges = (p: P) => (<svg {...base(p)}><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></svg>);
export const IconPlay = (p: P) => (<svg {...base(p)} fill="currentColor" stroke="none"><path d="M7 4.5v15l12-7.5z" /></svg>);
export const IconPause = (p: P) => (<svg {...base(p)} fill="currentColor" stroke="none"><rect x="6" y="4.5" width="4" height="15" rx="1" /><rect x="14" y="4.5" width="4" height="15" rx="1" /></svg>);
export const IconClose = (p: P) => (<svg {...base(p)}><path d="M6 6l12 12M18 6L6 18" /></svg>);
export const IconChevron = (p: P) => (<svg {...base(p)}><path d="M9 6l6 6-6 6" /></svg>);
export const IconWhatsApp = (p: P) => (<svg {...base(p)}><path d="M12 3.5a8.5 8.5 0 0 0-7.3 12.8L3.5 20.5l4.3-1.1A8.5 8.5 0 1 0 12 3.5z" /><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5" /></svg>);
export const IconRcs = (p: P) => (<svg {...base(p)}><rect x="3" y="4" width="18" height="13" rx="3" /><path d="M8 21l3-4" /><path d="M7.5 9h9M7.5 12.5h5" /></svg>);
export const IconEmail = (p: P) => (<svg {...base(p)}><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="M3.5 6l8.5 7 8.5-7" /></svg>);
export const IconSms = (p: P) => (<svg {...base(p)}><rect x="6" y="2.5" width="12" height="19" rx="2.5" /><path d="M10 18.5h4" /></svg>);
export const IconPin = (p: P) => (<svg {...base(p)}><path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z" /><circle cx="12" cy="10" r="2.2" /></svg>);
export const IconLock = (p: P) => (<svg {...base(p)}><rect x="5" y="10" width="14" height="10" rx="1.5" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>);
export const IconAgent = (p: P) => (<svg {...base(p)}><rect x="5" y="7" width="14" height="11" rx="2" /><path d="M12 3v4M9 12h.01M15 12h.01M9 15.5h6" /></svg>);
export const IconCheck = (p: P) => (<svg {...base(p)}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>);
export const IconStop = (p: P) => (<svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M8 8l8 8" /></svg>);
export const IconClock = (p: P) => (<svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>);
export const IconDoc = (p: P) => (<svg {...base(p)}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 15.5h6" /></svg>);
export const IconPhone = IconSms;

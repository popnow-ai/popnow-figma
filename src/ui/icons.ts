/** Line icons (24px grid, 1.75 stroke, currentColor). */

const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  sparkles: svg('<path d="M12 3.5l1.7 4.6 4.6 1.7-4.6 1.7L12 16.1l-1.7-4.6-4.6-1.7 4.6-1.7z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>'),
  edit: svg('<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M14 7l3 3"/>'),
  removeBg: svg('<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><circle cx="12" cy="10" r="2.5"/><path d="M7.5 17c.8-2.2 2.5-3.5 4.5-3.5s3.7 1.3 4.5 3.5"/>'),
  upscale: svg('<path d="M14 4h6v6"/><path d="M20 4l-7 7"/><rect x="4" y="12" width="8" height="8" rx="1.5"/>'),
  expand: svg('<rect x="8" y="8" width="8" height="8" rx="1.5"/><path d="M3 9V4h5M16 4h5v5M21 15v5h-5M8 20H3v-5"/>'),
  relight: svg('<circle cx="12" cy="12" r="3.5"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>'),
  angle: svg('<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2L9 5h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="13" r="3.2"/>'),
  layers: svg('<path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8z"/><path d="M3.5 12l8.5 4.5 8.5-4.5"/><path d="M3.5 16l8.5 4.5 8.5-4.5"/>'),
  video: svg('<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M10.5 9.5v5l4-2.5z"/>'),
  more: svg('<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>'),
  external: svg('<path d="M14 4h6v6M20 4l-8 8"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>'),
  select: svg('<path d="M5 3.5l13 7-5.6 1.6L10 18z"/><path d="M12.6 12.4L18 18"/>'),
  chevron: svg('<path d="M7 10l5 5 5-5"/>'),
  coin: svg('<circle cx="12" cy="12" r="8"/><path d="M9.5 12h5M12 9.5v5"/>'),
} as const;

export type IconName = keyof typeof ICONS;

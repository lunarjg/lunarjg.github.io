// Line icons in the spirit of SF Symbols (24×24, stroke = currentColor).
const P = {
  docs: '<rect x="4" y="3" width="13" height="17" rx="2"/><path d="M8 3v17M20 7v12a2 2 0 0 1-2 2H9"/>',
  star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z"/>',
  starFill: '<path fill="currentColor" d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.3 15.3L20.5 20.5"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2L5.5 5.5"/><circle cx="12" cy="12" r="6.6"/>',
  chevronLeft: '<path d="M15 4.5L7.5 12l7.5 7.5"/>',
  chevronRight: '<path d="M9 4.5l7.5 7.5L9 19.5"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronUp: '<path d="M6 15l6-6 6 6"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.3"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.3"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.3"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.3"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.8" cy="6" r=".9" fill="currentColor"/><circle cx="4.8" cy="12" r=".9" fill="currentColor"/><circle cx="4.8" cy="18" r=".9" fill="currentColor"/>',
  bookmark: '<path d="M6.5 3.5h11v17L12 16.2l-5.5 4.3z"/>',
  bookmarkFill: '<path fill="currentColor" d="M6.5 3.5h11v17L12 16.2l-5.5 4.3z"/>',
  more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  home: '<path d="M4 10.6L12 4l8 6.6V19a1 1 0 0 1-1 1h-4.6v-5.6H9.6V20H5a1 1 0 0 1-1-1z"/>',
  library: '<rect x="4" y="4" width="4" height="16" rx="1"/><rect x="9.5" y="6" width="4" height="14" rx="1"/><path d="M15.4 7.3l3.7-1 3 12.8-3.7 1z"/>',
  branch: '<circle cx="6.5" cy="5.5" r="2.2"/><circle cx="6.5" cy="18.5" r="2.2"/><circle cx="17.5" cy="7.5" r="2.2"/><path d="M6.5 7.7v8.6M17.5 9.7c0 4.3-5 3.8-9.6 7"/>',
  sync: '<path d="M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3"/><path d="M18.5 3v4h-4M5.5 21v-4h4"/>',
  sort: '<path d="M7 4v16M3.5 16.5L7 20l3.5-3.5M17 20V4M13.5 7.5L17 4l3.5 3.5"/>',
  cloud: '<path d="M7 18.5h10a4 4 0 0 0 .6-8 5.5 5.5 0 0 0-10.7 1A3.5 3.5 0 0 0 7 18.5z"/><path d="M12 11v5.5M9.8 14.3L12 16.5l2.2-2.2"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  cloudOff: '<path d="M7 18.5h10a4 4 0 0 0 .6-8 5.5 5.5 0 0 0-10.7 1A3.5 3.5 0 0 0 7 18.5z"/><path d="M4 4l16 16"/>',
  share: '<path d="M12 14.5V4M7.8 8.2L12 4l4.2 4.2"/><path d="M5 12.5v6A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.8" r=".7" fill="currentColor"/>',
  page: '<rect x="5.5" y="3" width="13" height="18" rx="1.5"/><path d="M9 8h6M9 12h6M9 16h3.5"/>',
  zoomFit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  google: '<path d="M20.5 12.2c0-.6-.1-1.2-.2-1.7H12v3.3h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.6-3.9 2.6-6.5z" fill="#4285F4" stroke="none"/><path d="M12 21c2.4 0 4.5-.8 5.9-2.2L15 16.5c-.8.5-1.8.9-3 .9-2.3 0-4.3-1.6-5-3.7H4v2.3A9 9 0 0 0 12 21z" fill="#34A853" stroke="none"/><path d="M7 13.7a5.4 5.4 0 0 1 0-3.4V8H4a9 9 0 0 0 0 8z" fill="#FBBC05" stroke="none"/><path d="M12 6.6c1.3 0 2.5.5 3.4 1.3L18 5.4A9 9 0 0 0 4 8l3 2.3c.7-2.1 2.7-3.7 5-3.7z" fill="#EA4335" stroke="none"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  pen: '<path d="M4.5 19.5l1.1-4.6L15.6 4.9a2.1 2.1 0 0 1 3 3L8.6 17.9z"/><path d="M13.6 6.9l3 3"/>',
  spread: '<rect x="3" y="5" width="8" height="14" rx="1.2"/><rect x="13" y="5" width="8" height="14" rx="1.2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><circle cx="12" cy="17" r=".7" fill="currentColor"/>',
  hdd: '<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M7 14.5h.01M10 14.5h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  wifi: '<path d="M3 9.5a13 13 0 0 1 18 0M6 13a8.5 8.5 0 0 1 12 0M9 16.5a4 4 0 0 1 6 0"/><circle cx="12" cy="19.5" r=".8" fill="currentColor"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.4l2.8 2.8L16.2 9.8"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  outline:'<path d="M4 6h16M8 12h12M8 18h12M4 12h.01M4 18h.01"/>',
};

/** The app mark (same drawing as the launcher icon): a notebook with a pen stroke on a blue tile. */
export const LOGO = `<svg class="brand-logo" viewBox="0 0 32 32" aria-hidden="true">
  <rect width="32" height="32" rx="7.2" fill="#0f766e"/>
  <rect x="7.7" y="6.4" width="17.3" height="19.3" rx="1.6" fill="#fff"/>
  <path d="M9.3 6.4H10v19.3H9.3a1.6 1.6 0 0 1-1.6-1.6V8a1.6 1.6 0 0 1 1.6-1.6z" fill="#cbe1e0"/>
  <path d="M12 12.2h11.8M12 15h11.8M12 17.9h11.8M12 20.9h11.8" stroke="#9dc7c4" stroke-width=".45"/>
  <path d="M12.2 14.4c1.2-2 2.4-2 3.6 0s2.4 2 3.6 0 2.4-2 3.6 0" fill="none" stroke="#0f766e" stroke-width=".95" stroke-linecap="round"/>
</svg>`;

export function icon(name, cls = '') {
  const body = P[name] || '';
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** Replace every `<span data-icon="x">` placeholder inside root with its SVG. */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (el.dataset.hydrated === el.dataset.icon) return;
    el.innerHTML = icon(el.dataset.icon);
    el.dataset.hydrated = el.dataset.icon;
  });
}

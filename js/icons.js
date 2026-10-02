/* Hand-drawn Spotify-style icon set (24x24 grid) */
const ICONS = {
home:'<path d="M12.7 3.3a1 1 0 0 0-1.4 0L2.6 12l1.4 1.4 1-1V21a1 1 0 0 0 1 1H10v-6h4v6h4a1 1 0 0 0 1-1v-8.6l1 1L21.4 12 12.7 3.3z"/>',
homeO:'<path d="M12.7 3.3a1 1 0 0 0-1.4 0L2.6 12l1.4 1.4 1-1V21a1 1 0 0 0 1 1H10v-6h4v6h4a1 1 0 0 0 1-1v-8.6l1 1L21.4 12 12.7 3.3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
search:'<circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16.5 16.5 21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
library:'<path d="M4 4v16M10 4v16M16.5 5.5 20 12l-3.5 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
bell:'<path d="M18 9a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 15 18 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M10.3 20a2 2 0 0 0 3.4 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
history:'<path d="M3.5 12a8.5 8.5 0 1 1 2.5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M3.5 12H6M3.5 12V9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 8v4l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
gear:'<circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M19.4 13.5a7.5 7.5 0 0 0 0-3l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.5 2.6a7.6 7.6 0 0 0-2.6 1.5l-2.3-1-2 3.4 2 1.5a7.5 7.5 0 0 0 0 3l-2 1.5 2 3.4 2.3-1a7.6 7.6 0 0 0 2.6 1.5l.5 2.6h4l.5-2.6a7.6 7.6 0 0 0 2.6-1.5l2.3 1 2-3.4-2-1.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
play:'<path d="M8 5.5v13l11-6.5z"/>',
pause:'<rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/>',
prev:'<rect x="5" y="5" width="2.6" height="14" rx="1"/><path d="M20 5.5v13L9.5 12z"/>',
next:'<rect x="16.4" y="5" width="2.6" height="14" rx="1"/><path d="M4 5.5v13l10.5-6.5z"/>',
shuffle:'<path d="M16 3.5h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
repeat:'<path d="M17 2.5 21 6.5l-4 4M3 11V9.5a3.5 3.5 0 0 1 3.5-3.5H21M7 21.5 3 17.5l4-4M21 13v1.5a3.5 3.5 0 0 1-3.5 3.5H3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
repeat1:'<path d="M17 2.5 21 6.5l-4 4M3 11V9.5a3.5 3.5 0 0 1 3.5-3.5H21M7 21.5 3 17.5l4-4M21 13v1.5a3.5 3.5 0 0 1-3.5 3.5H3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><text x="12" y="16.5" font-size="8" font-weight="700" text-anchor="middle" fill="currentColor" font-family="Montserrat,sans-serif">1</text>',
heart:'<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21.2l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
heartF:'<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21.2l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8z"/>',
check:'<path d="M20 6.5 9.5 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
chevD:'<path d="m6 9.5 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
chevR:'<path d="m9.5 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
devices:'<rect x="2.5" y="5" width="13" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="18" y="8.5" width="4" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="20" cy="12" r="1" fill="currentColor"/><path d="M6 18.5h7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
queue:'<path d="M4 6.5h11M4 11h11M4 15.5h7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M17 9.5v9l7-4.5z"/>',
plus:'<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
x:'<path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
dots:'<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>',
note:'<path d="M9 18.5V6l11-2.5V16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="6.5" cy="18.5" r="2.8" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.5" cy="16" r="2.8" fill="none" stroke="currentColor" stroke-width="2"/>',
disc:'<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2" fill="none" stroke="currentColor" stroke-width="2"/>',
person:'<circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
sun:'<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5 5l1.8 1.8M17.2 17.2 19 19M19 5l-1.8 1.8M6.8 17.2 5 19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
radio:'<circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.8 5.8a9 9 0 0 0 0 12.4M18.2 5.8a9 9 0 0 1 0 12.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
playRect:'<rect x="3" y="6" width="18" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10.5 9.8v4.4L14.5 12z"/>',
trash:'<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l1 13a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
pencil:'<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
eq:'<rect x="4" y="10" width="3" height="10" rx="1"/><rect x="10.5" y="4" width="3" height="16" rx="1"/><rect x="17" y="13" width="3" height="7" rx="1"/>',
info:'<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.4" fill="currentColor"/>',
tag:'<path d="M3.5 3.5h7l10 10a1.4 1.4 0 0 1 0 2l-5 5a1.4 1.4 0 0 1-2 0l-10-10v-7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="8.6" cy="8.6" r="1.6" fill="currentColor"/>',
download:'<path d="M12 4v10.5M7.5 11 12 15.5 16.5 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 19.5h15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
};
function icon(name, style){
  const filled = ['home','play','pause','prev','next','heartF','dots','eq'].includes(name);
  const inner = ICONS[name] || '';
  return `<svg viewBox="0 0 24 24" ${filled?'fill="currentColor"':'fill="none"'} ${style?`style="${style}"`:''} aria-hidden="true">${inner}</svg>`;
}

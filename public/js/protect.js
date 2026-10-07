// Content protection: makes it hard to save or capture members' pictures.
//
// A web page can't truly stop screenshots (OS tools, phone screenshot buttons
// and cameras work outside the browser), so this is a deterrent layer:
//   - no right-click / long-press "Save image", no dragging images out;
//   - Save As (Ctrl/Cmd+S), Print (Ctrl/Cmd+P), View Source (Ctrl/Cmd+U) and
//     the developer tools shortcuts are blocked, and printing renders blank;
//   - Print Screen wipes the clipboard, and the page is blurred while it's in
//     the background or a screenshot shortcut is being pressed (Snipping Tool,
//     Win+Shift+S, Cmd+Shift+3/4/5 take focus or start with these keys);
//   - videos get no download / picture-in-picture controls.
// Chat files someone sends you keep their explicit Download link.
(function () {
  'use strict';

  const css = `
    img, video { -webkit-user-drag: none; user-drag: none; -webkit-touch-callout: none; user-select: none; -webkit-user-select: none; }
    html.gx-shield body { filter: blur(22px) !important; }
    html.gx-shield body * { pointer-events: none !important; }
    @media print {
      html, body { background: #fff !important; }
      body * { display: none !important; }
      body::after { content: 'Printing is disabled on getxmatch.'; display: block; padding: 40px; font: 18px sans-serif; color: #000; }
    }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  const root = document.documentElement;
  const isEditable = (el) => !!el && el.closest &&
    !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');

  // Right-click / long-press menu: off everywhere except text fields (so
  // members can still paste and spell-check while typing).
  document.addEventListener('contextmenu', (e) => {
    if (!isEditable(e.target)) e.preventDefault();
  }, true);

  // No dragging pictures or videos out of the page.
  document.addEventListener('dragstart', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'IMG' || t.tagName === 'VIDEO' || (t.querySelector && t.querySelector('img, video')))) e.preventDefault();
  }, true);

  // Blur the page for a moment (or until focus comes back).
  let shieldTimer = null;
  function shield(ms) {
    root.classList.add('gx-shield');
    clearTimeout(shieldTimer);
    if (ms) shieldTimer = setTimeout(() => { if (document.hasFocus()) root.classList.remove('gx-shield'); }, ms);
  }
  function unshield() {
    clearTimeout(shieldTimer);
    root.classList.remove('gx-shield');
  }

  function wipeClipboard() {
    try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(' ').catch(() => {}); } catch (_e) { /* ignore */ }
  }

  const isWindows = /Win/i.test(navigator.platform || navigator.userAgent || '');

  document.addEventListener('keydown', (e) => {
    const k = (e.key || '').toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    // Save As, Print, View Source.
    if (mod && !e.shiftKey && (k === 's' || k === 'p' || k === 'u')) { e.preventDefault(); return; }
    // Developer tools.
    if (k === 'f12' || (mod && e.shiftKey && (k === 'i' || k === 'j' || k === 'c'))) { e.preventDefault(); return; }
    // Screenshot shortcuts: Win+Shift+S / Win key (Snipping), Cmd+Shift+3/4/5.
    if (k === 'printscreen') { e.preventDefault(); wipeClipboard(); shield(1500); return; }
    if ((e.metaKey && e.shiftKey) || (isWindows && k === 'meta')) shield(2500);
  }, true);

  // Print Screen on Windows usually only fires keyup.
  document.addEventListener('keyup', (e) => {
    if ((e.key || '').toLowerCase() === 'printscreen') { wipeClipboard(); shield(1500); }
  }, true);

  // Hide content while the page is in the background (a capture tool or another
  // app has focus) and show it again on return.
  // (Focus moving into an embedded player, e.g. a YouTube link in chat, also
  // blurs the window; that's not leaving the page.)
  window.addEventListener('blur', () => setTimeout(() => {
    const a = document.activeElement;
    if (!(a && a.tagName === 'IFRAME')) shield(0);
  }, 0));
  window.addEventListener('focus', unshield);
  document.addEventListener('visibilitychange', () => { if (document.hidden) shield(0); else if (document.hasFocus()) unshield(); });
  window.addEventListener('beforeprint', () => shield(0));
  window.addEventListener('afterprint', unshield);

  // Videos: no download button or picture-in-picture.
  function lockVideo(v) {
    v.setAttribute('controlsList', 'nodownload noplaybackrate noremoteplayback');
    v.setAttribute('disablePictureInPicture', '');
    v.setAttribute('disableRemotePlayback', '');
  }
  function scan(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.tagName === 'VIDEO') lockVideo(node);
    if (node.querySelectorAll) node.querySelectorAll('video').forEach(lockVideo);
  }
  const start = () => {
    scan(document.body);
    new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach(scan)))
      .observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();

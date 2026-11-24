// 聊天页侧栏：桌面参与布局，窄屏作为覆盖面板。
const narrow = window.matchMedia('(max-width: 1100px)');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const panels = new Map();
let backdrop;

export const isNarrowLayout = () => narrow.matches;

export function isPanelOpen(id) {
  return panels.get(id)?.open || false;
}

export function setPanelOpen(id, open, { animate = true } = {}) {
  const item = panels.get(id);
  if (!item || (item.open === open && animate)) return;
  const { el, side, button } = item;
  const wasHidden = el.hidden;
  const computed = getComputedStyle(el);
  const margin = side === 'right' ? 'marginRight' : 'marginLeft';
  const current = narrow.matches
    ? { transform: computed.transform }
    : { [margin]: computed[margin], opacity: computed.opacity };
  item.animation?.cancel();
  item.animation = null;
  item.open = open;
  el.inert = !open;
  button?.setAttribute('aria-expanded', String(open));

  if (open && narrow.matches) {
    for (const [otherId, other] of panels) {
      if (otherId !== id && other.open) setPanelOpen(otherId, false, { animate });
    }
  }
  syncBackdrop();

  if (!animate || reducedMotion.matches || typeof el.animate !== 'function' || (wasHidden && !open)) {
    el.hidden = !open;
  } else {
    el.hidden = false;
    const width = el.getBoundingClientRect().width;
    const closed = narrow.matches
      ? { transform: `translateX(${side === 'right' ? '' : '-'}100%)` }
      : { [margin]: `${-width}px`, opacity: 0 };
    const opened = narrow.matches
      ? { transform: 'translateX(0)' }
      : { [margin]: '0px', opacity: 1 };
    const animation = el.animate([wasHidden ? closed : current, open ? opened : closed], {
      duration: 220,
      easing: 'cubic-bezier(.2,.8,.2,1)',
      fill: 'forwards',
    });
    item.animation = animation;
    animation.finished.then(() => {
      if (item.animation !== animation) return;
      el.hidden = !item.open;
      item.animation = null;
      animation.cancel();
    }).catch(() => {}); // 快速反向切换会取消上一段动画。
  }
  if (open) el.dispatchEvent(new Event('panel-open'));
}

export function closeChatPanels(options) {
  for (const id of panels.keys()) setPanelOpen(id, false, options);
}

function syncBackdrop() {
  const visible = narrow.matches && [...panels.values()].some(item => item.open);
  backdrop.hidden = !visible;
  backdrop.classList.toggle('ov-show', visible);
}

export function initPanels() {
  backdrop = document.createElement('button');
  backdrop.type = 'button';
  backdrop.id = 'ovBackdrop';
  backdrop.className = 'ov-backdrop';
  backdrop.setAttribute('aria-label', '关闭侧栏');
  backdrop.hidden = true;
  backdrop.onclick = () => closeChatPanels();
  document.body.appendChild(backdrop);

  for (const [id, side, buttonId, closeId] of [
    ['ovPanel', 'right', 'ovToggleBtn', 'ovClose'],
    ['sessionPanel', 'left', 'sessBtn', 'sessClose'],
  ]) {
    const el = document.getElementById(id);
    const button = document.getElementById(buttonId);
    const open = !narrow.matches && !el.hidden;
    el.hidden = !open;
    el.inert = !open;
    panels.set(id, { el, side, button, open, animation: null });
    button.setAttribute('aria-controls', id);
    button.setAttribute('aria-expanded', String(open));
    button.addEventListener('click', () => setPanelOpen(id, !isPanelOpen(id)));
    document.getElementById(closeId)?.addEventListener('click', () => setPanelOpen(id, false));
  }
  narrow.addEventListener('change', () => {
    closeChatPanels({ animate: false });
    if (!narrow.matches) setPanelOpen('ovPanel', true, { animate: false });
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || document.querySelector('.ov-modal-overlay:not([hidden]), .settings-panel.open')) return;
    const item = [...panels.values()].find(panel => panel.open && panel.el.contains(document.activeElement));
    if (narrow.matches) closeChatPanels();
    else if (item) setPanelOpen(item.el.id, false);
    if (item && document.activeElement !== document.getElementById('q')) item.button.focus();
  });
}

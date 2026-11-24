// 应用入口：路由、导航、初始化
import { state, navigate } from './store.js';
import { initChat, loadSession } from './chat.js';
import { initJobs, bindJobsEvents } from './jobs.js';
import { initTasks, stopTasks, bindTasksEvents } from './tasks.js';
import { initTickets, bindTicketsEvents } from './tickets.js';
import { initData } from './data.js';
import { initEvidence } from './evidence.js';
import { initOverview, bindOverviewEvents } from './overview.js';
import { initPanels, closeChatPanels, isNarrowLayout } from './panels.js';

const PAGES = {
  chat: { el: 'page-chat', init: () => { initChat(); initOverview(); } },
  jobs: { el: 'page-jobs', init: initJobs },
  tasks: { el: 'page-tasks', init: initTasks },
  tickets: { el: 'page-tickets', init: initTickets },
  data: { el: 'page-data', init: initData },
};
const inited = new Set();

function closeNav() {
  document.getElementById('nav').classList.remove('open');
  document.getElementById('navToggle').setAttribute('aria-expanded', 'false');
  document.getElementById('navBackdrop').hidden = true;
}

function route() {
  const hash = window.location.hash.replace('#/', '') || 'chat';
  const page = PAGES[hash] ? hash : 'chat';
  for (const [key, p] of Object.entries(PAGES)) {
    document.getElementById(p.el).hidden = key !== page;
  }
  document.querySelectorAll('#nav nav a').forEach(a => {
    const active = a.dataset.page === page;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  state.page = page;
  closeNav();
  document.querySelectorAll('.sp-menu:not([hidden])').forEach(menu => { menu.hidden = true; });
  if (page !== 'tasks') stopTasks();
  if (page !== 'chat' && isNarrowLayout()) closeChatPanels({ animate: false });
  // 聊天保留当前流和草稿；数据页面再次进入时刷新。
  if (!inited.has(page) || page !== 'chat') {
    PAGES[page].init();
    inited.add(page);
  }
}

export function initApp() {
  initPanels();
  window.__loadSession = id => {
    navigate('chat');
    route();
    return loadSession(id);
  };
  window.addEventListener('hashchange', route);
  route();
  document.querySelectorAll('#nav nav a').forEach(a => {
    a.onclick = e => { e.preventDefault(); navigate(a.dataset.page); };
  });

  const navToggle = document.getElementById('navToggle');
  navToggle.setAttribute('aria-expanded', 'false');
  navToggle.onclick = () => {
    const open = document.getElementById('nav').classList.toggle('open');
    navToggle.setAttribute('aria-expanded', String(open));
    document.getElementById('navBackdrop').hidden = !open;
  };
  document.getElementById('navBackdrop').onclick = closeNav;
  window.matchMedia('(max-width: 768px)').addEventListener('change', closeNav);

  const settingsBtn = document.getElementById('settingsBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const settingsBackdrop = document.getElementById('settingsBackdrop');
  const themeBtn = document.getElementById('themeBtn');
  let settingsTimer;
  const applyThemeLabel = () => {
    themeBtn.textContent = document.documentElement.dataset.theme === 'dark' ? '切换到浅色' : '切换到深色';
  };
  applyThemeLabel();
  themeBtn.onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch {}
    applyThemeLabel();
  };
  const closeSettings = () => {
    settingsPanel.classList.remove('open');
    settingsBackdrop.classList.remove('open');
    settingsBtn.setAttribute('aria-expanded', 'false');
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => {
      settingsPanel.hidden = true;
      settingsBackdrop.hidden = true;
    }, 200);
    settingsBtn.focus();
  };
  settingsBtn.onclick = () => {
    closeNav();
    clearTimeout(settingsTimer);
    settingsPanel.hidden = false;
    settingsBackdrop.hidden = false;
    settingsPanel.offsetHeight;
    settingsPanel.classList.add('open');
    settingsBackdrop.classList.add('open');
    settingsBtn.setAttribute('aria-expanded', 'true');
    document.getElementById('settingsClose').focus();
  };
  document.getElementById('settingsClose').onclick = closeSettings;
  settingsBackdrop.onclick = closeSettings;
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (settingsPanel.classList.contains('open')) closeSettings();
    else closeNav();
  });

  bindJobsEvents();
  bindTasksEvents();
  bindTicketsEvents();
  bindOverviewEvents();
  initEvidence();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initApp);
else initApp();

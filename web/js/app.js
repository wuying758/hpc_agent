// 应用入口：路由、导航、初始化
import { state, navigate } from './store.js';
import { initChat, loadSession } from './chat.js';
import { initJobs, bindJobsEvents } from './jobs.js';
import { initTasks, stopTasks, bindTasksEvents } from './tasks.js';
import { initTickets, bindTicketsEvents } from './tickets.js';
import { refreshDataGroup } from './data.js';
import * as auth from './auth.js';
import { esc } from './utils.js';
import { initEvidence } from './evidence.js';
import { initOverview, bindOverviewEvents } from './overview.js';
import { initPanels, closeChatPanels, isNarrowLayout } from './panels.js';

const PAGES = {
  chat: { el: 'page-chat', init: () => { initChat(); initOverview(); } },
  jobs: { el: 'page-jobs', init: initJobs },
  tasks: { el: 'page-tasks', init: initTasks },
  tickets: { el: 'page-tickets', init: initTickets },
};
const inited = new Set();

function closeNav() {
  document.getElementById('nav').classList.remove('open');
  document.getElementById('navToggle').setAttribute('aria-expanded', 'false');
  document.getElementById('navBackdrop').hidden = true;
}

function route() {
  const hash = window.location.hash.replace('#/', '') || 'chat';
  // 旧链接 #/data → 打开设置的「数据与连接」分组
  if (hash === 'data') { openSettings('data'); return; }
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
  let settingsTimer;

  // ---- 主题切换 ----
  const applyTheme = (t) => {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('theme', t); } catch {}
    document.querySelectorAll('.theme-option').forEach(b => {
      b.classList.toggle('active', b.dataset.theme === t);
    });
  };
  applyTheme(document.documentElement.dataset.theme || 'light');
  document.querySelectorAll('.theme-option').forEach(b => {
    b.onclick = () => applyTheme(b.dataset.theme);
  });

  // ---- 设置分组切换 ----
  const navItems = document.querySelectorAll('#settingsNav .settings-nav-item');
  const groups = document.querySelectorAll('.settings-group');
  function showGroup(group) {
    navItems.forEach(n => {
      const on = n.dataset.group === group;
      n.classList.toggle('active', on);
      n.setAttribute('aria-selected', String(on));
    });
    groups.forEach(g => { g.hidden = g.dataset.group !== group; });
    if (group === 'data') refreshDataGroup();
  }
  navItems.forEach(n => { n.onclick = () => showGroup(n.dataset.group); });

  window.__showSettingsGroup = showGroup;

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
  window.openSettings = (group = 'appearance') => {
    closeNav();
    clearTimeout(settingsTimer);
    settingsPanel.hidden = false;
    settingsBackdrop.hidden = false;
    settingsPanel.offsetHeight; // 强制 reflow
    showGroup(group);
    settingsPanel.classList.add('open');
    settingsBackdrop.classList.add('open');
    settingsBtn.setAttribute('aria-expanded', 'true');
    document.getElementById('settingsClose').focus();
  };
  settingsBtn.onclick = () => window.openSettings('appearance');
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

  // 登录逻辑
  initAuth();
}

function initAuth() {
  const loginBtn = document.getElementById('loginBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const loginModal = document.getElementById('loginModal');
  const loginForm = document.getElementById('loginForm');
  const loginUser = document.getElementById('loginUser');
  const loginPass = document.getElementById('loginPass');
  const loginError = document.getElementById('loginError');

  // 单一状态来源：auth 模块；登录入口 / 设置账号 / 聊天提示共用
  const updateAuthUI = (s) => {
    const on = s.logged_in;
    loginBtn.hidden = on;
    logoutBtn.hidden = !on;
    if (on) document.getElementById('logoutBtnText').textContent = s.username;
    const q = document.getElementById('q');
    const sendBtn = document.getElementById('sendBtn');
    if (on) { q.disabled = false; q.placeholder = '描述你想排查的问题，或输入作业 ID…'; }
    else { q.disabled = true; q.placeholder = '请先登录 JAccount 后开始对话'; }
    if (sendBtn) sendBtn.disabled = !on;
    // 设置页账号区（如果存在）
    const accBox = document.getElementById('accountInfo');
    if (accBox) {
      accBox.innerHTML = on
        ? `<div class="account-on"><span class="account-ava">${esc(s.username?.[0]?.toUpperCase() || '?')}</span><span>${esc(s.username || '')}</span></div>`
        : `<div class="account-off">未登录</div>`;
    }
  };
  auth.onAuthChange(updateAuthUI);

  loginBtn.onclick = () => {
    loginError.hidden = true;
    loginPass.value = '';
    loginModal.hidden = false;
    loginUser.focus();
  };
  logoutBtn.onclick = () => auth.logout();
  loginModal.onclick = (e) => { if (e.target === loginModal) loginModal.hidden = true; };
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !loginModal.hidden) loginModal.hidden = true;
  });

  loginForm.onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById('loginSubmit');
    btn.disabled = true; btn.textContent = '登录中…';
    loginError.hidden = true;
    try {
      await auth.login(loginUser.value.trim(), loginPass.value);
      loginPass.value = ''; // 提交后清空密码
      loginModal.hidden = true;
    } catch (err) {
      loginError.textContent = err.message || '登录失败';
      loginError.hidden = false;
    }
    btn.disabled = false; btn.textContent = '登 录';
  };

  // 启动时从服务端恢复登录状态
  updateAuthUI(auth.getAuth());
  auth.refreshAuth();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initApp);
else initApp();

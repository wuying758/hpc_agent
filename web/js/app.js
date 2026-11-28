// 应用入口：路由、导航、初始化
import { state, navigate } from './store.js';
import { initChat, loadSession } from './chat.js';
import { initJobs, bindJobsEvents, refreshJobs } from './jobs.js';
import { initTasks, stopTasks, bindTasksEvents, refreshTasks } from './tasks.js';
import { initTickets, bindTicketsEvents, refreshTickets } from './tickets.js';
import { initSettings, openSettings } from './settings.js';
import * as auth from './auth.js';
import { closeDrawer } from './utils.js';
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
  if (hash === 'data') { openSettings('data'); window.location.hash = '#/chat'; return; }
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
  initSettings();
  window.addEventListener('settings-opened', closeNav);
  window.addEventListener('cluster-data-updated', () => { if (state.page === 'jobs') initJobs(); });
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

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('settingsPanel').hidden) closeNav();
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
  };
  auth.onAuthChange(updateAuthUI);

  // 账号变更（登录/登出/切换）：统一清空/重新加载任务、工单、作业及已打开的详情抽屉
  // 聊天模块的清理由其自己的 onAccountChange 处理（chat.js）
  auth.onAccountChange(() => {
    closeDrawer();
    refreshTasks();
    refreshTickets();
    refreshJobs();
  });

  let loginReturnFocus;
  window.openLogin = () => {
    closeNav();
    loginReturnFocus = document.activeElement;
    loginError.hidden = true;
    loginPass.value = '';
    loginModal.hidden = false;
    document.getElementById('settingsPanel').inert = true;
    document.getElementById('main').inert = true;
    document.getElementById('nav').inert = true;
    loginUser.focus();
  };
  logoutBtn.title = '账号与集群设置';
  logoutBtn.onclick = () => openSettings('account');
  loginBtn.onclick = window.openLogin;
  const closeLogin = () => {
    loginModal.hidden = true;
    loginPass.value = '';
    document.getElementById('settingsPanel').inert = false;
    const settingsOpen = document.getElementById('settingsPanel').classList.contains('open');
    document.getElementById('main').inert = settingsOpen;
    document.getElementById('nav').inert = settingsOpen;
    if (loginReturnFocus?.isConnected && !loginReturnFocus.closest('[hidden]')) loginReturnFocus.focus();
    else (settingsOpen ? document.getElementById('settingsClose') : document.getElementById('settingsBtn')).focus();
  };
  document.getElementById('loginClose').onclick = closeLogin;
  loginModal.onclick = e => { if (e.target === loginModal) closeLogin(); };
  document.addEventListener('keydown', e => {
    if (loginModal.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeLogin(); }
    if (e.key === 'Tab') {
      const items = [...loginModal.querySelectorAll('input, button')].filter(el => !el.disabled);
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  loginForm.onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById('loginSubmit');
    btn.disabled = true; btn.textContent = '登录中…';
    loginError.hidden = true;
    try {
      await auth.login(loginUser.value.trim(), loginPass.value);
      loginPass.value = ''; // 提交后清空密码
      closeLogin();
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

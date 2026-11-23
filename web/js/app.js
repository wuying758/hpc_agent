// 应用入口：路由、导航、初始化
import { state, navigate } from './store.js';
import { initChat } from './chat.js';
import { initJobs, bindJobsEvents } from './jobs.js';
import { initTasks, stopTasks, bindTasksEvents } from './tasks.js';
import { initTickets, bindTicketsEvents } from './tickets.js';
import { initData } from './data.js';
import { initEvidence } from './evidence.js';
import { initOverview, bindOverviewEvents } from './overview.js';

const PAGES = {
  chat: { el: 'page-chat', init: () => { initChat(); initOverview(); } },
  jobs: { el: 'page-jobs', init: initJobs },
  tasks: { el: 'page-tasks', init: initTasks },
  tickets: { el: 'page-tickets', init: initTickets },
  data: { el: 'page-data', init: initData },
};
const inited = new Set();

function route() {
  const hash = window.location.hash.replace('#/', '') || 'chat';
  const page = PAGES[hash] ? hash : 'chat';
  // 隐藏所有页
  Object.values(PAGES).forEach(p => document.getElementById(p.el).hidden = true);
  // 显示当前页
  document.getElementById(PAGES[page].el).hidden = false;
  // 导航高亮
  document.querySelectorAll('#nav nav a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  state.page = page;
  // 首次进入时初始化
  if (!inited.has(page)) {
    PAGES[page].init();
    inited.add(page);
  }
  // 离开 tasks 时停止轮询
  if (page !== 'tasks') stopTasks();
}

export function initApp() {
  // 路由
  window.addEventListener('hashchange', route);
  route();

  // 导航
  document.querySelectorAll('#nav nav a').forEach(a => {
    a.onclick = e => { e.preventDefault(); navigate(a.dataset.page); };
  });

  // 手机导航开关
  const navToggle = document.getElementById('navToggle');
  if (navToggle) navToggle.onclick = () => document.getElementById('nav').classList.toggle('open');

  // 主题
  const themeBtn = document.getElementById('themeBtn');
  if (themeBtn) {
    const apply = () => {
      const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      themeBtn.textContent = t === 'dark' ? '浅色' : '深色';
    };
    apply();
    themeBtn.onclick = () => {
      const cur = document.documentElement.dataset.theme;
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch {}
      apply();
    };
  }

  // 事件绑定
  bindJobsEvents();
  bindTasksEvents();
  bindTicketsEvents();
  bindOverviewEvents();
  initEvidence();

  // 暴露给 chat.js 的会话加载
  window.__loadSession = (sid) => {
    const q = document.getElementById('q');
    if (q) q.value = '';
    // 触发 chat 加载
    const ev = new CustomEvent('load-session', { detail: { sid } });
    window.dispatchEvent(ev);
  };
}

// DOM ready
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initApp);
else initApp();

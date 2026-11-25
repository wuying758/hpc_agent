// 统一登录状态：服务端会话（HttpOnly Cookie）为唯一事实来源。
// 前端只缓存「已登录 + 用户名」用于立即渲染，真实状态以 /api/auth/status 为准。
let state = { logged_in: false, username: null };
const listeners = new Set();
const accountListeners = new Set(); // 账号变更（登录/登出/切换）时回调
let lastUser = null;

export function getAuth() { return state; }
export function onAuthChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function onAccountChange(fn) { accountListeners.add(fn); return () => accountListeners.delete(fn); }
export function isLogged() { return state.logged_in; }

function emit() {
  for (const fn of listeners) { try { fn(state); } catch {} }
  const u = state.logged_in ? state.username : null;
  if (u !== lastUser) {
    lastUser = u;
    for (const fn of accountListeners) { try { fn(u); } catch {} }
  }
}

// 从服务端拉取真实登录状态（带 Cookie，同源自动携带）
export async function refreshAuth() {
  try {
    const r = await fetch('/api/auth/status', { credentials: 'same-origin' });
    const d = await r.json();
    state = d.logged_in
      ? { logged_in: true, username: d.username, expires: d.expires }
      : { logged_in: false, username: null };
    emit();
  } catch {
    // 网络错误：保持原状态
  }
  return state;
}

// 登录：成功后服务端设置 Cookie
export async function login(operator, password) {
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operator, password }),
    credentials: 'same-origin',
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || '登录失败');
  state = { logged_in: true, username: d.username, expires: d.expires };
  emit();
  return d;
}

// 登出：撤销服务端会话 + 清 Cookie
export async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
  state = { logged_in: false, username: null };
  emit();
}

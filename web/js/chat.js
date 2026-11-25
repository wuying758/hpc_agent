// 智能分析（对话）
import { state } from './store.js';
import { esc, renderMarkdown, api } from './utils.js';
import { isNarrowLayout, setPanelOpen } from './panels.js';
import * as auth from './auth.js';

let sid = null, busy = false, pendingQueue = [];

// 保存的 sid 按账号区分（key: hpc_sid_<username>）
function sidKey(user) { return 'hpc_sid_' + (user || 'anon'); }
function saveSid(id, user) { try { if (id) localStorage.setItem(sidKey(user), id); else localStorage.removeItem(sidKey(user)); } catch {} }
function loadSavedSid(user) { try { return localStorage.getItem(sidKey(user)) || null; } catch { return null; } }
let activeRun = null, viewVersion = 0, sessionLoad = null, sessionLoading = false;
let sessionListVersion = 0;

const $msgs = () => document.getElementById('msgs');
const $q = () => document.getElementById('q');
const $send = () => document.getElementById('sendBtn');

export function initChat() {
  showWelcome();
  setStopUI(false);
  $send().onclick = () => {
    if (busy) {
      pendingQueue = [];
      renderQueue();
      activeRun?.controller.abort();
    } else send();
  };
  $q().addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      send();
    }
  });
  $q().addEventListener('input', autoGrow);
  document.getElementById('sessNew').onclick = startNewSession;
  document.getElementById('newChatBtn').onclick = startNewSession;
  document.getElementById('sessionPanel').addEventListener('panel-open', loadSessionList);
  document.getElementById('noticeDismiss').onclick = () => showChatNotice('');
  document.addEventListener('mousedown', e => {
    if (!e.target.closest('.sp-menu, [data-act="more"]')) closeSessionMenus();
  });
  document.addEventListener('scroll', () => closeSessionMenus(), true);
  loadSessionList();

  const sel = document.getElementById('modelSel');
  api('/api/models').then(d => {
    sel.replaceChildren(...d.models.map(model => new Option(model, model, false, model === d.default)));
    try {
      const saved = localStorage.getItem('model');
      if (saved && d.models.includes(saved)) sel.value = saved;
    } catch {}
  }).catch(() => {});
  sel.onchange = () => { try { localStorage.setItem('model', sel.value); } catch {} };
  updateCtx(null);
  // 当前账号的会话由 auth.onAccountChange 在 refreshAuth 解析后统一恢复

  // 退出/切换账号：停止当前回复、清空待发送队列；登录/刷新后恢复该账号会话
  auth.onAccountChange((u) => {
    resetChatForAccount();
    if (u) restoreSessionForAccount();
  });
}

function resetChatForAccount() {
  changeConversation(); // 停流 + 清空 pendingQueue
  sid = null;          // 只清内存态，不动 localStorage 里保存的 sid（否则刷新后无法恢复）
  state.sessionId = null;
  $msgs().innerHTML = '<div class="chat-content"></div>';
  $q().value = '';
  autoGrow();
  updateCtx(null);
  showChatNotice('');
  showWelcome();
  document.getElementById('chatSessionTitle').textContent = '基于集群数据的自然语言问答与诊断';
  if (isNarrowLayout()) setPanelOpen('sessionPanel', false);
  loadSessionList();
}

// 恢复当前账号上次打开的会话（登录/刷新后调用）
export function restoreSessionForAccount() {
  const user = auth.getAuth().username;
  if (!user) return;
  const saved = loadSavedSid(user);
  if (saved) loadSession(saved, { initial: true });
}

function selectSession(id, title = '基于集群数据的自然语言问答与诊断') {
  sid = id;
  state.sessionId = id;
  saveSid(id, auth.getAuth().username);
  document.getElementById('chatSessionTitle').textContent = title;
}

function changeConversation() {
  viewVersion++;
  sessionLoad?.abort();
  sessionLoad = null;
  sessionLoading = false;
  if (activeRun) {
    activeRun.controller.abort();
    activeRun.finish('已停止');
    activeRun = null;
  }
  busy = false;
  pendingQueue = [];
  renderQueue();
  setStopUI(false);
  closeSessionMenus();
  return viewVersion;
}

function startNewSession() {
  changeConversation();
  selectSession(null);
  $q().value = '';
  autoGrow();
  updateCtx(null);
  showChatNotice('');
  showWelcome();
  if (isNarrowLayout()) setPanelOpen('sessionPanel', false);
  loadSessionList();
  $q().focus();
}

function showChatNotice(message, { error = false, retry = null } = {}) {
  const notice = document.getElementById('chatNotice');
  notice.hidden = !message;
  notice.classList.toggle('is-error', error);
  notice.setAttribute('role', error ? 'alert' : 'status');
  document.getElementById('chatNoticeText').textContent = message;
  const button = document.getElementById('noticeRetry');
  button.hidden = !retry;
  button.onclick = retry;
}

function showWelcome() {
  const cards = [
    ['集群概况', '了解作业规模与资源分布', '最近7天集群整体情况如何？', '<path d="M3 3v18h18M7 16l4-8 4 4 5-9"/>'],
    ['超时排查', '定位达到运行时限的作业', '最近7天运行最久的超时作业有哪些？', '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'],
    ['反复失败', '追踪重复失败与共同原因', '最近7天哪些用户反复失败？', '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 8a7 7 0 0 1 12-2l2 3M4 15l2 3a7 7 0 0 0 12-2"/>'],
    ['单作业诊断', '从作业 ID 开始深入分析', '', '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>'],
  ];
  $msgs().innerHTML = `<div class="chat-content"><section class="welcome">
    <span class="welcome-eyebrow">HPC · 作业分析助手</span>
    <h2>从作业数据中找到线索</h2>
    <p>了解集群运行情况，定位低效作业。<br>选择一个问题开始，或在下方描述你想排查的内容。</p>
    <div class="welcome-grid">${cards.map(([title, desc, question, icon], i) => `
      <button type="button" class="welcome-card" data-card="${i}">
        <span class="wc-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></span>
        <span class="wc-title">${title}</span><span class="wc-desc">${desc}</span>
        <svg class="wc-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 12h14m-5-5 5 5-5 5"/></svg>
      </button>`).join('')}</div>
  </section></div>`;
  $msgs().querySelectorAll('[data-card]').forEach(button => {
    button.onclick = () => {
      const question = cards[+button.dataset.card][2];
      if (question) window.__chatSend(question);
      else {
        const id = prompt('输入作业 ID：')?.trim();
        if (id) window.__chatSend(`诊断作业 #${id}`);
      }
    };
  });
}

function autoGrow() {
  const q = $q();
  q.style.height = 'auto';
  q.style.height = Math.min(q.scrollHeight, 180) + 'px';
}

window.__chatSend = message => {
  if (!message || sessionLoading) return;
  $q().value = message;
  send();
};

function send() {
  const message = $q().value.trim();
  if (!message || sessionLoading) return;
  $q().value = '';
  autoGrow();
  if (busy) {
    pendingQueue.push(message);
    renderQueue();
  } else doSend(message);
}

async function doSend(message) {
  const version = viewVersion;
  const controller = new AbortController();
  const run = { controller, finish: null };
  activeRun = run;
  busy = true;
  setStopUI(true);
  showChatNotice('');
  addMsg('user', message);
  const { bubble } = addMsg('ai', '');
  const activity = document.createElement('div');
  activity.className = 'response-activity';
  activity.innerHTML = '<span></span>正在分析你的问题';
  bubble.appendChild(activity);
  let batch = null, text = null, reason = null, lastRender = 0, gotContent = false;
  const isCurrent = () => activeRun === run && version === viewVersion;
  const ensureText = () => text || (text = newTextSeg(bubble));
  const renderText = () => { if (text) text.body.innerHTML = renderMarkdown(text.text); };
  const closeReason = () => {
    if (!reason) return;
    reason.el.open = false;
    reason.el.querySelector('summary').textContent = '推理过程';
    reason = null;
  };
  const ensureReason = () => {
    if (reason) return reason;
    const el = document.createElement('details');
    el.className = 'reasoning';
    el.open = true;
    el.innerHTML = '<summary>正在分析…</summary><div class="reasoning-body"></div>';
    bubble.appendChild(el);
    return (reason = { el, body: el.querySelector('.reasoning-body') });
  };
  run.finish = label => {
    activity.remove();
    renderText();
    closeReason();
    if (batch) {
      batch.status.textContent = label;
      batch.status.className = 'tf-status interrupted';
      batch.seg.open = false;
    }
    const note = document.createElement('p');
    note.className = 'message-note';
    note.textContent = label;
    bubble.appendChild(note);
  };
  const handleEvent = ev => {
    if (['text', 'reasoning', 'batch_start', 'narrate', 'tool'].includes(ev.t)) {
      activity.remove();
      gotContent = true;
    }
    if (ev.t === 'reasoning') ensureReason().body.textContent += ev.d;
    if (ev.t === 'text') {
      closeReason();
      ensureText().text += ev.d;
      const now = Date.now();
      if (now - lastRender > 80) { lastRender = now; renderText(); }
    }
    if (ev.t === 'batch_start') {
      renderText();
      closeReason();
      text = null;
      batch = newBatchSeg(bubble, ev.count);
    }
    if (ev.t === 'narrate') {
      if (!batch) batch = newBatchSeg(bubble, 1);
      batchItemStart(batch, ev.d);
    }
    if (ev.t === 'tool' && batch) batchItemDone(batch, ev.result);
    if (ev.t === 'batch_end' && batch) {
      setBatchDone(batch);
      batch = null;
      text = null;
    }
    if (ev.t === 'suggest') setQuickItems(ev.items, bubble);
    if (ev.t === 'title') document.getElementById('chatSessionTitle').textContent = ev.title;
    if (ev.t === 'done') {
      if (ev.session_id) selectSession(ev.session_id, document.getElementById('chatSessionTitle').textContent);
      updateCtx(ev.context);
      loadSessionList();
    }
    if (ev.t === 'error') throw new Error(ev.d || ev.error || '回复生成失败');
    scrollBottom();
  };

  try {
    // 先取得会话 ID，首次回复被停止后仍可在同一会话继续。
    if (!sid) {
      const created = await api('/api/sessions', {
        method: 'POST', body: { title: message.slice(0, 30) }, signal: controller.signal,
      });
      if (!isCurrent()) return;
      selectSession(created.id, message.slice(0, 30));
      loadSessionList();
    }
    const requestSid = sid;
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ session_id: requestSid, message, model: document.getElementById('modelSel').value }),
      signal: controller.signal,
    });
    if (!isCurrent()) return;
    if (res.status === 401) { auth.refreshAuth(); throw new Error('登录已过期，请重新登录后再试。'); }
    if (!res.ok) throw new Error(`请求失败（${res.status}）：${await res.text()}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (!isCurrent()) return;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.trim()) handleEvent(JSON.parse(line));
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleEvent(JSON.parse(buffer));
    activity.remove();
    closeReason();
    if (batch) setBatchDone(batch);
    renderText();
    if (!gotContent) run.finish('未收到回复，请重新发送。');
  } catch (error) {
    if (!isCurrent()) return;
    if (error.name === 'AbortError') run.finish('已停止');
    else {
      run.finish('回复未完成');
      const note = document.createElement('p');
      note.className = 'message-note is-error';
      note.textContent = error.message;
      bubble.appendChild(note);
      pendingQueue = [];
      renderQueue();
    }
  } finally {
    if (activeRun === run) {
      activeRun = null;
      busy = false;
      setStopUI(false);
    }
  }
  if (version !== viewVersion) return;
  if (pendingQueue.length) {
    const next = pendingQueue.shift();
    renderQueue();
    doSend(next);
  } else if (state.page === 'chat') $q().focus();
}

function addMsg(role, text) {
  const msgs = $msgs();
  // 确保 .chat-content 容器存在
  let content = msgs.querySelector('.chat-content');
  if (!content) { content = document.createElement('div'); content.className = 'chat-content'; msgs.appendChild(content); }
  // 清除欢迎页
  const welcome = content.querySelector('.welcome');
  if (welcome) welcome.remove();
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  if (role === 'user') {
    div.innerHTML = `<div class="bubble">${esc(text)}</div>`;
  } else {
    div.innerHTML = `<div class="who">助手</div><div class="bubble"></div>`;
  }
  content.appendChild(div);
  return { bubble: div.querySelector('.bubble') };
}

function newTextSeg(bubble) {
  const seg = document.createElement('div');
  seg.className = 'text-seg';
  bubble.appendChild(seg);
  return { body: seg, text: '', hasContent: false };
}

function newBatchSeg(bubble, count) {
  const seg = document.createElement('details');
  seg.className = 'tool-fold';
  seg.open = true; // 运行中默认展开
  seg.innerHTML = `
    <summary><span class="tf-status">运行中</span><span class="tf-label">正在调用 ${count} 个工具…</span></summary>
    <div class="tf-body"></div>`;
  bubble.appendChild(seg);
  return { seg, items: seg.querySelector('.tf-body'), label: seg.querySelector('.tf-label'), status: seg.querySelector('.tf-status'), total: count, finished: 0, _lastItem: null, _names: [] };
}

function batchItemStart(b, narrate) {
  const it = document.createElement('div');
  it.className = 'tf-item';
  it.innerHTML = `<span class="tf-st">运行中</span> ${esc(narrate)}`;
  b.items.appendChild(it);
  b._lastItem = it;
  b._names.push(narrate);
  // 更新折叠标题
  b.label.textContent = `调用 ${b._names.length} 个工具 · ${narrate}`;
}

function batchItemDone(b, result) {
  if (b._lastItem) {
    const st = b._lastItem.querySelector('.tf-st');
    if (st) { st.textContent = '✓'; st.className = 'tf-st ok'; }
    if (result) {
      const ref = document.createElement('div');
      ref.className = 'tf-result';
      ref.textContent = result.slice(0, 120);
      b._lastItem.appendChild(ref);
    }
  }
  b.finished++;
  b._lastItem = null;
}

function setBatchDone(b) {
  b.status.textContent = '完成';
  b.status.className = 'tf-status done';
  b.label.textContent = `调用了 ${b.finished || b.total} 个工具 · ${b._names[0] || ''}`;
  b.seg.open = false; // 完成后折叠
}

function setQuickItems(items, bubble) {
  if (!Array.isArray(items) || !items.length) return;
  const div = document.createElement('div');
  div.className = 'quick-items';
  items.forEach(it => {
    const b = document.createElement('button');
    b.textContent = it;
    b.onclick = () => { $q().value = it; send(); };
    div.appendChild(b);
  });
  bubble.appendChild(div);
  scrollBottom();
}

function renderQueue() {
  let el = document.getElementById('queueWrap');
  if (!el && !pendingQueue.length) return;
  if (!el) {
    el = document.createElement('div');
    el.id = 'queueWrap';
    el.className = 'composer-inner queue-wrap';
    document.getElementById('composer').prepend(el);
  }
  el.hidden = !pendingQueue.length;
  el.innerHTML = pendingQueue.map((text, i) => `
    <div class="queue-item"><span>待发送 · ${esc(text)}</span>
      <button type="button" data-index="${i}">撤销</button></div>`).join('');
  el.querySelectorAll('button').forEach(button => {
    button.onclick = () => { pendingQueue.splice(+button.dataset.index, 1); renderQueue(); };
  });
}

function setStopUI(on) {
  const btn = $send();
  btn.innerHTML = on
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
  btn.classList.toggle('stop-mode', on);
  btn.title = on ? '停止回复' : '发送';
  btn.setAttribute('aria-label', btn.title);
  btn.disabled = sessionLoading;
  $q().disabled = sessionLoading;
  state.busy = on;
}

function updateCtx(pct) {
  const el = document.getElementById('ctxInfo');
  if (el) el.textContent = pct != null ? `上下文 ${pct}%` : '上下文 —';
}

function scrollBottom() {
  const m = $msgs();
  requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; });
}

function closeSessionMenus(except = null) {
  document.querySelectorAll('.sp-menu:not([hidden])').forEach(menu => {
    if (menu !== except) menu.hidden = true;
  });
}

async function loadSessionList() {
  const version = ++sessionListVersion;
  const list = document.getElementById('spList');
  const archivedList = document.getElementById('spArchivedList');
  try {
    const sessions = await api('/api/sessions');
    if (version !== sessionListVersion) return;
    const active = sessions.filter(s => !s.archived);
    const archived = sessions.filter(s => s.archived);
    list.innerHTML = active.length ? active.map(renderSpItem).join('') : '<div class="empty">暂无会话</div>';
    archivedList.innerHTML = archived.length ? archived.map(renderSpItem).join('') : '<div class="empty archive-empty">暂无归档会话</div>';
    bindSpItems(list, sessions);
    bindSpItems(archivedList, sessions);
    const toggle = document.getElementById('spArchivedToggle');
    toggle.onclick = () => {
      const open = archivedList.hidden;
      archivedList.hidden = !open;
      archivedList.classList.toggle('open', open);
      toggle.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
    };
  } catch (error) {
    if (version !== sessionListVersion) return;
    list.innerHTML = '<div class="empty">会话列表加载失败<br><button class="btn btn-sm">重试</button></div>';
    list.querySelector('button').onclick = loadSessionList;
  }
}

function renderSpItem(s) {
  const isArchived = !!s.archived;
  // 快捷按钮：归档的显示“取消归档”图标，未归档的显示“置顶”图标
  const quickBtn = isArchived
    ? `<button class="sp-quick" data-act="unarchive-quick" title="取消归档">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>
      </button>`
    : `<button class="sp-pin ${s.pinned ? 'pinned' : ''}" data-act="pin-quick" title="${s.pinned ? '取消置顶' : '置顶'}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${s.pinned ? 'style="transform:rotate(45deg);transform-origin:center"' : ''}><path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
      </button>`;

  // 菜单项：归档的没有置顶，有取消归档；未归档的有置顶和归档
  const menuItems = `
    ${!isArchived ? `<button data-act="pin">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${s.pinned ? 'style="transform:rotate(45deg);transform-origin:center"' : ''}><path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
      <span>${s.pinned ? '取消置顶' : '置顶'}</span>
    </button>` : ''}
    <button data-act="rename">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
      重命名
    </button>
    <button data-act="archive">
      ${isArchived
        ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg><span>取消归档</span>`
        : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg><span>归档</span>`}
    </button>
    <button data-act="del" class="danger">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      删除
    </button>`;

  return `
      <div class="sp-item ${s.id === sid ? 'active' : ''}" data-sid="${s.id}">
        <span class="sp-title" title="${esc(s.title || '新会话')}">${esc(s.title || '新会话')}</span>
        <span class="sp-actions">
          ${quickBtn}
          <button class="sp-more-btn" data-act="more" title="更多" aria-label="会话操作" aria-haspopup="menu">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
          </button>
          <div class="sp-menu" role="menu" hidden>${menuItems}</div>
        </span>
      </div>`;
}

function patchSession(id, fields) {
  return api('/api/sessions/' + encodeURIComponent(id), { method: 'PATCH', body: fields })
    .then(async () => { await loadSessionList(); return true; })
    .catch(error => {
      showChatNotice('会话操作失败：' + error.message, { error: true });
      return false;
    });
}

function bindSpItems(list, sessions) {
  list.querySelectorAll('.sp-item').forEach(item => {
    const id = item.dataset.sid;
    const session = sessions.find(s => s.id === id);
    const menu = item.querySelector('.sp-menu');
    const more = item.querySelector('[data-act="more"]');
    more.onclick = e => {
      e.stopPropagation();
      const open = menu.hidden;
      closeSessionMenus();
      if (!open) return;
      menu.hidden = false;
      const rect = more.getBoundingClientRect();
      const height = menu.offsetHeight;
      menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
      menu.style.top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8)) + 'px';
    };
    menu.querySelectorAll('button').forEach(button => {
      button.onclick = async e => {
        e.stopPropagation();
        menu.hidden = true;
        const action = button.dataset.act;
        if (action === 'pin') patchSession(id, { pinned: !session.pinned });
        if (action === 'archive') patchSession(id, { archived: !session.archived });
        if (action === 'rename') {
          const title = prompt('会话标题：', session.title || '')?.trim();
          if (title) {
            const updated = await patchSession(id, { title });
            if (updated && sid === id) document.getElementById('chatSessionTitle').textContent = title;
          }
        }
        if (action === 'del' && confirm('删除此会话？')) {
          if (sid === id) changeConversation();
          try {
            await api('/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' });
            if (sid === id) startNewSession();
            else loadSessionList();
          } catch (error) { showChatNotice('删除失败：' + error.message, { error: true }); }
        }
      };
    });
    item.querySelector('[data-act="pin-quick"]')?.addEventListener('click', e => {
      e.stopPropagation();
      patchSession(id, { pinned: !session.pinned });
    });
    item.querySelector('[data-act="unarchive-quick"]')?.addEventListener('click', e => {
      e.stopPropagation();
      patchSession(id, { archived: false });
    });
    item.onclick = e => {
      if (e.target.closest('.sp-actions')) return;
      closeSessionMenus();
      loadSession(id);
    };
  });
}

export async function loadSession(id, { initial = false } = {}) {
  const version = changeConversation();
  const controller = new AbortController();
  sessionLoad = controller;
  sessionLoading = true;
  setStopUI(false);
  showChatNotice('正在打开会话…');
  if (isNarrowLayout()) setPanelOpen('sessionPanel', false);
  try {
    const session = await api('/api/sessions/' + encodeURIComponent(id), { signal: controller.signal });
    if (version !== viewVersion) return;
    selectSession(id, session.title || '当前会话');
    $q().value = '';
    autoGrow();
    $msgs().innerHTML = '<div class="chat-content"></div>';
    if (!session.messages?.length) showWelcome();
    for (const message of session.messages || []) {
      if (message.role === 'user') addMsg('user', message.content);
      if (message.role === 'assistant') {
        const { bubble } = addMsg('ai', '');
        if (message.reasoning_content) {
          const reason = document.createElement('details');
          reason.className = 'reasoning';
          reason.innerHTML = `<summary>推理过程</summary><div class="reasoning-body">${esc(message.reasoning_content)}</div>`;
          bubble.appendChild(reason);
        }
        newTextSeg(bubble).body.innerHTML = renderMarkdown(message.content || '');
        if (message.suggest) setQuickItems(message.suggest, bubble);
      }
    }
    updateCtx(null);
    showChatNotice('');
    scrollBottom();
    loadSessionList();
  } catch (error) {
    if (version !== viewVersion || error.name === 'AbortError') return;
    if (initial && error.message.startsWith('404 ')) selectSession(null);
    showChatNotice('会话打开失败：' + error.message, {
      error: true, retry: () => loadSession(id, { initial }),
    });
  } finally {
    if (version === viewVersion) {
      sessionLoad = null;
      sessionLoading = false;
      setStopUI(busy);
    }
  }
}

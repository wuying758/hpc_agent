// 智能分析（对话）
import { state, navigate } from './store.js';
import { esc, fmt, renderMarkdown, statePill, openDrawer, closeDrawer, api, relTime } from './utils.js';

let sid = null, busy = false, curAbort = null, pendingQueue = [];
let curBatch = null, curText = null, curReason = null, lastRender = 0, taskSteps = [];

const $msgs = () => document.getElementById('msgs');
const $q = () => document.getElementById('q');
const $send = () => document.getElementById('sendBtn');

export function initChat() {
  // 恢复会话
  try { sid = localStorage.getItem('sid') || null; } catch {}
  if (sid) loadSession(sid);

  // 发送
  $send().onclick = () => { if (busy) curAbort?.abort(); else send(); };
  $q().addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $q().addEventListener('input', autoGrow);
  $send().innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';

  // 会话面板
  document.getElementById('sessBtn').onclick = toggleSessionPanel;
  document.getElementById('sessClose').onclick = toggleSessionPanel;
  document.getElementById('sessNew').onclick = () => { sid = null; try{localStorage.removeItem('sid')}catch{}; $msgs().innerHTML = '<div class="chat-content"></div>'; showWelcome(); loadSessionList(); };
  // 总览开关（带滑动动画）
  const ovBtn = document.getElementById('ovToggleBtn');
  if (ovBtn) ovBtn.addEventListener('click', () => {
    const p = document.getElementById('ovPanel');
    const isNarrow = window.innerWidth < 1100;
    if (p.hidden) {
      // 打开
      p.hidden = false;
      if (isNarrow) {
        showOvBackdrop(true);
        // 窄屏：从右侧滑入
        p.style.transition = 'none';
        p.style.transform = 'translateX(100%)';
        p.offsetHeight;
        p.style.transition = '';
        p.style.transform = '';
      } else {
        p.style.transition = 'none';
        p.style.marginRight = 'calc(-1 * var(--ov-w))';
        p.style.opacity = '0';
        p.offsetHeight;
        p.style.transition = '';
        p.style.marginRight = '';
        p.style.opacity = '';
      }
      ovBtn.setAttribute('aria-expanded', 'true');
      ovBtn.style.borderColor = 'var(--acc)';
      ovBtn.style.color = 'var(--acc)';
    } else {
      // 关闭
      if (isNarrow) {
        // 窄屏：向右滑出
        p.style.transition = 'none';
        p.offsetHeight;
        p.style.transition = '';
        p.style.transform = 'translateX(100%)';
        showOvBackdrop(false);
        p.addEventListener('transitionend', function handler() {
          p.removeEventListener('transitionend', handler);
          p.hidden = true;
          p.style.transform = '';
        });
      } else {
        p.style.transition = 'none';
        p.offsetHeight;
        p.style.transition = '';
        p.style.marginRight = 'calc(-1 * var(--ov-w))';
        p.style.opacity = '0';
        p.addEventListener('transitionend', function handler() {
          p.removeEventListener('transitionend', handler);
          p.hidden = true;
          p.style.marginRight = '';
          p.style.opacity = '';
        });
      }
      ovBtn.setAttribute('aria-expanded', 'false');
      ovBtn.style.borderColor = '';
      ovBtn.style.color = '';
    }
  });
  loadSessionList();

  // 模型选择
  const sel = document.getElementById('modelSel');
  api('/api/models').then(d => {
    sel.innerHTML = d.models.map(m => `<option value="${m}" ${m === d.default ? 'selected' : ''}>${m}</option>`).join('');
    try { const saved = localStorage.getItem('model'); if (saved) sel.value = saved; } catch {}
  }).catch(() => {});
  sel.onchange = () => { try { localStorage.setItem('model', sel.value); } catch {} };

  // 上下文
  updateCtx(null);
}

function showWelcome() {
  $msgs().innerHTML = `
    <div class="chat-content">
      <div class="welcome">
        <h2>从作业数据中找到线索</h2>
        <p>基于 SJTU HPC 集群的真实作业记录，定位超时、排队、反复失败等低效作业。</p>
        <div class="welcome-grid">
          <div class="welcome-card" onclick="window.__chatSend('最近7天集群整体情况如何？')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3v18h18"/><path d="M7 16l4-8 4 4 5-9"/></svg>
            <span class="wc-title">集群概况</span>
            <span class="wc-desc">总作业量、状态分布、资源浪费</span>
          </div>
          <div class="welcome-card" onclick="window.__chatSend('最近7天运行最久的超时作业有哪些？')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
            <span class="wc-title">超时排查</span>
            <span class="wc-desc">找出超过时限仍在运行的作业</span>
          </div>
          <div class="welcome-card" onclick="window.__chatSend('最近7天哪些用户反复失败？')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>
            <span class="wc-title">反复失败</span>
            <span class="wc-desc">同用户同作业多次失败的组</span>
          </div>
          <div class="welcome-card" onclick="const id=prompt('输入作业ID');if(id)window.__chatSend('诊断作业 #'+id)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
            <span class="wc-title">单作业诊断</span>
            <span class="wc-desc">输入作业 ID，分析低效原因</span>
          </div>
        </div>
      </div>
    </div>`;
}

function autoGrow() {
  const q = $q();
  q.style.height = 'auto';
  q.style.height = Math.min(q.scrollHeight, 160) + 'px';
}

window.__chatSend = (msg) => {
  if (msg) { $q().value = msg; send(); }
};

function send() {
  const msg = $q().value.trim();
  if (!msg) return;
  if (busy) { pendingQueue.push(msg); renderQueue(); return; }
  $q().value = ''; autoGrow();
  doSend(msg);
}

async function doSend(message) {
  busy = true; setStopUI(true);
  taskSteps = [];
  addMsg('user', message);
  const { bubble } = addMsg('ai', '');
  let curBatch2 = null, curText2 = null, curReason2 = null;

  const ensureText = () => { if (!curText2) curText2 = newTextSeg(bubble); return curText2; };
  const ensureReason = () => {
    if (curReason2) return curReason2;
    const box = document.createElement('details');
    box.className = 'reasoning'; box.open = true;
    const sum = document.createElement('summary');
    sum.textContent = '正在分析…';
    box.appendChild(sum);
    const body = document.createElement('div');
    body.className = 'reasoning-body';
    box.appendChild(body);
    bubble.appendChild(box);
    curReason2 = { el: box, body };
    return curReason2;
  };
  const closeReason = () => {
    if (!curReason2) return;
    curReason2.el.open = false;
    curReason2.el.querySelector('summary').textContent = '推理过程';
    curReason2 = null;
  };
  const renderText = () => { if (curText2) curText2.body.innerHTML = renderMarkdown(curText2.text); };
  const renderThrottled = () => { const now = Date.now(); if (now - lastRender > 80) { lastRender = now; renderText(); scrollBottom(); } };

  const ac = new AbortController();
  curAbort = ac;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sid, message, model: document.getElementById('modelSel').value }),
      signal: ac.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', gotAny = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        gotAny = true;
        if (ev.t === 'reasoning') { const r = ensureReason(); r.body.textContent += ev.d; }
        if (ev.t === 'text') { closeReason(); const ts = ensureText(); ts.text += ev.d; ts.hasContent = true; renderThrottled(); }
        if (ev.t === 'batch_start') { closeReason(); curText2 = null; curBatch2 = newBatchSeg(bubble, ev.count); scrollBottom(); }
        if (ev.t === 'narrate') { if (!curBatch2) curBatch2 = newBatchSeg(bubble, 1); batchItemStart(curBatch2, ev.d); taskSteps.push({ type: 'narrate', name: ev.d }); scrollBottom(); }
        if (ev.t === 'tool') { if (curBatch2) { batchItemDone(curBatch2, ev.result); taskSteps.push({ type: 'tool', name: ev.d, result: (ev.result||'').slice(0,500) }); } scrollBottom(); }
        if (ev.t === 'batch_end') { if (curBatch2) { setBatchDone(curBatch2); curBatch2 = null; curText2 = null; } scrollBottom(); }
        if (ev.t === 'suggest') { setQuickItems(ev.items); }
        if (ev.t === 'title') { /* 会话标题已更新，下次刷新列表时生效 */ }
        if (ev.t === 'done') {
          sid = ev.session_id;
          try { localStorage.setItem('sid', sid); } catch {}
          updateCtx(ev.context);
          loadSessionList();
        }
        scrollBottom();
      }
    }
    if (curBatch2) setBatchDone(curBatch2);
    renderText();
    if (!gotAny) ensureText().body.innerHTML = '<p style="color:var(--dimmer)">（无回复）</p>';
  } catch (e) {
    if (e.name === 'AbortError') {
      const ts = curText2 || ensureText();
      ts.body.innerHTML = (curText2?.text ? renderMarkdown(curText2.text) : '') + '<p style="color:var(--dimmer)">已停止</p>';
    } else {
      ensureText().body.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`;
    }
  } finally {
    busy = false; curAbort = null;
    setStopUI(false);
  }
  if (pendingQueue.length) { const next = pendingQueue.shift(); renderQueue(); setTimeout(() => doSend(next), 200); return; }
  $q().focus();
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

function setQuickItems(items) {
  if (!Array.isArray(items) || !items.length) return;
  const div = document.createElement('div');
  div.className = 'quick-items';
  items.forEach(it => {
    const b = document.createElement('button');
    b.textContent = it;
    b.onclick = () => { $q().value = it; send(); };
    div.appendChild(b);
  });
  const msgs = $msgs();
  const last = msgs.querySelector('.msg.ai:last-child .bubble');
  if (last) last.appendChild(div);
  scrollBottom();
}

function renderQueue() {
  let el = document.getElementById('queueWrap');
  if (!el) { el = document.createElement('div'); el.id = 'queueWrap'; el.className = 'composer-inner'; document.getElementById('composer').insertBefore(el, document.getElementById('composer').querySelector('.composer-inner')); }
  if (!pendingQueue.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div style="font-size:12px;color:var(--warn);margin-bottom:6px">排队中（${pendingQueue.length}）</div>` +
    pendingQueue.map((t, i) => `<div style="font-size:12px;padding:4px 8px;background:var(--surface-2);border-radius:4px;margin-bottom:4px;display:flex;justify-content:space-between"><span>${esc(t.slice(0,40))}</span><button style="border:none;background:none;color:var(--danger);font-size:11px;cursor:pointer" onclick="window.__cancelQ(${i})">撤销</button></div>`).join('');
}
window.__cancelQ = (i) => { pendingQueue.splice(i, 1); renderQueue(); };

function setStopUI(on) {
  const btn = $send();
  btn.innerHTML = on
    ? '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
  btn.title = on ? '停止' : '发送';
}

function updateCtx(pct) {
  const el = document.getElementById('ctxInfo');
  if (el) el.textContent = pct != null ? `上下文 ${pct}%` : '上下文 —';
}

function scrollBottom() {
  const m = $msgs();
  requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; });
}

// 会话面板
function toggleSessionPanel() {
  const p = document.getElementById('sessionPanel');
  const isNarrow = window.innerWidth < 1100;
  if (p.hidden) {
    p.hidden = false;
    if (isNarrow) {
      showOvBackdrop(true);
      p.style.transition = 'none';
      p.style.transform = 'translateX(-100%)';
      p.offsetHeight;
      p.style.transition = '';
      p.style.transform = '';
    } else {
      p.style.transition = 'none';
      p.style.marginLeft = 'calc(-1 * 260px)';
      p.style.opacity = '0';
      p.offsetHeight;
      p.style.transition = '';
      p.style.marginLeft = '';
      p.style.opacity = '';
    }
    loadSessionList();
  } else {
    if (isNarrow) {
      p.style.transition = 'none';
      p.offsetHeight;
      p.style.transition = '';
      p.style.transform = 'translateX(-100%)';
      showOvBackdrop(false);
      p.addEventListener('transitionend', function handler() {
        p.removeEventListener('transitionend', handler);
        p.hidden = true;
        p.style.transform = '';
      });
    } else {
      p.style.transition = 'none';
      p.offsetHeight;
      p.style.transition = '';
      p.style.marginLeft = 'calc(-1 * 260px)';
      p.style.opacity = '0';
      p.addEventListener('transitionend', function handler() {
        p.removeEventListener('transitionend', handler);
        p.hidden = true;
        p.style.marginLeft = '';
        p.style.opacity = '';
      });
    }
  }
}

async function loadSessionList() {
  const list = document.getElementById('spList');
  try {
    const sessions = await api('/api/sessions');
    if (!sessions.length) { list.innerHTML = '<div class="empty">暂无会话</div>'; return; }
    list.innerHTML = sessions.map(s => `
      <div class="sp-item ${s.id === sid ? 'active' : ''}" data-sid="${s.id}">
        <div class="t">${esc(s.title || '新会话')}</div>
        <div class="m">${s.preview ? esc(s.preview.slice(0, 30)) : ''} · ${relTimeStr(s.updated_at)}</div>
        <div class="ops">
          <button data-act="rename">重命名</button>
          <button data-act="del" style="color:var(--danger)">删除</button>
        </div>
      </div>`).join('');
    list.querySelectorAll('.sp-item').forEach(item => {
      item.onclick = e => {
        if (e.target.dataset.act === 'del') {
          if (!confirm('删除此会话？')) return;
          api('/api/sessions/' + item.dataset.sid, { method: 'DELETE' }).then(() => {
            if (sid === item.dataset.sid) { sid = null; localStorage.removeItem('sid'); $msgs().innerHTML = ''; showWelcome(); }
            loadSessionList();
          });
          return;
        }
        if (e.target.dataset.act === 'rename') {
          const t = prompt('新标题：');
          if (t) api('/api/sessions/' + item.dataset.sid, { method: 'PATCH', body: { title: t } }).then(loadSessionList);
          return;
        }
        loadSession(item.dataset.sid);
      };
    });
  } catch { list.innerHTML = '<div class="empty">加载失败</div>'; }
}

function relTimeStr(s) {
  if (!s) return '';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return relTime(d.getTime());
}

async function loadSession(id) {
  try {
    const s = await api('/api/sessions/' + id);
    // 读取成功后再更新 sid
    sid = id;
    try { localStorage.setItem('sid', id); } catch {}
    const msgs = $msgs();
    msgs.innerHTML = '';
    if (s.messages) {
      for (const m of s.messages) {
        if (m.role === 'user') addMsg('user', m.content);
        else if (m.role === 'assistant') {
          const { bubble } = addMsg('ai', '');
          newTextSeg(bubble).body.innerHTML = renderMarkdown(m.content || '');
        }
      }
    }
    scrollBottom();
    const sp = document.getElementById('sessionPanel');
    if (!sp.hidden) {
      sp.style.transition = 'none';
      sp.offsetHeight;
      sp.style.transition = '';
      sp.style.marginLeft = 'calc(-1 * 260px)';
      sp.style.opacity = '0';
      sp.addEventListener('transitionend', function h() {
        sp.removeEventListener('transitionend', h);
        sp.hidden = true;
        sp.style.marginLeft = '';
        sp.style.opacity = '';
      });
    }
  } catch (e) {
    console.error('loadSession failed:', e);
    // 失败时保留当前会话，显示提示
    const msgs = $msgs();
    if (msgs.children.length === 0) {
      msgs.innerHTML = `<div style="text-align:center;padding:20px;color:var(--danger)">会话加载失败：${esc(e.message)}</div>`;
    }
  }
}

// 窄屏面板遮罩
function showOvBackdrop(show) {
  let bd = document.getElementById('ovBackdrop');
  if (show) {
    if (!bd) {
      bd = document.createElement('div');
      bd.id = 'ovBackdrop';
      bd.className = 'ov-backdrop';
      bd.onclick = () => {
        showOvBackdrop(false);
        // 关闭所有窄屏面板
        closeNarrowPanel('ovPanel', 'translateX(100%)', 'ovToggleBtn');
        closeNarrowPanel('sessionPanel', 'translateX(-100%)', null);
      };
      document.body.appendChild(bd);
    }
    bd.hidden = false;
    bd.offsetHeight;
    bd.classList.add('ov-show');
  } else {
    if (bd) {
      bd.classList.remove('ov-show');
      bd.addEventListener('transitionend', function h() {
        bd.removeEventListener('transitionend', h);
        bd.hidden = true;
      });
    }
  }
}

function closeNarrowPanel(id, transform, btnId) {
  const p = document.getElementById(id);
  if (p && !p.hidden) {
    p.style.transition = 'none';
    p.offsetHeight;
    p.style.transition = '';
    p.style.transform = transform;
    p.addEventListener('transitionend', function h() {
      p.removeEventListener('transitionend', h);
      p.hidden = true;
      p.style.transform = '';
    });
  }
  if (btnId) {
    const btn = document.getElementById(btnId);
    if (btn) { btn.setAttribute('aria-expanded','false'); btn.style.cssText = ''; }
  }
}

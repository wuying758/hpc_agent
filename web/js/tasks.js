// 分析任务中心
import { state } from './store.js';
import { esc, fmt, statePill, openDrawer, renderMarkdown, api } from './utils.js';

let pollTimer = null;

export function initTasks() { loadTasks(); startPoll(); }

export function stopTasks() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function startPoll() {
  stopTasks();
  pollTimer = setInterval(() => {
    // 只有有 running 任务时才轮询
    const hasRunning = document.querySelector('#taskList .pill-running');
    if (hasRunning) loadTasks();
  }, 3000);
}

async function loadTasks() {
  const list = document.getElementById('taskList');
  if (!list) return;
  try {
    const tasks = await api('/api/tasks');
    if (!tasks.length) { list.innerHTML = '<div class="empty"><div class="icon">📊</div>暂无分析任务<br>发起分析后，步骤和结论会保存在这里</div>'; return; }
    list.innerHTML = tasks.map(t => `
      <div class="task-card" data-tid="${t.id}">
        <div class="tc-head">
          <span class="tc-title">${esc(t.title)}</span>
          <span class="pill pill-${t.status}">${{ running: '运行中', completed: '已完成', interrupted: '已中断', failed: '失败', cancelled: '已取消' }[t.status] || t.status}</span>
        </div>
        <div class="tc-meta">${t.days}天 · ${new Date(t.created_at.includes('T') ? t.created_at : t.created_at.replace(' ','T')+'Z').toLocaleString('zh-CN')} · 点击查看详情</div>
      </div>`).join('');
    list.querySelectorAll('.task-card').forEach(c => c.onclick = () => loadTaskDetail(c.dataset.tid));
  } catch { list.innerHTML = '<div class="empty">加载失败</div>'; }
}

async function loadTaskDetail(id) {
  try {
    const t = await api('/api/tasks/' + id);
    const statusMap = { running: '运行中', completed: '已完成', interrupted: '已中断（服务重启）', failed: '失败', cancelled: '已取消' };
    openDrawer(t.title, `
      <div style="margin-bottom:12px;display:flex;align-items:center;gap:8px">
        <span class="pill pill-${t.status}">${statusMap[t.status] || t.status}</span>
        <span style="font-size:12px;color:var(--dimmer)">${t.days}天 · ${new Date(t.created_at.includes('T')?t.created_at:t.created_at.replace(' ','T')+'Z').toLocaleString('zh-CN')}</span>
      </div>
      ${t.error ? `<div style="padding:8px 12px;background:var(--danger-soft);border-radius:6px;font-size:12px;color:var(--danger);margin-bottom:12px">${esc(t.error)}</div>` : ''}
      ${(t.steps || []).length ? `<h4 style="font-size:13px;color:var(--dim);margin-bottom:8px">执行步骤</h4><div class="timeline">${t.steps.map(s => `<div class="tl-item"><div class="tl-time">${s.type === 'tool_done' ? '工具' : '说明'}</div><div class="tl-text">${esc(s.name)}</div>${s.result ? `<div style="font-size:11px;color:var(--dimmer);margin-top:2px;max-height:60px;overflow:hidden">${esc(s.result.slice(0, 200))}</div>` : ''}</div>`).join('')}</div>` : ''}
      ${(t.evidence || []).length ? `<h4 style="font-size:13px;color:var(--dim);margin:16px 0 8px">证据（${t.evidence.length}）</h4>${t.evidence.map(ev => `<div class="ev-card"><div class="ev-head"><span class="ev-id">${esc(ev.id)}</span><span class="ev-kind">${esc(ev.tool_name)}</span></div><div class="ev-body">${esc((ev.conclusion || '').slice(0, 150))}</div></div>`).join('')}` : ''}
      ${t.conclusion ? `<h4 style="font-size:13px;color:var(--dim);margin:16px 0 8px">结论</h4><div class="text-seg" style="font-size:13px;line-height:1.7">${renderMarkdown(t.conclusion)}</div>` : ''}
      <div style="margin-top:20px;display:flex;gap:8px">
        ${t.status === 'running' ? `<button class="btn btn-danger btn-sm" id="cancelTask">取消</button>` : ''}
        ${(t.status === 'interrupted' || t.status === 'failed') ? `<button class="btn btn-primary btn-sm" id="retryTask">重新发起</button>` : ''}
        <button class="btn btn-sm" id="toSession">回到会话</button>
      </div>
    `);
    const cancelBtn = document.getElementById('cancelTask');
    if (cancelBtn) cancelBtn.onclick = async () => { await api(`/api/tasks/${id}/cancel`, { method: 'POST' }); loadTaskDetail(id); loadTasks(); };
    const retryBtn = document.getElementById('retryTask');
    if (retryBtn) retryBtn.onclick = () => {
      document.getElementById('drawer').hidden = true;
      document.getElementById('taskTitle').value = t.title;
      document.getElementById('taskMsg').value = t.title;
      document.getElementById('taskDays').value = t.days;
      document.getElementById('taskForm').hidden = false;
    };
    const sessBtn = document.getElementById('toSession');
    if (sessBtn && t.session_id) sessBtn.onclick = () => {
      document.getElementById('drawer').hidden = true;
      window.__loadSession(t.session_id);
    };
  } catch (e) { console.error(e); }
}

export function bindTasksEvents() {
  const form = document.getElementById('taskForm');
  document.getElementById('taskNewBtn').onclick = () => {
    form.hidden = false;
    document.getElementById('taskTitle').focus();
  };
  const btn = document.getElementById('taskStart');
  if (btn) btn.onclick = async () => {
    const title = document.getElementById('taskTitle').value.trim();
    const msg = document.getElementById('taskMsg').value.trim() || title;
    const days = +document.getElementById('taskDays').value || 7;
    if (!title) return;
    btn.disabled = true;
    try {
      await api('/api/tasks', { method: 'POST', body: { title, message: msg, days } });
      form.hidden = true;
      document.getElementById('taskTitle').value = '';
      document.getElementById('taskMsg').value = '';
      loadTasks();
    } catch (e) { alert('发起失败: ' + e.message); }
    btn.disabled = false;
  };
  document.getElementById('taskCancelBtn')?.addEventListener('click', () => { form.hidden = true; });
}

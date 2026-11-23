// 工单中心
import { state } from './store.js';
import { esc, fmt, statePill, openDrawer, api, relTime } from './utils.js';

const STATUS_MAP = { pending: '待处理', in_progress: '处理中', resolved: '已解决', cancelled: '已取消' };
const STATUS_NEXT = { pending: 'in_progress', in_progress: 'resolved' };

export function initTickets() { loadTickets(); }

async function loadTickets() {
  const list = document.getElementById('ticketList');
  if (!list) return;
  try {
    const tickets = await api(`/api/tickets${state.tStatus ? '?status=' + state.tStatus : ''}${state.tSearch ? (state.tStatus ? '&' : '?') + 'q=' + encodeURIComponent(state.tSearch) : ''}`);
    if (!tickets.length) { list.innerHTML = '<div class="empty">暂无工单<br>诊断发现问题后可创建工单跟踪处理</div>'; return; }
    list.innerHTML = tickets.map(t => `
      <div class="ticket-row" data-tid="${t.id}">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:500">${esc(t.id)} · ${esc(t.action)}</div>
          <div style="font-size:11px;color:var(--dimmer);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc((t.reason||'').slice(0,60))}</div>
        </div>
        ${t.job_id ? `<span style="font-family:var(--mono);font-size:11px;color:var(--dim)">#${t.job_id}</span>` : ''}
        <span class="pill pill-${t.status}">${STATUS_MAP[t.status] || t.status}</span>
      </div>`).join('');
    list.querySelectorAll('.ticket-row').forEach(r => r.onclick = () => loadTicketDetail(r.dataset.tid));
  } catch { list.innerHTML = '<div class="empty">加载失败</div>'; }
}

async function loadTicketDetail(id) {
  try {
    const t = await api('/api/tickets/' + id);
    openDrawer(t.id, `
      <div style="margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span class="pill pill-${t.status}">${STATUS_MAP[t.status] || t.status}</span>
          <span style="font-size:12px;color:var(--dimmer)">${esc(t.action)} · ${t.job_id ? '作业 #' + t.job_id : ''}</span>
        </div>
        <div class="detail-grid">
          <div class="detail-field"><div class="k">来源任务</div><div class="v">${t.task_id ? esc(t.task_id) : '—'}</div></div>
          <div class="detail-field"><div class="k">关联证据</div><div class="v">${t.evidence_id ? '<a class="evidence-ref" data-ev="' + esc(t.evidence_id) + '">' + esc(t.evidence_id) + '</a>' : '—'}</div></div>
        </div>
        ${t.conclusion ? `<div class="detail-field" style="margin-top:8px"><div class="k">诊断结论</div><div class="v" style="font-size:12px">${esc(t.conclusion.slice(0,300))}</div></div>` : ''}
      </div>
      <h4 style="font-size:13px;color:var(--dim);margin:16px 0 8px">操作时间线</h4>
      <div class="timeline">
        ${(t.events || []).map(ev => `<div class="tl-item"><div class="tl-time">${new Date(ev.created_at.includes('T')?ev.created_at:ev.created_at.replace(' ','T')+'Z').toLocaleString('zh-CN')} · ${esc(ev.actor)}</div><div class="tl-text">${esc(ev.event)}${ev.note ? '：' + esc(ev.note.slice(0,100)) : ''}</div></div>`).join('')}
      </div>
      <div style="margin-top:20px;display:flex;gap:8px;flex-wrap:wrap">
        ${STATUS_NEXT[t.status] ? `<button class="btn btn-primary btn-sm" id="tkNext">推进为"${STATUS_MAP[STATUS_NEXT[t.status]]}"</button>` : ''}
        <button class="btn btn-sm" id="tkNote">添加备注</button>
        ${t.status !== 'resolved' && t.status !== 'cancelled' ? `<button class="btn btn-sm" id="tkCancel">取消工单</button>` : ''}
      </div>
    `);
    const nextBtn = document.getElementById('tkNext');
    if (nextBtn) nextBtn.onclick = async () => {
      await api('/api/tickets/' + id, { method: 'PATCH', body: { status: STATUS_NEXT[t.status] } });
      loadTicketDetail(id); loadTickets();
    };
    const noteBtn = document.getElementById('tkNote');
    if (noteBtn) noteBtn.onclick = async () => {
      const note = prompt('处理备注：');
      if (note) { await api(`/api/tickets/${id}/events`, { method: 'POST', body: { note } }); loadTicketDetail(id); }
    };
    const cancelBtn = document.getElementById('tkCancel');
    if (cancelBtn) cancelBtn.onclick = async () => {
      if (!confirm('取消此工单？')) return;
      await api('/api/tickets/' + id, { method: 'PATCH', body: { status: 'cancelled' } });
      loadTicketDetail(id); loadTickets();
    };
  } catch (e) { console.error(e); }
}

export function bindTicketsEvents() {
  const bind = (id, evt, fn) => { const el = document.getElementById(id); if (el) el[evt] = fn; };
  bind('tkStatusSel', 'onchange', e => { state.tStatus = e.target.value; loadTickets(); });
  let timer;
  bind('tkSearch', 'oninput', e => { clearTimeout(timer); timer = setTimeout(() => { state.tSearch = e.target.value; loadTickets(); }, 300); });
}

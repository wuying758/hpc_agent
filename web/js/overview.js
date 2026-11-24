// 集群总览（智能分析页右侧面板）
import { state } from './store.js';
import { esc, fmt, api } from './utils.js';

let ovDays = 7;
let expandedRow = null;

export function initOverview() {
  // 窄屏默认收起总览
  const ov = document.getElementById('ovPanel');
  if (ov && window.innerWidth < 1100) ov.hidden = true;
  loadOverview();
}

async function loadOverview() {
  const body = document.getElementById('ovBody');
  if (!body) return;
  body.innerHTML = '<div class="empty">加载中…</div>';
  expandedRow = null;
  try {
    const d = await api(`/api/analysis?days=${ovDays}`);
    const counts = d.counts || {};
    const waste = d.waste || {};
    const timeouts = (d.timeout_top || []).slice(0, 5);
    const fails = (d.top_fail || []).slice(0, 5);
    const queues = (d.top_queue || []).slice(0, 5);

    body.innerHTML = `
      <div class="ov-stats">
        <div class="ov-stat"><div class="ov-stat-num">${fmt(d.total)}</div><div class="ov-stat-label">总作业</div></div>
        <div class="ov-stat"><div class="ov-stat-num">${fmt(d.done)}</div><div class="ov-stat-label">已结束</div></div>
        <div class="ov-stat"><div class="ov-stat-num warn">${fmt(d.超时作业数)}</div><div class="ov-stat-label">超时</div></div>
        <div class="ov-stat"><div class="ov-stat-num danger">${fmt(counts.repeat_fail || 0)}</div><div class="ov-stat-label">反复失败</div></div>
      </div>

      <div class="ov-box">
        <div class="ov-box-title">资源浪费（核时）</div>
        <div class="ov-waste">
          <div class="ov-waste-item"><div class="ov-waste-num">${fmt(waste.排队等待核时)}</div><div class="ov-waste-label">排队等待</div></div>
          <div class="ov-waste-item"><div class="ov-waste-num">${fmt(waste.失败核时)}</div><div class="ov-waste-label">失败</div></div>
          <div class="ov-waste-item"><div class="ov-waste-num">${fmt(waste.CPU空闲核时)}</div><div class="ov-waste-label">CPU 空闲</div></div>
        </div>
      </div>

      ${timeouts.length ? `<div class="ov-box">
        <div class="ov-box-head">
          <span class="ov-box-title">超时 Top 5</span>
          <button class="ov-more" data-cat="timeout" title="查看更多">
            更多
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>
          </button>
        </div>
        ${timeouts.map(j => `<div class="ov-row" data-key="timeout-${j.id}">
          <span class="ov-name" title="${esc(j.name)}">${esc(j.name)}</span>
          <span class="ov-val">${j.运行h}h · ${j.申请核}核</span>
        </div>
        <div class="ov-detail" data-detail="timeout-${j.id}" hidden></div>`).join('')}
      </div>` : ''}

      ${fails.length ? `<div class="ov-box">
        <div class="ov-box-head">
          <span class="ov-box-title">反复失败 Top 5</span>
          <button class="ov-more" data-cat="fail" title="查看更多">
            更多
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>
          </button>
        </div>
        ${fails.map((f, i) => `<div class="ov-row" data-key="fail-${i}">
          <span class="ov-name" title="${esc(f.name)}">${esc(f.name)}</span>
          <span class="ov-val">${f.count}次 · ${fmt(f.waste_core_h)}核时</span>
        </div>
        <div class="ov-detail" data-detail="fail-${i}" hidden></div>`).join('')}
      </div>` : ''}

      ${queues.length ? `<div class="ov-box">
        <div class="ov-box-head">
          <span class="ov-box-title">长排队 Top 5</span>
          <button class="ov-more" data-cat="queue" title="查看更多">
            更多
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>
          </button>
        </div>
        ${queues.map(j => `<div class="ov-row" data-key="queue-${j.id}">
          <span class="ov-name" title="${esc(j.name)}">${esc(j.name)}</span>
          <span class="ov-val">排队${j.排队h || Math.round((j.queue_max_min||0)/60) || '?'}h</span>
        </div>
        <div class="ov-detail" data-detail="queue-${j.id}" hidden></div>`).join('')}
      </div>` : ''}
    `;

    // "更多"按钮 → 弹窗（显示完整列表 + 操作）
    body.querySelectorAll('.ov-more').forEach(btn => {
      btn.onclick = () => {
        const cat = btn.dataset.cat;
        if (cat === 'timeout') openCatModal('超时作业', d.timeout_top || [], 'job');
        else if (cat === 'fail') openCatModal('反复失败', d.top_fail || [], 'fail');
        else if (cat === 'queue') openCatModal('长排队', d.top_queue || [], 'job');
      };
    });

    // 行点击 → 展开/收起行内详情
    body.querySelectorAll('.ov-row').forEach(el => {
      el.onclick = () => toggleDetail(el);
    });
  } catch (e) {
    body.innerHTML = `<div class="empty" style="color:var(--danger)">加载失败</div>`;
  }
}

// 行内展开详情
async function toggleDetail(rowEl) {
  const key = rowEl.dataset.key;
  const detailEl = rowEl.nextElementSibling;
  if (!detailEl || !detailEl.classList.contains('ov-detail')) return;

  if (expandedRow && expandedRow !== key) {
    const prev = document.querySelector(`[data-detail="${expandedRow}"]`);
    if (prev) prev.hidden = true;
  }
  if (!detailEl.hidden) { detailEl.hidden = true; expandedRow = null; return; }
  expandedRow = key;
  detailEl.hidden = false;
  detailEl.innerHTML = '<div style="font-size:12px;color:var(--dimmer);padding:8px">加载中…</div>';

  try {
    const [type, idStr] = key.split('-');
    let html = '';

    if (type === 'fail') {
      const name = rowEl.querySelector('.ov-name')?.textContent || '';
      const val = rowEl.querySelector('.ov-val')?.textContent || '';
      html = `
        <div class="ov-detail-grid">
          <div class="ov-df"><span class="k">作业名</span><span class="v">${esc(name)}</span></div>
          <div class="ov-df"><span class="k">浪费</span><span class="v">${val}</span></div>
        </div>
        <div class="ov-detail-actions">
          <button class="ov-act" data-act="ask" data-msg="分析反复失败作业 ${esc(name)}">问 Agent</button>
          <button class="ov-act" data-act="ticket" data-name="${esc(name)}">发起工单</button>
        </div>`;
    } else {
      const id = +idStr;
      const j = await api(`/api/jobs/${id}?days=30`);
      html = `
        <div class="ov-detail-grid">
          <div class="ov-df"><span class="k">状态</span><span class="v">${esc(j.state)}</span></div>
          <div class="ov-df"><span class="k">运行</span><span class="v">${j.运行小时}h</span></div>
          <div class="ov-df"><span class="k">申请</span><span class="v">${j.申请核}核 / ${j.内存GB||'?'}GB</span></div>
          <div class="ov-df"><span class="k">利用率</span><span class="v">${esc(j.CPU利用率)}</span></div>
        </div>
        <div class="ov-detail-actions">
          <button class="ov-act" data-act="ask" data-jobid="${id}">问 Agent</button>
          <button class="ov-act" data-act="ticket" data-jobid="${id}" data-state="${esc(j.state)}" data-name="${esc(j.name)}">发起工单</button>
        </div>`;
    }
    detailEl.innerHTML = html;

    detailEl.querySelector('[data-act="ask"]')?.addEventListener('click', (e) => {
      const jobid = e.target.dataset.jobid;
      const msg = e.target.dataset.msg || (jobid ? `诊断作业 #${jobid}` : '');
      document.getElementById('q').value = msg;
      document.getElementById('q').focus();
    });
    detailEl.querySelector('[data-act="ticket"]')?.addEventListener('click', (e) => {
      const jobid = e.target.dataset.jobid;
      const jobName = e.target.dataset.name;
      const jobState = e.target.dataset.state;
      showTicketPrompt(jobid, jobName, jobState);
    });
  } catch {
    detailEl.innerHTML = '<div style="font-size:12px;color:var(--danger);padding:8px">加载失败</div>';
  }
}

// "更多"弹窗：显示完整列表 + 每行操作
function openCatModal(title, items, type) {
  let modal = document.getElementById('ovModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'ovModal';
    modal.className = 'ov-modal-overlay';
    document.body.appendChild(modal);
  }
  const rows = items.slice(0, 20).map((item, i) => {
    if (type === 'fail') {
      return `<div class="ov-modal-row" data-idx="${i}">
        <span class="ov-name" title="${esc(item.name)}">${esc(item.name)}</span>
        <span class="ov-val">${item.count}次 · ${fmt(item.waste_core_h)}核时</span>
      </div>`;
    }
    const val = type === 'timeout'
      ? `${item.运行h}h · ${item.申请核}核`
      : `排队${item.排队h || Math.round((item.queue_max_min||0)/60) || '?'}h`;
    return `<div class="ov-modal-row" data-idx="${i}">
      <span class="ov-name" title="${esc(item.name)}">${esc(item.name)}</span>
      <span class="ov-id">#${item.id}</span>
      <span class="ov-val">${val}</span>
    </div>`;
  }).join('');

  modal.innerHTML = `
    <div class="ov-modal">
      <div class="ov-modal-head">
        <h3>${title}（${Math.min(items.length, 20)}）</h3>
        <button class="ov-modal-close">&times;</button>
      </div>
      <div class="ov-modal-body">
        <div class="ov-modal-list">${rows}</div>
      </div>
    </div>`;
  modal.hidden = false;
  modal.onclick = (e) => { if (e.target === modal) modal.hidden = true; };
  modal.querySelector('.ov-modal-close').onclick = () => modal.hidden = true;

  // 每行点击 → 展开操作
  modal.querySelectorAll('.ov-modal-row').forEach(row => {
    row.style.cursor = 'pointer';
    row.onclick = () => {
      const idx = +row.dataset.idx;
      const item = items[idx];
      let detail = row.nextElementSibling;
      if (detail && detail.classList.contains('ov-modal-detail')) { detail.remove(); return; }
      // 移除其他展开
      modal.querySelectorAll('.ov-modal-detail').forEach(el => el.remove());

      let html = '<div class="empty" style="padding:8px;font-size:12px">加载中…</div>';
      const detailEl = document.createElement('div');
      detailEl.className = 'ov-modal-detail';
      detailEl.innerHTML = html;
      row.after(detailEl);

      const fillActions = (jobid, jobName, jobState) => {
        detailEl.innerHTML = `
          <div class="ov-detail-grid">
            ${jobState ? `<div class="ov-df"><span class="k">状态</span><span class="v">${esc(jobState)}</span></div>` : ''}
          </div>
          <div class="ov-detail-actions">
            <button class="ov-act" id="mAsk">问 Agent</button>
            <button class="ov-act" id="mTk">发起工单</button>
          </div>`;
        detailEl.querySelector('#mAsk').onclick = () => {
          modal.hidden = true;
          const msg = jobid ? `诊断作业 #${jobid}` : `分析反复失败作业 ${jobName}`;
          document.getElementById('q').value = msg;
          document.getElementById('q').focus();
        };
        detailEl.querySelector('#mTk').onclick = () => {
          modal.hidden = true;
          showTicketPrompt(jobid, jobName, jobState);
        };
      };

      if (type === 'fail') {
        fillActions(item.last, item.name, null);
      } else {
        api(`/api/jobs/${item.id}?days=30`).then(j => {
          fillActions(item.id, j.name, j.state);
        }).catch(() => {
          detailEl.innerHTML = '<div style="font-size:12px;color:var(--danger);padding:8px">加载失败</div>';
        });
      }
    };
  });
}

// 工单弹窗
function showTicketPrompt(jobId, jobName, jobState) {
  let modal = document.getElementById('ovTicketModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'ovTicketModal';
    modal.className = 'ov-modal-overlay';
    document.body.appendChild(modal);
  }
  const canOperate = jobState && ['RUNNING','PENDING','RESIZING','SUSPENDED'].includes(jobState);
  modal.innerHTML = `
    <div class="ov-modal">
      <div class="ov-modal-head">
        <h3>发起工单</h3>
        <button class="ov-modal-close">&times;</button>
      </div>
      <div class="ov-modal-body">
        ${jobId ? `<p style="font-size:13px;margin-bottom:12px">作业 <b>#${jobId}</b> · ${esc(jobName || '')}</p>` : ''}
        <label style="font-size:12px;color:var(--dim);display:block;margin-bottom:6px">操作类型</label>
        <select id="tkAction" style="width:100%;margin-bottom:12px">
          <option value="contact_user">联系用户</option>
          ${canOperate ? '<option value="suspend">暂停作业</option><option value="terminate">终止作业</option>' : ''}
        </select>
        <label style="font-size:12px;color:var(--dim);display:block;margin-bottom:6px">原因说明</label>
        <textarea id="tkReason" style="width:100%;min-height:60px" placeholder="简述原因…"></textarea>
        ${jobState && !canOperate ? `<p style="font-size:11px;color:var(--warn);margin-top:8px">作业状态 ${esc(jobState)} 不在可操作白名单，仅可联系用户</p>` : ''}
      </div>
      <div class="ov-modal-foot">
        <button class="btn btn-sm ov-modal-cancel">取消</button>
        <button class="btn btn-primary btn-sm ov-modal-ok">创建工单</button>
      </div>
    </div>`;
  modal.hidden = false;
  modal.onclick = (e) => { if (e.target === modal) modal.hidden = true; };
  modal.querySelector('.ov-modal-close').onclick = () => modal.hidden = true;
  modal.querySelector('.ov-modal-cancel').onclick = () => modal.hidden = true;
  modal.querySelector('.ov-modal-ok').onclick = async () => {
    const action = document.getElementById('tkAction').value;
    const reason = document.getElementById('tkReason').value.trim();
    if (!reason) { alert('请填写原因'); return; }
    try {
      const r = await api('/api/tickets', { method: 'POST', body: { action, job_id: jobId, reason } });
      alert(`工单已创建：${r.id}`);
      modal.hidden = true;
    } catch (e) { alert('创建失败: ' + e.message); }
  };
}

export function bindOverviewEvents() {
  document.getElementById('ovDaysSel')?.addEventListener('change', e => {
    ovDays = +e.target.value;
    loadOverview();
  });
}

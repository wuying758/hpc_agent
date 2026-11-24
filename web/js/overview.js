// 集群总览（智能分析页右侧面板）
import { isNarrowLayout, setPanelOpen } from './panels.js';
import { esc, fmt, api } from './utils.js';

let ovDays = 7;
let expandedRow = null;
let requestVersion = 0;
let loadedDays = null;

export function initOverview() {
  loadOverview();
}

async function loadOverview() {
  const body = document.getElementById('ovBody');
  if (!body) return;
  const version = ++requestVersion;
  const days = ovDays;
  body.setAttribute('aria-busy', 'true');
  document.getElementById('ovNotice').hidden = true;
  try {
    const d = await api(`/api/analysis?days=${days}`);
    if (version !== requestVersion) return;
    loadedDays = days;
    expandedRow = null;
    const counts = d.counts || {};
    const waste = d.waste || {};
    const coverage = d.cpuSec可用比例;
    const cpuUsable = typeof coverage === 'number' && coverage >= 0.2;
    const coverageText = typeof coverage === 'number' ? (coverage * 100).toFixed(1) + '%' : '未知';
    const updated = d._generatedAt ? new Date(d._generatedAt).toLocaleString('zh-CN', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }) : '—';
    const timeouts = (d.timeout_top || []).slice(0, 5);
    const fails = (d.top_fail || []).slice(0, 5);
    const queues = (d.top_queue || []).slice(0, 5);

    body.innerHTML = `
      <div class="ov-data-meta"><span>${esc(d.口径 || `近${days}天提交的作业`)}</span><span>快照生成 ${esc(updated)}</span></div>
      <div class="ov-stats">
        <div class="ov-stat"><div class="ov-stat-num">${fmt(d.total)}</div><div class="ov-stat-label">总作业</div></div>
        <div class="ov-stat"><div class="ov-stat-num">${fmt(d.done)}</div><div class="ov-stat-label">已结束</div></div>
        <div class="ov-stat"><div class="ov-stat-num warn">${fmt(d.超时作业数)}</div><div class="ov-stat-label">超时</div></div>
        <div class="ov-stat"><div class="ov-stat-num danger">${fmt(counts.repeat_fail || 0)}</div><div class="ov-stat-label">反复失败</div></div>
      </div>

      <div class="ov-box">
        <div class="ov-box-head"><span class="ov-box-title">资源时间</span><span class="ov-unit">核时</span></div>
        <div class="ov-waste">
          <div class="ov-waste-item"><div class="ov-waste-num">${fmt(waste.排队等待核时)}</div><div class="ov-waste-label">排队等待</div></div>
          <div class="ov-waste-item"><div class="ov-waste-num">${fmt(waste.失败核时)}</div><div class="ov-waste-label">失败</div></div>
          <div class="ov-waste-item"><div class="ov-waste-num">${cpuUsable ? fmt(waste.CPU空闲核时) : '—'}</div><div class="ov-waste-label">CPU 空闲估算</div></div>
        </div>
        <p class="ov-cpu-note ${cpuUsable ? '' : 'is-limited'}"><span aria-hidden="true">${cpuUsable ? 'ⓘ' : '△'}</span> CPU 记账覆盖 ${coverageText}。${cpuUsable ? '空闲估算仅基于已有记账记录。' : '记账不足，CPU 空闲暂不可评估。'}</p>
      </div>

      ${timeouts.length ? `<div class="ov-box">
        <div class="ov-box-head">
          <span class="ov-box-title">超时 Top 5</span>
          <button class="ov-more" data-cat="timeout" title="查看更多">
            更多
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>
          </button>
        </div>
        ${timeouts.map((j, i) => `<button type="button" class="ov-row" data-key="timeout-${j.id}" aria-expanded="false"><span class="ov-rank">${i + 1}</span>
          <span class="ov-name" title="${esc(j.name)}"><span>${esc(j.name)}</span><small>#${j.id}</small></span>
          <span class="ov-val">${j.运行h}h · ${j.申请核}核</span>
        </button>
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
        ${fails.map((f, i) => `<button type="button" class="ov-row" data-key="fail-${i}" aria-expanded="false"><span class="ov-rank">${i + 1}</span>
          <span class="ov-name" title="${esc(f.name)}">${esc(f.name)}</span>
          <span class="ov-val">${f.count}次 · ${fmt(f.waste_core_h)}核时</span>
        </button>
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
        ${queues.map((j, i) => `<button type="button" class="ov-row" data-key="queue-${j.id}" aria-expanded="false"><span class="ov-rank">${i + 1}</span>
          <span class="ov-name" title="${esc(j.name)}"><span>${esc(j.name)}</span><small>#${j.id}</small></span>
          <span class="ov-val">排队${queueHours(j)}</span>
        </button>
        <div class="ov-detail" data-detail="queue-${j.id}" hidden></div>`).join('')}
      </div>` : ''}
    `;

    // "更多"按钮 → 弹窗（显示完整列表 + 操作）
    body.querySelectorAll('.ov-more').forEach(btn => {
      btn.onclick = () => {
        const cat = btn.dataset.cat;
        if (cat === 'timeout') openCatModal('超时作业', d.timeout_top || [], 'timeout');
        else if (cat === 'fail') openCatModal('反复失败', d.top_fail || [], 'fail');
        else if (cat === 'queue') openCatModal('长排队', d.top_queue || [], 'queue');
      };
    });

    // 行点击 → 展开/收起行内详情
    body.querySelectorAll('.ov-row').forEach(el => {
      el.onclick = () => toggleDetail(el, d);
    });
  } catch (e) {
    if (version !== requestVersion) return;
    const notice = document.getElementById('ovNotice');
    notice.hidden = false;
    notice.querySelector('span').textContent = loadedDays == null ? '总览加载失败' : '更新失败，已保留上次快照';
    notice.querySelector('button').onclick = () => {
      ovDays = days;
      document.getElementById('ovDaysSel').value = days;
      loadOverview();
    };
    if (loadedDays == null) body.innerHTML = '<div class="empty">暂时无法读取集群概览</div>';
    else {
      ovDays = loadedDays;
      document.getElementById('ovDaysSel').value = loadedDays;
    }
  } finally {
    if (version === requestVersion) body.setAttribute('aria-busy', 'false');
  }
}

function queueHours(item) {
  const hours = item.排队h ?? (item.queue_max_min == null ? null : Math.round(item.queue_max_min / 6) / 10);
  return hours == null ? '—' : `${hours}h`;
}

// 行内展开详情
async function toggleDetail(rowEl, snapshot) {
  const key = rowEl.dataset.key;
  const detailEl = rowEl.nextElementSibling;
  if (!detailEl || !detailEl.classList.contains('ov-detail')) return;

  if (expandedRow && expandedRow !== key) {
    const prev = document.querySelector(`[data-detail="${expandedRow}"]`);
    if (prev) {
      prev.hidden = true;
      prev.previousElementSibling?.setAttribute('aria-expanded', 'false');
    }
  }
  if (!detailEl.hidden) { detailEl.hidden = true; rowEl.setAttribute('aria-expanded', 'false'); expandedRow = null; return; }
  expandedRow = key;
  rowEl.setAttribute('aria-expanded', 'true');
  detailEl.hidden = false;
  detailEl.innerHTML = '<div style="font-size:12px;color:var(--dimmer);padding:8px">加载中…</div>';

  try {
    const [type, idStr] = key.split('-');
    let html = '';

    if (type === 'fail') {
      const group = snapshot.top_fail[+idStr];
      const name = group.name;
      const val = rowEl.querySelector('.ov-val')?.textContent || '';
      html = `
        <div class="ov-detail-grid">
          <div class="ov-df"><span class="k">作业名</span><span class="v">${esc(name)}</span></div>
          <div class="ov-df"><span class="k">浪费</span><span class="v">${val}</span></div>
        </div>
        <div class="ov-detail-actions">
          <button class="ov-act" data-act="ask" data-msg="分析用户 ${esc(group.user)} 的反复失败作业 ${esc(name)}，代表作业 #${group.last}">问 Agent</button>
          <button class="ov-act" data-act="ticket" data-jobid="${group.last}" data-name="${esc(name)}">发起工单</button>
        </div>`;
    } else {
      const id = +idStr;
      const j = await api(`/api/jobs/${id}?days=${loadedDays}`);
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
      prefillQuestion(msg);
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
      : `排队${queueHours(item)}`;
    return `<div class="ov-modal-row" data-idx="${i}">
      <span class="ov-name" title="${esc(item.name)}">${esc(item.name)}</span>
      <span class="ov-id">#${item.id}</span>
      <span class="ov-val">${val}</span>
    </div>`;
  }).join('');

  modal.innerHTML = `
    <div class="ov-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}" tabindex="-1">
      <div class="ov-modal-head">
        <h3>${title}（${Math.min(items.length, 20)}）</h3>
        <button class="ov-modal-close">&times;</button>
      </div>
      <div class="ov-modal-body">
        <div class="ov-modal-list">${rows}</div>
      </div>
    </div>`;
  showModal(modal);
  modal.onclick = (e) => { if (e.target === modal) closeModal(modal); };
  modal.querySelector('.ov-modal-close').onclick = () => closeModal(modal);

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
          closeModal(modal);
          const msg = jobid ? `诊断作业 #${jobid}` : `分析反复失败作业 ${jobName}`;
          prefillQuestion(msg);
        };
        detailEl.querySelector('#mTk').onclick = () => {
          closeModal(modal);
          showTicketPrompt(jobid, jobName, jobState);
        };
      };

      if (type === 'fail') {
        fillActions(item.last, item.name, null);
      } else {
        api(`/api/jobs/${item.id}?days=${loadedDays}`).then(j => {
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
    <div class="ov-modal" role="dialog" aria-modal="true" aria-label="发起工单" tabindex="-1">
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
  showModal(modal);
  modal.onclick = (e) => { if (e.target === modal) closeModal(modal); };
  modal.querySelector('.ov-modal-close').onclick = () => closeModal(modal);
  modal.querySelector('.ov-modal-cancel').onclick = () => closeModal(modal);
  modal.querySelector('.ov-modal-ok').onclick = async () => {
    const action = document.getElementById('tkAction').value;
    const reason = document.getElementById('tkReason').value.trim();
    if (!reason) { document.getElementById('tkReason').focus(); return; }
    const button = modal.querySelector('.ov-modal-ok');
    button.disabled = true;
    button.textContent = '创建中…';
    try {
      const r = await api('/api/tickets', { method: 'POST', body: { action, job_id: jobId, reason } });
      alert(`工单已创建：${r.id}`);
      closeModal(modal);
    } catch (e) { alert('创建失败: ' + e.message); }
    finally { button.disabled = false; button.textContent = '创建工单'; }
  };
}

function prefillQuestion(message) {
  if (isNarrowLayout()) setPanelOpen('ovPanel', false);
  const input = document.getElementById('q');
  input.value = message;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

const modalTriggers = new WeakMap();

function showModal(modal) {
  modalTriggers.set(modal, document.activeElement);
  modal.hidden = false;
  modal.querySelector('.ov-modal-close').focus();
}

function closeModal(modal) {
  modal.hidden = true;
  const trigger = modalTriggers.get(modal);
  if (trigger?.isConnected) trigger.focus();
}

export function bindOverviewEvents() {
  document.addEventListener('keydown', e => {
    const modal = [...document.querySelectorAll('.ov-modal-overlay:not([hidden])')].pop();
    if (!modal) return;
    if (e.key === 'Escape') { e.preventDefault(); closeModal(modal); }
    if (e.key === 'Tab') {
      const buttons = [...modal.querySelectorAll('button, select, textarea, [tabindex="0"]')].filter(el => !el.disabled && !el.hidden);
      const first = buttons[0], last = buttons.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  document.getElementById('ovDaysSel')?.addEventListener('change', e => {
    ovDays = +e.target.value;
    loadOverview();
  });
}

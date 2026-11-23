// 集群总览（智能分析页右侧面板）
import { state } from './store.js';
import { esc, fmt, api, openDrawer } from './utils.js';

let ovDays = 7;

export function initOverview() { loadOverview(); }

async function loadOverview() {
  const body = document.getElementById('ovBody');
  if (!body) return;
  body.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const d = await api(`/api/analysis?days=${ovDays}`);
    const counts = d.counts || {};
    const waste = d.waste || {};
    
    body.innerHTML = `
      <!-- 概览数字 -->
      <div class="ov-stats">
        <div class="ov-stat"><div class="ov-stat-num">${fmt(d.total)}</div><div class="ov-stat-label">总作业</div></div>
        <div class="ov-stat"><div class="ov-stat-num">${fmt(d.done)}</div><div class="ov-stat-label">已结束</div></div>
        <div class="ov-stat"><div class="ov-stat-num warn">${fmt(d.超时作业数)}</div><div class="ov-stat-label">超时</div></div>
        <div class="ov-stat"><div class="ov-stat-num danger">${fmt(counts.repeat_fail || 0)}</div><div class="ov-stat-label">反复失败</div></div>
      </div>
      
      <!-- 浪费 -->
      <div class="ov-waste-row">
        <span title="排队等待核时">排队 ${fmt(waste.排队等待核时)}</span>
        <span title="失败核时">失败 ${fmt(waste.失败核时)}</span>
        <span title="CPU空闲核时">空闲 ${fmt(waste.CPU空闲核时)}</span>
      </div>
      <div style="font-size:11px;color:var(--dimmer);margin-bottom:12px">核时浪费 · ${d.口径}</div>
      
      <!-- 超时 Top5 -->
      ${renderMiniTable('超时 Top 5', d.timeout_top?.slice(0,5), j => `<span class="mono">#${j.id}</span> ${esc(j.name)} <span class="dim">${j.运行h}h/${j.申请核}核</span>`)}
      
      <!-- 反复失败 Top5 -->
      ${renderMiniTable('反复失败 Top 5', d.top_fail?.slice(0,5), f => `${esc(f.name)} <span class="dim">${f.count}次 ${fmt(f.waste_core_h)}核时</span>`)}
      
      <!-- 长排队 Top5 -->
      ${renderMiniTable('长排队 Top 5', d.top_queue?.slice(0,5), j => `<span class="mono">#${j.id}</span> ${esc(j.name)} <span class="dim">${j.queue_max_min}min</span>`)}
    `;
    // 绑定点击
    body.querySelectorAll('[data-job]').forEach(el => el.onclick = () => openJobDetail(+el.dataset.job));
    body.querySelectorAll('[data-fail]').forEach(el => el.onclick = () => openFailDetail(JSON.parse(el.dataset.fail)));
  } catch (e) {
    body.innerHTML = `<div class="empty" style="color:var(--danger)">加载失败</div>`;
  }
}

function renderMiniTable(title, data, rowFn) {
  if (!data?.length) return '';
  return `<div class="ov-section-mini">
    <div class="ov-section-title">${title}</div>
    ${data.map((r, i) => `<div class="ov-row-mini ${r._data ? '' : ''}" ${r._jobAttr || ''}>${rowFn(r)}</div>`).join('')}
  </div>`;
}

function openJobDetail(id) {
  openDrawer(`作业 #${id}`, `<div class="empty">加载中…</div>`);
  api(`/api/jobs/${id}?days=30`).then(j => {
    document.getElementById('drawerBody').innerHTML = `
      <div class="detail-grid">
        <div class="detail-field"><div class="k">名称</div><div class="v">${esc(j.name)}</div></div>
        <div class="detail-field"><div class="k">分区</div><div class="v">${esc(j.partition)}</div></div>
        <div class="detail-field"><div class="k">状态</div><div class="v">${esc(j.state)}</div></div>
        <div class="detail-field"><div class="k">运行时长</div><div class="v">${j.运行小时}h</div></div>
        <div class="detail-field"><div class="k">申请</div><div class="v">${j.申请核}核 / ${j.内存GB||'?'}GB</div></div>
        <div class="detail-field"><div class="k">利用率</div><div class="v">${esc(j.CPU利用率)}</div></div>
      </div>
      <button class="btn btn-primary btn-sm" id="ovDiag" style="margin-top:16px">发起诊断</button>
    `;
    document.getElementById('ovDiag').onclick = () => {
      document.getElementById('drawer').hidden = true;
      document.getElementById('q').value = `诊断作业 #${id}`;
      document.getElementById('q').focus();
    };
  });
}

function openFailDetail(f) {
  openDrawer(`反复失败：${f.name}`, `
    <div class="detail-grid">
      <div class="detail-field"><div class="k">用户</div><div class="v">${esc(f.user)}</div></div>
      <div class="detail-field"><div class="k">次数</div><div class="v">${f.count}</div></div>
      <div class="detail-field"><div class="k">浪费核时</div><div class="v">${fmt(f.waste_core_h)}</div></div>
      <div class="detail-field"><div class="k">最后 ID</div><div class="v mono">#${f.last}</div></div>
    </div>
    <button class="btn btn-primary btn-sm" id="ovDiagF" style="margin-top:16px">诊断 #${f.last}</button>
  `);
  document.getElementById('ovDiagF').onclick = () => {
    document.getElementById('drawer').hidden = true;
    document.getElementById('q').value = `诊断作业 #${f.last} 反复失败的原因`;
    document.getElementById('q').focus();
  };
}

export function bindOverviewEvents() {
  document.getElementById('ovDaysSel')?.addEventListener('change', e => {
    ovDays = +e.target.value;
    loadOverview();
  });
}

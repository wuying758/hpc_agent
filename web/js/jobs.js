// 作业中心
import { state } from './store.js';
import { esc, fmt, statePill, openDrawer, api, relTime } from './utils.js';

export function initJobs() { loadJobsList(); }

// 切换账号后：重置筛选并重新加载
export function refreshJobs() {
  state.jState = ''; state.jPartition = ''; state.jDays = 7; state.jSearch = ''; state.jPage = 1;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('jStateSel', ''); set('jDaysSel', '7'); set('jSearch', '');
  loadJobsList();
}

async function loadJobsList() {
  const tbody = document.querySelector('#jobsTable tbody');
  const info = document.getElementById('jobsInfo');
  if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--dimmer)">加载中…</td></tr>';
  try {
    const d = await api(`/api/jobs?days=${state.jDays}&page=${state.jPage}&size=20${state.jState ? '&state=' + state.jState : ''}${state.jSearch ? '&q=' + encodeURIComponent(state.jSearch) : ''}`);
    if (info) info.textContent = `共 ${fmt(d.total)} 条 · ${d.口径}`;
    const totalPages = Math.ceil(d.total / d.size) || 1;
    document.getElementById('jPrev').disabled = state.jPage <= 1;
    document.getElementById('jNext').disabled = state.jPage >= totalPages;
    document.getElementById('jPageInfo').textContent = `${state.jPage}/${totalPages}`;
    if (tbody) tbody.innerHTML = d.items.map(j => `<tr data-jid="${j.id}">
      <td style="font-family:var(--mono);font-size:11px">#${j.id}</td>
      <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(j.name)}</td>
      <td style="font-size:12px;color:var(--dim)">${esc((j.user||'').slice(0,12))}</td>
      <td>${esc(j.partition)}</td>
      <td>${statePill(j.state)}</td>
      <td class="num">${j.运行h}</td>
      <td class="num">${j.cpu_req}</td>
      <td style="font-size:11px;color:var(--dimmer)">${j.submit ? new Date(j.submit*1000).toLocaleDateString('zh-CN') : ''}</td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty">无结果</td></tr>';
    if (tbody) tbody.querySelectorAll('tr[data-jid]').forEach(tr => tr.onclick = () => loadJobDetail(tr.dataset.jid));
  } catch (e) {
    const msg = e.message?.startsWith('401') ? '请先登录 JAccount' : `加载失败: ${e.message}`;
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="color:var(--danger)">${esc(msg)}</td></tr>`;
  }
}

async function loadJobDetail(id) {
  try {
    const j = await api(`/api/jobs/${id}?days=30`);
    const timeline = [];
    if (j.提交) timeline.push({ time: j.提交, text: '提交' });
    if (j.开始 !== '未开始') timeline.push({ time: j.开始, text: `开始运行（排队 ${j.排队分钟 != null ? j.排队分钟 + 'min' : '?'}）` });
    if (j.结束 !== '运行中/未记录') timeline.push({ time: j.结束, text: `结束（${j.state}，退出码 ${j.退出码}）` });
    if (j.结束 === '运行中/未记录' && j.state === 'RUNNING') timeline.push({ time: '—', text: '运行中' });

    openDrawer(`作业 #${j.id}`, `
      <div style="margin-bottom:16px">
        <div style="font-size:16px;font-weight:600;margin-bottom:4px">${esc(j.name)}</div>
        <div style="font-size:12px;color:var(--dimmer)">${esc(j.partition)} · ${esc(j.user)} · ${j.口径}</div>
      </div>
      <div class="detail-grid">
        <div class="detail-field"><div class="k">状态</div><div class="v">${statePill(j.state)}</div></div>
        <div class="detail-field"><div class="k">运行时长</div><div class="v">${j.运行小时}h</div></div>
        <div class="detail-field"><div class="k">时限</div><div class="v">${j.时限小时 ? j.时限小时 + 'h' : '无限'}</div></div>
        <div class="detail-field"><div class="k">申请资源</div><div class="v">${j.申请核} 核 / ${j.内存GB ? j.内存GB + ' GB' : '?'} 内存</div></div>
        <div class="detail-field"><div class="k">CPU 利用率</div><div class="v">${j.CPU利用率}</div></div>
        <div class="detail-field"><div class="k">退出码</div><div class="v">${j.退出码 || '—'}</div></div>
      </div>
      <h4 style="font-size:13px;margin:16px 0 8px;color:var(--dim)">时间线</h4>
      <div class="timeline">
        ${timeline.map(t => `<div class="tl-item"><div class="tl-time">${esc(t.time)}</div><div class="tl-text">${esc(t.text)}</div></div>`).join('')}
      </div>
      ${j.历史同名 > 1 ? `<h4 style="font-size:13px;margin:16px 0 8px;color:var(--dim)">历史同名（${j.历史同名}）</h4><p style="font-size:12px;color:var(--dimmer)">同用户同名称共 ${j.历史同名} 个作业</p>` : ''}
      <div style="margin-top:20px;display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" id="diagBtn">发起诊断</button>
      </div>
    `);
    document.getElementById('diagBtn').onclick = () => {
      document.getElementById('drawer').hidden = true;
      navigate('chat');
      setTimeout(() => {
        document.getElementById('q').value = `诊断作业 #${j.id} 的低效原因`;
        document.getElementById('q').focus();
      }, 100);
    };
  } catch (e) { console.error(e); }
}

function navigate(page) { window.location.hash = '#/' + page; }

export function bindJobsEvents() {
  const bind = (id, evt, fn) => { const el = document.getElementById(id); if (el) el[evt] = fn; };
  bind('jStateSel', 'onchange', e => { state.jState = e.target.value; state.jPage = 1; loadJobsList(); });
  bind('jDaysSel', 'onchange', e => { state.jDays = +e.target.value; state.jPage = 1; loadJobsList(); });
  let timer;
  bind('jSearch', 'oninput', e => { clearTimeout(timer); timer = setTimeout(() => { state.jSearch = e.target.value; state.jPage = 1; loadJobsList(); }, 300); });
  bind('jPrev', 'onclick', () => { if (state.jPage > 1) { state.jPage--; loadJobsList(); } });
  bind('jNext', 'onclick', () => { state.jPage++; loadJobsList(); });
}

// 证据卡片组件
import { api, esc, openDrawer, beginDrawerRequest, closeDrawer } from './utils.js';

export async function loadEvidence(id) {
  const isCurrent = beginDrawerRequest();
  try {
    const ev = await api('/api/evidence/' + id);
    if (!isCurrent()) return;
    if (!ev || ev.error) return;
    const kindMap = { fact: '事实数据', rule: '规则判断', suggestion: '优化建议' };
    openDrawer('证据 ' + ev.id, `
      <div class="ev-card">
        <div class="ev-head">
          <span class="ev-id">${esc(ev.id)}</span>
          <span class="ev-kind">${kindMap[ev.kind] || ev.kind}</span>
        </div>
        <div class="ev-body">
          <div class="detail-grid">
            <div class="detail-field"><div class="k">工具</div><div class="v">${esc(ev.tool_name)}</div></div>
            <div class="detail-field"><div class="k">时间窗口</div><div class="v">${esc(ev.window)}</div></div>
            <div class="detail-field"><div class="k">数据来源</div><div class="v">${esc(ev.source)}</div></div>
            <div class="detail-field"><div class="k">采集时间</div><div class="v">${ev.data_collected_at ? esc(ev.data_collected_at) : '未记录'}</div></div>
          </div>
          ${ev.query ? `<div class="detail-field" style="margin-bottom:8px"><div class="k">查询条件</div><div class="v" style="font-family:var(--mono);font-size:12px">${esc(ev.query)}</div></div>` : ''}
          ${ev.key_fields ? `<div class="detail-field" style="margin-bottom:8px"><div class="k">关键字段</div><div class="v" style="font-size:12px">${esc(ev.key_fields)}</div></div>` : ''}
          ${ev.calculation ? `<div class="detail-field" style="margin-bottom:8px"><div class="k">计算依据</div><div class="v" style="font-size:12px">${esc(ev.calculation)}</div></div>` : ''}
          ${ev.conclusion ? `<div class="detail-field"><div class="k">结论</div><div class="v" style="font-size:13px">${esc(ev.conclusion)}</div></div>` : ''}
        </div>
      </div>
    `);
  } catch (e) { console.error('evidence load fail:', e); }
}

export function initEvidence() {
  // 全局点击 [E1] 引用
  document.addEventListener('click', e => {
    const ref = e.target.closest('.evidence-ref[data-ev]');
    if (ref) { e.preventDefault(); loadEvidence(ref.dataset.ev); }
  });
  document.getElementById('drawerClose').onclick = closeDrawer;
  document.getElementById('drawer').addEventListener('click', e => {
    if (e.target.id === 'drawer') closeDrawer();
  });
}

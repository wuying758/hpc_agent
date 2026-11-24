// 工具函数
export function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
export function fmt(n) { if (n == null) return '—'; return n >= 10000 ? (n / 10000).toFixed(1) + 'w' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
export function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - (ts > 1e12 ? ts : ts * 1000);
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.round(diff / 60000) + '分钟前';
  if (diff < 86400000) return Math.round(diff / 3600000) + '小时前';
  if (diff < 604800000) return Math.round(diff / 86400000) + '天前';
  return new Date(ts > 1e12 ? ts : ts * 1000).toLocaleDateString('zh-CN');
}
export function statePill(state) {
  const cls = 'pill pill-' + (state || 'unknown').toLowerCase().replace(/[^a-z]/g, '_');
  return `<span class="${cls}">${esc(state || 'UNKNOWN')}</span>`;
}
export function renderMarkdown(md) {
  if (!md) return '';
  let h = esc(md);
  h = h.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  h = h.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  h = h.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^# (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^(- .+\n?)+/gm, m => '<ul>' + m.trim().split('\n').map(l => '<li>' + l.slice(2) + '</li>').join('') + '</ul>');
  h = h.replace(/^(\| .+ \|\n)(\|[-| ]+\|\n)((?:\| .+ \|\n?)+)/gm, (_, head, sep, body) => {
    const cols = head.split('|').filter(c => c.trim());
    const rows = body.trim().split('\n').map(r => r.split('|').filter(c => c.trim()));
    let t = '<div class="table-wrap"><table class="table"><thead><tr>';
    cols.forEach(c => t += `<th>${c.trim()}</th>`);
    t += '</tr></thead><tbody>';
    rows.forEach(r => { t += '<tr>'; r.forEach(c => t += `<td>${c.trim()}</td>`); t += '</tr>'; });
    t += '</tbody></table></div>';
    return t;
  });
  h = h.replace(/\n{2,}/g, '</p><p>');
  h = h.replace(/\n/g, '<br>');
  h = '<p>' + h + '</p>';
  h = h.replace(/\[E(\d+)\]/g, '<a class="evidence-ref" data-ev="$1">[E$1]</a>');
  return h;
}
export async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}
export function openDrawer(title, html) {
  document.getElementById('drawerTitle').textContent = title;
  document.getElementById('drawerBody').innerHTML = html;
  document.getElementById('drawer').hidden = false;
}
export function closeDrawer() { document.getElementById('drawer').hidden = true; }

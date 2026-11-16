// 前端：原生 ES module，无构建步骤。
// 所有数据都来自 /api/*；页面本身不持有"权威库存"，只在服务端返回后重绘。

const state = {
  bootstrap: null,
  tab: 'overview',
  scope: { whIds: [], skuIds: [], horizonDays: 21 },
  preview: null,
  previewError: null,
  previewLoading: false,
  selectedPlanId: null,
  plan: null,
  planError: null,
  compareRowsExpanded: false,
  showAllAllocs: true,
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const fmt = {
  n: (v, d = 0) => Number(v ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }),
  money: (v, d = 0) => `¥${Number(v ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d })}`,
  day: (v) => (v ? String(v).slice(5) : '—'),
  dt: (v) => (v ? String(v).replace('T', ' ').slice(0, 16) : '—'),
  pct: (v) => `${Math.round(Number(v ?? 0) * 100)}%`,
};

const actor = () => $('#planner')?.value || '林薇';

function toast(msg, bad = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 3600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method ?? 'GET',
    headers: { 'content-type': 'application/json', 'x-actor': encodeURIComponent(actor()) },
    body: options.body ? JSON.stringify({ ...options.body, actor: actor() }) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败 (${res.status})`);
    err.payload = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

const PLAN_STATUS = {
  draft: ['草稿', 'gray'],
  official: ['正式', 'blue'],
  completed: ['已完成', 'green'],
  revoked: ['已撤销', 'red'],
};
const ALLOC_STATUS = {
  planned: ['仅试算', 'gray'],
  reserved: ['已占用', 'blue'],
  executed: ['已执行', 'green'],
  returned: ['已撤销余量', 'amber'],
  lapsed: ['已失效', 'red'],
};
const SOURCE = {
  local: ['本仓出库', 'green'],
  transfer: ['仓间调拨', 'violet'],
  unmet: ['未满足', 'red'],
};
const REASON = {
  'central.local': '本地可用',
  'central.transfer': '全局最优调拨',
  'central.unmet': '全局择优放弃',
  'phased.local': '先到先得（本地）',
  'phased.transfer': '单张订单最便宜',
  'phased.unmet': '轮到时已无可用',
};

function badge(text, tone) { return `<span class="badge ${tone}">${esc(text)}</span>`; }
function sourceBadge(t) { const [label, tone] = SOURCE[t] ?? [t, 'gray']; return badge(label, tone); }
function planBadge(s) { const [label, tone] = PLAN_STATUS[s] ?? [s, 'gray']; return badge(label, tone); }
function allocBadge(s) { const [label, tone] = ALLOC_STATUS[s] ?? [s, 'gray']; return badge(label, tone); }

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
async function boot() {
  try {
    state.bootstrap = await api('/api/bootstrap');
  } catch (e) {
    $('#view').innerHTML = `<div class="alert error">无法加载数据：${esc(e.message)}</div>`;
    return;
  }
  const b = state.bootstrap;
  $('#todayChip').textContent = b.today;
  state.scope.horizonDays = state.scope.horizonDays ?? 21;
  if (!state.selectedPlanId && b.plans.length) state.selectedPlanId = b.plans[0].id;
  render();
}

async function refreshBootstrap() {
  state.bootstrap = await api('/api/bootstrap');
  $('#todayChip').textContent = state.bootstrap.today;
}

// ---------------------------------------------------------------------------
// 渲染调度
// ---------------------------------------------------------------------------
function render() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === state.tab);
  });
  const view = $('#view');
  if (!state.bootstrap) { view.innerHTML = '<div class="empty">正在载入…</div>'; return; }
  if (state.tab === 'overview') view.innerHTML = renderOverview();
  else if (state.tab === 'compare') view.innerHTML = renderCompare();
  else if (state.tab === 'plans') view.innerHTML = renderPlans();
  else if (state.tab === 'execute') view.innerHTML = renderExecute();
  else if (state.tab === 'recovery') view.innerHTML = renderRecovery();
  bindView();
}

function bindShell() {
  $('#tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    state.tab = t.dataset.tab;
    render();
  });

  $('#planner').addEventListener('change', () => {
    toast(`已切换为 ${actor()} 操作`);
    render();
  });

  $('#resetDemo').addEventListener('click', async () => {
    if (!confirm('重置会清空所有方案、占用与执行记录，恢复初始演示数据。继续？')) return;
    await api('/api/demo/reset', { method: 'POST', body: {} });
    state.selectedPlanId = null;
    state.plan = null;
    state.preview = null;
    await refreshBootstrap();
    render();
    toast('演示数据已重置');
  });
}

// 只有浏览器页面才启动；Node 下 import 本模块可做纯渲染测试。
if (typeof document !== 'undefined' && document.getElementById('tabs')) {
  bindShell();
}

// ---------------------------------------------------------------------------
// 概览
// ---------------------------------------------------------------------------
function renderOverview() {
  const b = state.bootstrap;
  const openOrders = b.ordersAll.filter((o) => o.status === 'open');
  const cancelledOrders = b.ordersAll.filter((o) => o.status !== 'open');
  const demand = openOrders.reduce((n, o) => n + Number(o.qty_open), 0);
  const shortagePlans = b.plans.filter((p) => p.status === 'official' || p.status === 'completed');
  const heldQty = b.reservations.reduce((n, r) => n + Number(r.held), 0);
  const lastEvents = b.events.slice(0, 8);
  return `
    <div class="kpis">
      <div class="kpi">
        <div class="label">未满足订单</div>
        <div class="value">${openOrders.length}<small>张</small></div>
        <div class="foot">共 ${fmt.n(demand)} 件待分配</div>
      </div>
      <div class="kpi">
        <div class="label">正式占用（未执行）</div>
        <div class="value">${fmt.n(heldQty)}<small>件</small></div>
        <div class="foot">${badge(`${b.reservations.length} 个库存/线路槽位`, 'blue')}</div>
      </div>
      <div class="kpi">
        <div class="label">方案总数</div>
        <div class="value">${b.plans.length}<small>个</small></div>
        <div class="foot">${shortagePlans.length} 个正式/已完成</div>
      </div>
      <div class="kpi">
        <div class="label">待处理恢复任务</div>
        <div class="value">${b.recovery.filter((t) => t.status === 'open').length}<small>条</small></div>
        <div class="foot ${b.recovery.some((t) => t.status === 'open') ? 'bad' : ''}">延误、取消、到货更正触发</div>
      </div>
    </div>

    <div class="grid-2">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>各仓在手与可承诺</h2>
            <p class="hint">可承诺 = 日终预测库存 − 安全库存 − 已被正式方案占用；预测含已确认到货。</p>
          </div>
        </div>
        ${renderStockTable(b)}
        <div class="legend">
          <span><i style="background:#1a7f5a"></i>本仓可用</span>
          <span><i style="background:#9a6200"></i>低于安全库存</span>
          <span><i style="background:#b42318"></i>已被占用/缺口</span>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>事件流</h2>
            <p class="hint">库存流水之外的事实变更：方案确认、订单取消、到货更正、运输延误。</p>
          </div>
        </div>
        <div class="timeline">
          ${lastEvents.map((e) => `
            <div class="tl-item ${eventTone(e.kind)}">
              <div class="when">${fmt.dt(e.at)} · ${esc(e.actor)}</div>
              <div class="what">${esc(e.summary)}</div>
              <div class="who">${esc(e.kind)}</div>
            </div>`).join('') || '<div class="empty">暂无事件</div>'}
        </div>
      </section>
    </div>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>未满足订单与缺货成本</h2>
          <p class="hint">缺货成本决定集中求解时的优先级：同样的货，优先补给断货代价更高的订单。取消订单会立即释放其未执行占用。</p>
        </div>
        <div class="row"><button class="small" data-goto="compare">去试算比较 →</button></div>
      </div>
      <div class="tbl-wrap">
        <table>
          <thead><tr>
            <th>订单</th><th>目的仓</th><th>SKU</th><th class="num">未满足量</th>
            <th>到期日</th><th class="num">缺货成本/件</th><th class="num">逾期罚款/件·天</th><th>说明</th><th></th>
          </tr></thead>
          <tbody>
            ${openOrders.map((o) => `
              <tr>
                <td class="mono">${esc(o.id)}</td>
                <td>${esc(o.wh_name)}</td>
                <td>${esc(o.sku_name)}</td>
                <td class="num">${fmt.n(o.qty_open)}</td>
                <td class="nowrap">${esc(o.due_at)}</td>
                <td class="num">${fmt.money(o.shortage_cost_per_unit)}</td>
                <td class="num">${fmt.money(o.late_penalty_per_unit_day)}</td>
                <td class="tiny muted">${esc(o.note ?? '')}</td>
                <td class="nowrap"><button class="small danger" data-cancel-order="${esc(o.id)}">取消</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${cancelledOrders.length ? `
        <details style="margin-top:12px">
          <summary class="tiny muted">已取消/已发运订单（${cancelledOrders.length}）</summary>
          <div class="tbl-wrap" style="margin-top:8px"><table>
            <thead><tr><th>订单</th><th>状态</th><th>未满足量</th><th>说明</th></tr></thead>
            <tbody>${cancelledOrders.map((o) => `
              <tr><td class="mono">${esc(o.id)}</td>
              <td>${o.status === 'cancelled' ? badge('已取消', 'red') : badge('已发运', 'green')}</td>
              <td class="num">${fmt.n(o.qty_open)}</td>
              <td class="tiny muted">${esc(o.note ?? '')}</td></tr>`).join('')}</tbody>
          </table></div>
        </details>` : ''}
    </section>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>在途与到货计划</h2>
          <p class="hint">在途只计入"已发出"的调拨；到货计划按预计日期进入库存预测，可更正、可登记到达。</p>
        </div>
      </div>
      <div class="grid-2">
        <div>
          <div class="tiny muted" style="margin-bottom:6px">在途调拨</div>
          ${renderTransfers(b.board.transfers)}
        </div>
        <div>
          <div class="tiny muted" style="margin-bottom:6px">计划到货</div>
          ${renderReceipts(b.board.receipts)}
        </div>
      </div>
    </section>
  `;
}

function eventTone(kind) {
  if (kind.includes('cancelled') || kind.includes('delayed')) return 'hot';
  if (kind.includes('committed') || kind.includes('created')) return 'plan';
  if (kind.includes('arrived') || kind.includes('executed') || kind.includes('resolved')) return 'ok';
  return '';
}

function renderStockTable(b) {
  const skus = b.skus;
  const whs = b.warehouses;
  const availByKey = new Map();
  for (const a of b.availability ?? []) {
    if (a.day !== b.today) continue;
    availByKey.set(`${a.wh_id}|${a.sku_id}`, a);
  }
  return `
    <div class="tbl-wrap">
      <table>
        <thead><tr>
          <th>仓库</th>${skus.map((s) => `<th class="num">${esc(s.name)}<br><span class="tiny muted">可承诺</span></th>`).join('')}
        </tr></thead>
        <tbody>
          ${whs.map((w) => `
            <tr>
              <td>${esc(w.name)}<div class="tiny muted">${esc(w.region)}</div></td>
              ${skus.map((s) => {
                const a = availByKey.get(`${w.id}|${s.id}`);
                if (!a) return '<td class="num muted">—</td>';
                const tone = a.qty <= 0 ? 'bad' : a.qty < a.safety ? 'bad' : 'good';
                const pct = a.gross > 0 ? Math.max(0, Math.min(1, a.qty / Math.max(a.gross, 1))) : 0;
                return `<td class="num">
                  <div style="font-weight:600">${fmt.n(a.qty)}</div>
                  <div class="tiny muted">在手 ${fmt.n(a.gross)} · 占用 ${fmt.n(a.reserved)}</div>
                  <div class="bar-mini ${tone === 'bad' ? 'bad' : ''}" style="margin-top:4px"><i style="width:${Math.round(pct * 100)}%"></i></div>
                </td>`;
              }).join('')}
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderTransfers(list) {
  if (!list?.length) return '<div class="empty">暂无在途</div>';
  return `<div class="tbl-wrap"><table>
    <thead><tr><th>单号</th><th>线路</th><th class="num">数量</th><th>ETA</th><th></th></tr></thead>
    <tbody>${list.map((t) => `
      <tr>
        <td class="mono">${esc(t.id)}</td>
        <td class="tiny">${esc(t.from_name)} → ${esc(t.to_name)}</td>
        <td class="num">${fmt.n(t.qty - t.qty_arrived)}<span class="tiny muted"> 待达 / 共 ${fmt.n(t.qty)}</span></td>
        <td class="nowrap">${fmt.day(t.eta_at)} ${t.delay_days > 0 ? badge(`延误 ${t.delay_days} 天`, 'red') : ''}</td>
        <td class="nowrap">
          ${t.status !== 'arrived' ? `<button class="small" data-arrive="${esc(t.id)}">登记到达</button>
          <button class="small" data-delay="${esc(t.id)}">登记延误</button>` : badge('已到达', 'green')}
        </td>
      </tr>`).join('')}</tbody>
  </table></div>`;
}

function renderReceipts(list) {
  if (!list?.length) return '<div class="empty">暂无计划到货</div>';
  return `<div class="tbl-wrap"><table>
    <thead><tr><th>到货单</th><th>仓库</th><th class="num">数量</th><th>ETA</th><th></th></tr></thead>
    <tbody>${list.map((r) => `
      <tr>
        <td class="mono">${esc(r.id)}</td>
        <td class="tiny">${esc(r.wh_id)} · ${esc(r.sku_id)}</td>
        <td class="num">${fmt.n(r.qty)} ${r.qty !== r.original_qty ? `<span class="tiny muted">原 ${fmt.n(r.original_qty)}</span>` : ''}</td>
        <td class="nowrap">${fmt.day(r.eta_at)} ${r.revision > 0 ? badge(`已更正 ${r.revision} 次`, 'amber') : ''}</td>
        <td class="nowrap">
          <button class="small" data-correct="${esc(r.id)}">更正</button>
          <button class="small" data-receipt-arrive="${esc(r.id)}">登记到达</button>
        </td>
      </tr>`).join('')}</tbody>
  </table></div>`;
}

// ---------------------------------------------------------------------------
// 试算比较
// ---------------------------------------------------------------------------
function renderCompare() {
  const b = state.bootstrap;
  const p = state.preview;
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>试算范围</h2>
          <p class="hint">试算只读：不会写入任何库存流水，也不会占用正式库存。可以同时比较"集中求解"和"分阶段分配"。</p>
        </div>
      </div>
      <div class="scope-bar">
        <label class="tiny muted">仓库</label>
        <select id="scopeWh">
          <option value="">全部仓库</option>
          ${b.warehouses.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}
        </select>
        <label class="tiny muted">SKU</label>
        <select id="scopeSku">
          <option value="">全部 SKU</option>
          ${b.skus.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
        </select>
        <label class="tiny muted">规划天数</label>
        <input id="scopeHorizon" type="number" min="3" max="60" value="${state.scope.horizonDays}" style="width:78px">
        <button class="primary" id="runPreview">${state.previewLoading ? '计算中…' : '运行试算'}</button>
        ${p ? `<span class="tiny muted">数据版本 ${p.central.factsVersion} · 依据指纹 ${esc(p.central.factsHash)}</span>` : ''}
      </div>
      ${state.previewError ? `<div class="alert error">${esc(state.previewError)}</div>` : ''}
    </section>

    ${p ? renderCompareResult(p) : `
      <section class="panel"><div class="empty">
        点"运行试算"生成两套方案。演示数据里，武汉 K7 库存同时被上海补货和武汉急单需要，正好用来观察两种口径的取舍。
      </div></section>`}
  `;
}

function renderCompareResult(p) {
  const a = p.central;
  const b = p.phased;
  const cmp = p.comparison;
  const maxCost = Math.max(a.metrics.cost.total, b.metrics.cost.total, 1);
  return `
    <div class="metric-cards" style="margin-bottom:16px">
      ${metricCard('A · 集中求解', '全部订单一起算，稀缺库存流向"减少总成本最多"的订单。', a, 'a', maxCost, maxCost === a.metrics.cost.total)}
      ${metricCard('B · 分阶段分配', '按到期日逐单挑自己最便宜的来源，先到先得。', b, 'b', maxCost, maxCost === b.metrics.cost.total)}
    </div>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>为什么局部便宜反而更贵</h2>
          <p class="hint">"便宜"只看单张订单的运费和操作费；"贵"来自被挤掉的高缺货成本订单。</p>
        </div>
      </div>
      <div class="narrative">
        ${cmp.narrative.map((line) => `<p>${highlight(line)}</p>`).join('')}
      </div>
      <div class="grid-2" style="margin-top:14px">
        <div>
          <div class="tiny muted" style="margin-bottom:6px">成本构成对比</div>
          <div class="tbl-wrap"><table class="metric-compare">
            <thead><tr><th>成本项</th><th class="num">A 集中</th><th class="num">B 分阶段</th><th class="num">差额 (B−A)</th></tr></thead>
            <tbody>
              ${compareRow('运费（含固定运费）', a.metrics.cost.freight, b.metrics.cost.freight)}
              ${compareRow('仓储操作费', a.metrics.cost.handling, b.metrics.cost.handling)}
              ${compareRow('逾期罚款', a.metrics.cost.late, b.metrics.cost.late)}
              ${compareRow('缺货成本', a.metrics.cost.shortage, b.metrics.cost.shortage)}
              ${compareRow('总成本', a.metrics.cost.total, b.metrics.cost.total, true)}
              ${compareRow('缺货量（件）', a.metrics.shortageQty, b.metrics.shortageQty, false, true)}
              ${compareRow('完全满足订单数', a.metrics.fullyMetOrders, b.metrics.fullyMetOrders, false, true)}
            </tbody>
          </table></div>
        </div>
        <div>
          <div class="tiny muted" style="margin-bottom:6px">逐订单影响（点击展开全部）</div>
          <div class="tbl-wrap"><table>
            <thead><tr><th>订单</th><th class="num">A 缺口</th><th class="num">B 缺口</th><th class="num">成本差</th></tr></thead>
            <tbody>
              ${cmp.rows.slice(0, state.compareRowsExpanded ? cmp.rows.length : 5).map((r) => `
                <tr title="${esc(r.note)}">
                  <td class="mono">${esc(r.demandId)}<div class="tiny muted">${esc(r.whId)} · 到期 ${fmt.day(r.dueAt)}</div></td>
                  <td class="num">${r.shortageA || '—'}</td>
                  <td class="num ${r.shortageB > r.shortageA ? 'tiny' : ''}" style="${r.shortageB > r.shortageA ? 'color:var(--bad);font-weight:600' : ''}">${r.shortageB || '—'}</td>
                  <td class="num" style="color:${r.delta > 0 ? 'var(--bad)' : 'var(--good)'}">${r.delta > 0 ? '+' : ''}${fmt.n(r.delta)}</td>
                </tr>`).join('')}
            </tbody>
          </table></div>
          ${cmp.rows.length > 5 ? `<button class="ghost small" id="toggleRows">${state.compareRowsExpanded ? '收起' : `展开全部 ${cmp.rows.length} 张`}</button>` : ''}
          <div class="legend">
            <span>${badge('缺口 B 更高 = 在分阶段方案里被挤掉', 'red')}</span>
          </div>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>逐条分配对比</h2>
          <p class="hint">每一行都带来源、发运/到达日、成本拆解和未满足原因。试算结果不写数据库。</p>
        </div>
        <div class="seg" id="allocToggle">
          <button data-alloc="central" class="on">A 集中</button>
          <button data-alloc="phased">B 分阶段</button>
        </div>
      </div>
      <div id="allocBody">${renderAllocTable(a.allocations, a.metrics)}</div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>保存为方案</h2>
          <p class="hint">保存只是草稿，不占库存；"转正式"时才重新核对依据并占用。多个计划员可以同时保存，先后确认。</p>
        </div>
      </div>
      <div class="row">
        <input id="planName" type="text" placeholder="方案名称，例如：11-16 华中急单优先" style="width:300px" value="${esc(defaultPlanName())}">
        <button class="primary" data-save-plan="central">保存 A 集中方案</button>
        <button data-save-plan="phased">保存 B 分阶段方案</button>
        <span class="tiny muted">以 ${esc(actor())} 身份保存</span>
      </div>
    </section>
  `;
}

function defaultPlanName() {
  const d = state.bootstrap?.today ?? '';
  return `${d} 转运方案`;
}

function metricCard(title, tagline, result, cls, maxCost, isMax) {
  const cost = result.metrics.cost;
  const bar = (label, value, key) => `
    <div class="cost-bar">
      <span class="muted">${label}</span>
      <span class="track"><span class="fill ${key}" style="width:${Math.round((value / Math.max(cost.total, 1)) * 100)}%"></span></span>
      <span class="val">${fmt.n(value)}</span>
    </div>`;
  return `
    <div class="metric-card ${cls}">
      <h3>${esc(title)}</h3>
      <div class="tagline">${esc(tagline)}</div>
      <div class="big">${fmt.money(cost.total)}<small>总成本</small></div>
      <div class="cost-bars">
        ${bar('运费', cost.freight, 'freight')}
        ${bar('操作费', cost.handling, 'handling')}
        ${bar('逾期', cost.late, 'late')}
        ${bar('缺货', cost.shortage, 'shortage')}
      </div>
      <dl>
        <dt>缺货量</dt><dd>${fmt.n(result.metrics.shortageQty)} 件</dd>
        <dt>调拨量</dt><dd>${fmt.n(result.metrics.transferredQty)} 件</dd>
        <dt>本地出库</dt><dd>${fmt.n(result.metrics.localQty)} 件</dd>
        <dt>完全满足订单</dt><dd>${result.metrics.fullyMetOrders}/${result.metrics.orders}</dd>
        <dt>履约率</dt><dd>${fmt.pct(result.metrics.fillRate)}</dd>
      </dl>
      <div style="margin-top:8px" class="tiny muted">成本刻度：以两者中较高者为 100%，本方案占 ${Math.round((cost.total / Math.max(maxCost, 1)) * 100)}%${isMax ? '（较高）' : ''}</div>
    </div>`;
}

function compareRow(label, av, bv, total = false, lowerIsBetter = true) {
  const delta = Number(bv) - Number(av);
  const good = lowerIsBetter ? delta < 0 : delta > 0;
  const tone = Math.abs(delta) < 0.005 ? 'muted' : good ? 'neg' : 'pos';
  const cell = lowerIsBetter ? fmt.n(av) : fmt.n(av);
  return `<tr class="${total ? 'total' : ''}">
    <td>${esc(label)}</td>
    <td class="num">${cell}</td>
    <td class="num">${fmt.n(bv)}</td>
    <td class="num ${tone}">${delta > 0 ? '+' : ''}${fmt.n(delta)}</td>
  </tr>`;
}

function highlight(text) {
  return esc(text)
    .replace(/(¥[\d,.]+|\d+(?:\.\d+)?\s*元|\d+\s*件|SO-\d+)/g, '<strong>$1</strong>');
}

function renderAllocTable(allocations, metrics) {
  const byOrder = new Map();
  for (const a of allocations) {
    const list = byOrder.get(a.demand_id) ?? [];
    list.push(a);
    byOrder.set(a.demand_id, list);
  }
  const rows = [];
  for (const [orderId, list] of byOrder) {
    const total = list.reduce((n, a) => n + a.qty, 0);
    const order = list[0];
    rows.push(`<tr style="background:#fafbfc">
      <td class="mono" colspan="2"><b>${esc(orderId)}</b>
        <span class="tiny muted">${esc(order.wh_id)} · ${esc(order.sku_id)} · 到期 ${esc(order.due_at)} · 本方案分配 ${fmt.n(total)} 件</span></td>
      <td colspan="9"></td>
    </tr>`);
    for (const a of list) {
      const st = ALLOC_STATUS[a.status] ?? [a.status, 'gray'];
      const shipped = a.executed_qty > 0 ? `已执行 ${fmt.n(a.executed_qty)} / 剩余 ${fmt.n(a.qty - a.executed_qty - a.returned_qty)}` : '';
      rows.push(`<tr>
        <td>${sourceBadge(a.source_type)}</td>
        <td class="mono tiny">${a.from_wh ? esc(a.from_wh) : '<span class="muted">—</span>'}
          ${a.lane_id ? `<div class="tiny muted">${esc(a.lane_id)}</div>` : ''}</td>
        <td class="num">${fmt.n(a.qty)}</td>
        <td class="nowrap tiny" title="${esc(a.depart_date ?? '')} → ${esc(a.arrival_date ?? '')}">${fmt.day(a.depart_date)} → ${fmt.day(a.arrival_date)}</td>
        <td class="num">${a.late_days > 0 ? badge(`晚 ${a.late_days} 天`, 'amber') : '<span class="muted">—</span>'}</td>
        <td class="num">${fmt.n(a.fixed_cost + a.freight_cost)}</td>
        <td class="num">${fmt.n(a.handling_cost)}</td>
        <td class="num">${a.late_penalty ? fmt.n(a.late_penalty) : '<span class="muted">—</span>'}</td>
        <td class="num">${a.shortage_cost ? `<span style="color:var(--bad)">${fmt.n(a.shortage_cost)}</span>` : '<span class="muted">—</span>'}</td>
        <td class="num"><b>${fmt.n(a.total_cost)}</b></td>
        <td class="why">
          <details><summary>${esc(REASON[a.reason_code] ?? a.reason_code)}</summary>
            <div class="why-body">${esc(a.why)}</div>
          </details>
          ${shipped ? `<div class="tiny muted">${esc(shipped)}</div>` : ''}
        </td>
      </tr>`);
    }
  }
  return `<div class="tbl-wrap"><table class="alloc-table">
    <thead><tr>
      <th>来源</th><th>调出仓/线路</th><th class="num">数量</th><th>发运 → 到达</th>
      <th class="num">逾期</th><th class="num">运费</th><th class="num">操作费</th>
      <th class="num">逾期罚款</th><th class="num">缺货成本</th><th class="num">合计</th><th>原因</th>
    </tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table></div>`;
}

// ---------------------------------------------------------------------------
// 方案与占用
// ---------------------------------------------------------------------------
function renderPlans() {
  const b = state.bootstrap;
  const plans = b.plans;
  const plan = state.plan;
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>方案列表</h2>
          <p class="hint">草稿不占库存。转正式时需要重新核对依据（库存、订单、到货是否变化），并通过占用核对。</p>
        </div>
      </div>
      ${plans.length ? `<div class="plan-list">${plans.map((p) => renderPlanCard(p)).join('')}</div>` : '<div class="empty">还没有方案，去"试算比较"保存一个。</div>'}
    </section>

    ${plan ? renderPlanDetail(plan) : ''}
  `;
}

function renderPlanCard(p) {
  const selected = p.id === state.selectedPlanId;
  const stale = p.stale_reason;
  return `
    <div class="plan-card ${selected ? 'selected' : ''}" data-plan="${esc(p.id)}">
      <div>
        <div class="name">${esc(p.name)} ${planBadge(p.status)} ${p.objective === 'central' ? badge('集中求解', 'blue') : badge('分阶段分配', 'violet')}
          ${stale ? badge('依据已变', 'amber') : ''}</div>
        <div class="meta">${esc(p.id)} · 创建人 ${esc(p.created_by)} · ${fmt.dt(p.created_at)}
          ${p.committed_by ? ` · 确认人 ${esc(p.committed_by)}` : ''}</div>
        <div class="nums" style="margin-top:6px">
          <span>总成本 <b>${fmt.money(p.metrics.cost?.total)}</b></span>
          <span>缺货 <b>${fmt.n(p.metrics.shortageQty)}</b> 件</span>
          <span>调拨 <b>${fmt.n(p.metrics.transferredQty)}</b> 件</span>
          <span>分配行 <b>${p.alloc_count}</b></span>
          <span>锁版本 <b>v${p.row_version}</b></span>
        </div>
      </div>
      <div class="row">
        <button class="small" data-open-plan="${esc(p.id)}">查看</button>
      </div>
    </div>`;
}

function renderPlanDetail(plan) {
  const canCommit = plan.status === 'draft';
  const canRevoke = plan.status === 'official';
  const canRefresh = plan.status === 'draft';
  const heldRes = plan.reservations.filter((r) => r.state === 'held');
  const executedRes = plan.reservations.filter((r) => Number(r.executed_qty) > 0);
  return `
    <section class="panel" id="planDetail">
      <div class="panel-head">
        <div>
          <h2>${esc(plan.name)} ${planBadge(plan.status)}</h2>
          <p class="hint">范围：${plan.scope.whIds?.length ? plan.scope.whIds.join('、') : '全部仓库'} ·
            ${plan.scope.skuIds?.length ? plan.scope.skuIds.join('、') : '全部 SKU'} ·
            锁定数据版本 v${plan.facts_version} · 行版本 v${plan.row_version}</p>
        </div>
      </div>
      ${plan.stale_reason ? `<div class="alert warn"><b>依据已变化：</b>${esc(parseStale(plan.stale_reason))}<br>
        转正式会被拒绝，需要先"刷新方案"按最新事实重算。</div>` : ''}
      ${state.planError ? renderPlanError(state.planError) : ''}

      <div class="row" style="margin-bottom:14px">
        ${canCommit ? `<button class="primary" data-commit="${esc(plan.id)}">转正式并占用</button>` : ''}
        ${canRefresh ? `<button data-refresh="${esc(plan.id)}">刷新方案（按最新事实重算）</button>` : ''}
        ${canRevoke ? `<button class="danger" data-revoke="${esc(plan.id)}">撤销方案并释放占用</button>` : ''}
        <span class="tiny muted">操作人：${esc(actor())}</span>
      </div>

      <div class="kpis">
        <div class="kpi"><div class="label">总成本</div><div class="value">${fmt.money(plan.metrics.cost?.total)}</div><div class="foot">缺货 ${fmt.money(plan.metrics.cost?.shortage)} / 逾期 ${fmt.money(plan.metrics.cost?.late)}</div></div>
        <div class="kpi"><div class="label">缺货量</div><div class="value">${fmt.n(plan.metrics.shortageQty)}<small>件</small></div><div class="foot ${plan.metrics.shortageQty > 0 ? 'bad' : 'good'}">履约率 ${fmt.pct(plan.metrics.fillRate)}</div></div>
        <div class="kpi"><div class="label">占用槽位</div><div class="value">${heldRes.length}<small>个未执行</small></div><div class="foot">${executedRes.length} 个已部分执行</div></div>
        <div class="kpi"><div class="label">状态</div><div class="value" style="font-size:17px">${planBadge(plan.status)}</div><div class="foot">${plan.committed_at ? `确认于 ${fmt.dt(plan.committed_at)}` : '尚未确认'}</div></div>
      </div>

      <h3 class="tiny muted" style="margin:16px 0 6px">分配明细</h3>
      ${renderPlanAllocations(plan)}

      <h3 class="tiny muted" style="margin:18px 0 6px">占用记录（正式方案才有时）</h3>
      ${plan.reservations.length ? `
        <div class="tbl-wrap"><table>
          <thead><tr><th>类型</th><th>仓库</th><th>SKU</th><th>日期</th><th class="num">占用量</th><th class="num">已执行</th><th class="num">已释放</th><th>状态</th><th>订单</th></tr></thead>
          <tbody>${plan.reservations.map((r) => `
            <tr>
              <td>${r.kind === 'stock' ? badge('库存', 'green') : r.kind === 'lane' ? badge('线路运力', 'violet') : badge('需求承诺', 'blue')}</td>
              <td class="tiny">${esc(r.wh_id)}</td><td class="tiny">${esc(r.sku_id)}</td>
              <td class="nowrap">${esc(r.date)}</td>
              <td class="num">${fmt.n(r.qty)}</td>
              <td class="num">${fmt.n(r.executed_qty)}</td>
              <td class="num">${fmt.n(r.released_qty)}</td>
              <td>${resBadge(r.state)}</td>
              <td class="mono tiny">${esc(r.demand_id ?? '')}</td>
            </tr>`).join('')}</tbody>
        </table></div>` : '<div class="empty">草案不产生占用。</div>'}

      <h3 class="tiny muted" style="margin:18px 0 6px">方案事件</h3>
      <div class="timeline">
        ${plan.events.map((e) => `
          <div class="tl-item ${eventTone(e.kind)}">
            <div class="when">${fmt.dt(e.at)} · ${esc(e.actor)}</div>
            <div class="what">${esc(e.kind)}${eventSummary(e)}</div>
          </div>`).join('') || '<div class="empty">暂无事件</div>'}
      </div>
    </section>`;
}

function resBadge(s) {
  const map = {
    held: ['占用中', 'blue'], executed: ['已执行', 'green'],
    released: ['已释放', 'amber'], lapsed: ['已失效', 'red'],
  };
  const [label, tone] = map[s] ?? [s, 'gray'];
  return badge(label, tone);
}

function parseStale(text) {
  try {
    const d = JSON.parse(text);
    const items = (d.drift?.items ?? []).map((x) => `${x.wh_id}/${x.sku_id}`);
    const conflicts = d.conflicts ?? [];
    const parts = [];
    if (items.length) parts.push(`库存/订单变化：${items.join('、')}`);
    if (conflicts.length) parts.push(`与已有正式方案冲突 ${conflicts.length} 处：${conflicts[0].message}`);
    return parts.join('；') || text;
  } catch {
    return text;
  }
}

function eventSummary(e) {
  const d = e.detail ?? {};
  if (e.kind === 'committed') return ` · 占用 ${d.slots ?? 0} 个槽位`;
  if (e.kind === 'executed') return ` · 分配 #${d.allocId} ${d.qty} 件`;
  if (e.kind === 'returned') return ` · 撤销 ${d.qty} 件（${d.reason ?? '无说明'}）`;
  if (e.kind === 'commit_rejected') return ` · 被拒绝：${d.reason === 'stale' ? '依据过期' : '占用冲突'}`;
  if (e.kind === 'transfer_delayed') return ` · 到达 ${d.eta}，晚 ${d.lateDays} 天`;
  return '';
}

function renderPlanAllocations(plan) {
  const showAll = state.showAllAllocs;
  const list = showAll ? plan.allocations : plan.allocations.filter((a) => a.status !== 'unmet');
  if (!list.length) return '<div class="empty">没有可执行分配行（可能全部未满足或已失效）。</div>';
  return `<div class="tbl-wrap"><table class="alloc-table">
    <thead><tr>
      <th>订单</th><th>来源</th><th>调出仓</th><th class="num">数量</th><th>发运 → 到达</th>
      <th class="num">合计成本</th><th>状态</th><th>执行进度</th><th>说明</th><th></th>
    </tr></thead>
    <tbody>
      ${list.map((a) => {
        const remaining = a.committed_qty - a.executed_qty - a.returned_qty;
        const execPct = a.committed_qty > 0 ? Math.round((a.executed_qty / a.committed_qty) * 100) : 0;
        return `<tr>
          <td class="mono">${esc(a.demand_id)}<div class="tiny muted">到期 ${fmt.day(a.due_at)}</div></td>
          <td>${sourceBadge(a.source_type)}</td>
          <td class="tiny">${esc(a.from_wh ?? '—')}${a.lane_id ? `<div class="tiny muted">${esc(a.lane_id)}</div>` : ''}</td>
          <td class="num">${fmt.n(a.qty)}</td>
          <td class="tiny nowrap">${fmt.day(a.depart_date)} → ${fmt.day(a.arrival_date)}</td>
          <td class="num">${fmt.n(a.total_cost)}</td>
          <td>${allocBadge(a.status)}</td>
          <td>
            <div class="bar-mini" style="width:74px"><i style="width:${execPct}%"></i></div>
            <div class="tiny muted">${fmt.n(a.executed_qty)} / ${fmt.n(a.committed_qty || a.qty)}${a.returned_qty ? ` · 撤 ${fmt.n(a.returned_qty)}` : ''}</div>
          </td>
          <td class="why"><details><summary>${esc(REASON[a.reason_code] ?? a.reason_code)}</summary><div class="why-body">${esc(a.why)}</div></details></td>
          <td class="nowrap">
            ${plan.status === 'official' && a.source_type !== 'unmet' && remaining > 0.001 ? `
              <button class="small primary" data-exec="${a.id}" data-remain="${remaining}" data-demand="${esc(a.demand_id)}">执行</button>
              <button class="small" data-return="${a.id}" data-remain="${remaining}">撤销余量</button>` : ''}
          </td>
        </tr>`;
      }).join('')}
    </tbody>
  </table></div>
  <div class="row" style="margin-top:8px">
    <button class="ghost small" id="toggleAllocs">${showAll ? '隐藏未满足行' : '显示未满足行（缺货原因）'}</button>
  </div>`;
}

function renderPlanError(err) {
  if (!err) return '';
  const d = err.payload?.detail;
  if (!d) return `<div class="alert error">${esc(err.message)}</div>`;
  if (d.conflicts?.length) {
    return `<div class="alert error"><b>${esc(err.message)}</b>
      <ul>${d.conflicts.map((c) => `<li>${esc(c.message)}</li>`).join('')}</ul>
      <div class="tiny" style="margin-top:6px">处理办法：撤销或完成冲突方案；或刷新本方案，按剩余资源重算。</div>
    </div>`;
  }
  if (d.drift) {
    const items = d.drift.items ?? [];
    return `<div class="alert warn"><b>${esc(err.message)}</b>
      <ul>${items.slice(0, 6).map((x) => `<li>${esc(x.wh_id)} / ${esc(x.sku_id)} 的可用量已变化</li>`).join('')}</ul>
      ${d.conflicts?.length ? `<div class="tiny">另有 ${d.conflicts.length} 处占用冲突。</div>` : ''}
    </div>`;
  }
  return `<div class="alert error">${esc(err.message)}</div>`;
}

// ---------------------------------------------------------------------------
// 执行与回放
// ---------------------------------------------------------------------------
function renderExecute() {
  const b = state.bootstrap;
  const official = b.plans.filter((p) => ['official', 'completed', 'revoked'].includes(p.status));
  const recent = b.events.filter((e) => /execut|arriv|cancel|delay|receipt|return/.test(e.kind)).slice(0, 14);
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>执行与回放</h2>
          <p class="hint">执行会写入库存流水；"撤销余量"只释放未执行部分，已执行部分不回滚。</p>
        </div>
      </div>
      ${official.length ? official.map((p) => `
        <div class="plan-card" style="margin-bottom:10px">
          <div>
            <div class="name">${esc(p.name)} ${planBadge(p.status)}</div>
            <div class="meta">${esc(p.id)} · 确认人 ${esc(p.committed_by ?? '—')} · ${fmt.dt(p.committed_at)}</div>
            <div class="nums" style="margin-top:6px">
              <span>分配行 <b>${fmt.n(p.alloc_count ?? 0)}</b></span>
              <span>缺货 <b>${fmt.n(p.metrics?.shortageQty)}</b> 件</span>
            </div>
          </div>
          <button class="small" data-open-plan="${esc(p.id)}">打开执行</button>
        </div>`).join('') : '<div class="empty">还没有正式方案。先在"方案与占用"里把草稿转正式。</div>'}
      <div class="row" style="margin-top:8px">
        <span class="tiny muted">取消订单 / 更正到货可在"概览"的事件流下方操作。</span>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>操作回放</h2>
          <p class="hint">按时间倒序的实际动作，用于复盘"谁在什么时候占了什么、执行了多少"。</p>
        </div>
      </div>
      ${renderReplay(b)}
    </section>
  `;
}

function renderReplay(b) {
  const events = b.events;
  if (!events.length) return '<div class="empty">暂无操作记录</div>';
  return `<div class="timeline">
    ${events.slice(0, 30).map((e) => `
      <div class="tl-item ${eventTone(e.kind)}">
        <div class="when">${fmt.dt(e.at)} · ${esc(e.actor)} · <code class="k">${esc(e.kind)}</code></div>
        <div class="what">${esc(e.summary)}</div>
      </div>`).join('')}
  </div>`;
}

// ---------------------------------------------------------------------------
// 恢复任务
// ---------------------------------------------------------------------------
function renderRecovery() {
  const tasks = state.bootstrap.recovery;
  const open = tasks.filter((t) => t.status === 'open');
  const done = tasks.filter((t) => t.status !== 'open');
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>恢复任务（${open.length} 条待处理）</h2>
          <p class="hint">订单取消、到货更正、运输延误会生成任务。可以从任务生成恢复方案草稿，或人工确认无需处理。</p>
        </div>
      </div>
      ${open.length ? open.map((t) => `
        <div class="plan-card" style="margin-bottom:10px">
          <div>
            <div class="name">${badge(t.kind === 'reallocate' ? '重新分配' : t.kind === 'review' ? '复核方案' : '补货', t.priority === 1 ? 'red' : 'amber')} ${esc(t.title)}</div>
            <div class="meta">${esc(t.id)} · ${fmt.dt(t.created_at)}${t.demand_id ? ` · 订单 ${esc(t.demand_id)}` : ''}</div>
            <div class="tiny" style="margin-top:4px">${esc(t.detail)}</div>
          </div>
          <div class="row">
            <button class="small primary" data-recover="${esc(t.id)}">生成恢复方案</button>
            <button class="small" data-dismiss="${esc(t.id)}">无需处理</button>
          </div>
        </div>`).join('') : '<div class="empty">没有待处理的恢复任务。</div>'}
    </section>

    ${done.length ? `<section class="panel">
      <div class="panel-head"><div><h2>已处理</h2><p class="hint">保留处理方式，便于回放。</p></div></div>
      <div class="tbl-wrap"><table>
        <thead><tr><th>任务</th><th>类型</th><th>处理人</th><th>处理结果</th><th>时间</th></tr></thead>
        <tbody>${done.map((t) => `<tr>
          <td>${esc(t.title)}</td>
          <td>${esc(t.kind)}</td>
          <td>${esc(t.resolved_by ?? '—')}</td>
          <td>${esc(t.resolution ?? '—')}</td>
          <td class="nowrap tiny">${fmt.dt(t.resolved_at)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </section>` : ''}
  `;
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------
function bindView() {
  document.querySelectorAll('[data-goto]').forEach((el) => {
    el.addEventListener('click', () => { state.tab = el.dataset.goto; render(); });
  });

  const runPreview = $('#runPreview');
  if (runPreview) runPreview.addEventListener('click', doPreview);

  const saveCentral = document.querySelector('[data-save-plan="central"]');
  if (saveCentral) saveCentral.addEventListener('click', () => savePlan('central'));
  const savePhased = document.querySelector('[data-save-plan="phased"]');
  if (savePhased) savePhased.addEventListener('click', () => savePlan('phased'));

  const toggleRows = $('#toggleRows');
  if (toggleRows) toggleRows.addEventListener('click', () => { state.compareRowsExpanded = !state.compareRowsExpanded; render(); });

  const allocToggle = $('#allocToggle');
  if (allocToggle) {
    allocToggle.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-alloc]');
      if (!btn || !state.preview) return;
      allocToggle.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
      const result = state.preview[btn.dataset.alloc];
      $('#allocBody').innerHTML = renderAllocTable(result.allocations, result.metrics);
    });
  }

  document.querySelectorAll('[data-open-plan]').forEach((el) => {
    el.addEventListener('click', () => openPlan(el.dataset.openPlan));
  });
  document.querySelectorAll('[data-plan]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      openPlan(el.dataset.plan);
    });
  });
  document.querySelectorAll('[data-commit]').forEach((el) => {
    el.addEventListener('click', () => commitPlan(el.dataset.commit, el));
  });
  document.querySelectorAll('[data-refresh]').forEach((el) => {
    el.addEventListener('click', () => refreshPlan(el.dataset.refresh));
  });
  document.querySelectorAll('[data-revoke]').forEach((el) => {
    el.addEventListener('click', () => revokePlan(el.dataset.revoke));
  });
  document.querySelectorAll('[data-exec]').forEach((el) => {
    el.addEventListener('click', () => openExecuteMany(el.dataset.exec, Number(el.dataset.remain), el.dataset.demand));
  });
  document.querySelectorAll('[data-return]').forEach((el) => {
    el.addEventListener('click', () => openReturn(el.dataset.return, Number(el.dataset.remain)));
  });
  const toggleAllocs = $('#toggleAllocs');
  if (toggleAllocs) toggleAllocs.addEventListener('click', () => { state.showAllAllocs = !state.showAllAllocs; render(); });

  document.querySelectorAll('[data-arrive]').forEach((el) => {
    el.addEventListener('click', () => openTransferArrive(el.dataset.arrive));
  });
  document.querySelectorAll('[data-delay]').forEach((el) => {
    el.addEventListener('click', () => openTransferDelay(el.dataset.delay));
  });
  document.querySelectorAll('[data-correct]').forEach((el) => {
    el.addEventListener('click', () => openReceiptCorrect(el.dataset.correct));
  });
  document.querySelectorAll('[data-receipt-arrive]').forEach((el) => {
    el.addEventListener('click', () => openReceiptArrive(el.dataset.receiptArrive));
  });
  document.querySelectorAll('[data-recover]').forEach((el) => {
    el.addEventListener('click', () => recoverTask(el.dataset.recover, 'central', el));
  });
  document.querySelectorAll('[data-dismiss]').forEach((el) => {
    el.addEventListener('click', () => dismissTask(el.dataset.dismiss));
  });
  // 概览页的订单取消
  document.querySelectorAll('[data-cancel-order]').forEach((el) => {
    el.addEventListener('click', () => openCancelOrder(el.dataset.cancelOrder));
  });
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------
async function doPreview() {
  state.scope.whIds = $('#scopeWh')?.value ? [$('#scopeWh').value] : [];
  state.scope.skuIds = $('#scopeSku')?.value ? [$('#scopeSku').value] : [];
  state.scope.horizonDays = Number($('#scopeHorizon')?.value ?? 21);
  state.previewLoading = true;
  state.previewError = null;
  render();
  try {
    state.preview = await api('/api/plans/preview', {
      method: 'POST',
      body: { scope: state.scope },
    });
  } catch (e) {
    state.preview = null;
    state.previewError = e.message;
  } finally {
    state.previewLoading = false;
    render();
  }
}

async function savePlan(objective) {
  const name = $('#planName')?.value?.trim();
  if (!name) { toast('请填写方案名称', true); return; }
  try {
    const out = await api('/api/plans', {
      method: 'POST',
      body: { name: `${name} · ${objective === 'central' ? '集中' : '分阶段'}`, objective, scope: state.scope },
    });
    state.selectedPlanId = out.plan.id;
    state.plan = out.plan;
    await refreshBootstrap();
    state.tab = 'plans';
    render();
    toast(`已保存草稿 ${out.plan.id}（不占库存）`);
  } catch (e) {
    toast(e.message, true);
  }
}

async function openPlan(id) {
  state.selectedPlanId = id;
  state.planError = null;
  try {
    const out = await api(`/api/plans/${encodeURIComponent(id)}`);
    state.plan = out.plan;
  } catch (e) {
    toast(e.message, true);
    return;
  }
  if (state.tab !== 'plans' && state.tab !== 'execute') state.tab = 'plans';
  render();
}

async function commitPlan(id, btn) {
  btn.disabled = true;
  state.planError = null;
  try {
    const out = await api(`/api/plans/${encodeURIComponent(id)}/commit`, {
      method: 'POST',
      body: { rowVersion: state.plan?.row_version },
    });
    state.plan = out.plan;
    await refreshBootstrap();
    render();
    toast('已转正式并锁定占用');
  } catch (e) {
    state.planError = e;
    try { const out = await api(`/api/plans/${encodeURIComponent(id)}`); state.plan = out.plan; } catch { /* ignore */ }
    await refreshBootstrap();
    render();
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function refreshPlan(id) {
  try {
    const out = await api(`/api/plans/${encodeURIComponent(id)}/refresh`, { method: 'POST', body: {} });
    state.plan = out.plan;
    await refreshBootstrap();
    render();
    toast('已按最新事实刷新方案');
  } catch (e) {
    state.planError = e;
    render();
  }
}

async function revokePlan(id) {
  const reason = prompt('撤销原因（会写入事件记录）：', '资源调整');
  if (reason === null) return;
  try {
    const out = await api(`/api/plans/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: { reason } });
    state.plan = out.plan;
    await refreshBootstrap();
    render();
    toast('方案已撤销，未执行占用已释放');
  } catch (e) {
    state.planError = e;
    render();
  }
}

function openExecuteMany(allocId, remaining, demandId) {
  const modal = openModal(`执行分配 #${allocId}`, `
    <div class="alert info">订单 <b>${esc(demandId)}</b> · 剩余可执行 <b>${fmt.n(remaining)}</b> 件。
      执行会立即写入库存流水；可只执行一部分，余量稍后执行或撤销。</div>
    <div class="row" style="margin-top:10px">
      <label class="tiny muted">执行数量</label>
      <input id="execQty" type="number" min="0.01" max="${remaining}" step="0.01" value="${remaining}" style="width:120px">
      <span class="tiny muted">最多 ${fmt.n(remaining)}</span>
    </div>
    <div class="row" style="margin-top:8px">
      <label class="tiny muted">备注</label>
      <input id="execNote" type="text" placeholder="可选，例如：部分发运" style="flex:1">
    </div>
  `, [
    ['取消', null],
    ['确认执行', async () => {
      const qty = Number($('#execQty').value);
      const note = $('#execNote').value;
      const out = await api(`/api/allocations/${allocId}/execute`, { method: 'POST', body: { qty, note } });
      closeModal();
      await openPlan(out.planId);
      await refreshBootstrap();
      render();
      toast(`已执行 ${fmt.n(out.executed)} 件`);
    }, 'primary'],
  ]);
  void modal;
}

function openReturn(allocId, remaining) {
  openModal(`撤销分配 #${allocId} 的剩余占用`, `
    <div class="alert warn">只撤销 <b>未执行</b> 部分，最多 <b>${fmt.n(remaining)}</b> 件。
      已执行的库存不会被回滚（那需要走退货/入库流程）。释放后其他方案可以使用这部分库存。</div>
    <div class="row" style="margin-top:10px">
      <label class="tiny muted">撤销数量</label>
      <input id="retQty" type="number" min="0.01" max="${remaining}" step="0.01" value="${remaining}" style="width:120px">
    </div>
    <div class="row" style="margin-top:8px">
      <label class="tiny muted">原因</label>
      <input id="retReason" type="text" placeholder="例如：订单取消、改用其他仓" style="flex:1">
    </div>
  `, [
    ['取消', null],
    ['确认撤销', async () => {
      const qty = Number($('#retQty').value);
      const reason = $('#retReason').value;
      const out = await api(`/api/allocations/${allocId}/return`, { method: 'POST', body: { qty, reason } });
      closeModal();
      await openPlan(out.planId);
      await refreshBootstrap();
      render();
      toast(`已撤销 ${fmt.n(out.returned)} 件占用`);
    }, 'primary'],
  ]);
}

function openTransferArrive(transferId) {
  openModal(`登记在途到达 · ${transferId}`, `
    <div class="alert info">到货后写 <code class="k">transfer_in</code> 流水；如关联订单会随即发运并核销订单数量。</div>
    <div class="row" style="margin-top:10px">
      <label class="tiny muted">到达数量</label>
      <input id="arrQty" type="number" min="0.01" step="0.01" placeholder="留空 = 全部剩余" style="width:150px">
    </div>
  `, [
    ['取消', null],
    ['确认到达', async () => {
      const qty = $('#arrQty').value ? Number($('#arrQty').value) : undefined;
      await api(`/api/transfers/${encodeURIComponent(transferId)}/arrive`, { method: 'POST', body: { qty } });
      closeModal();
      await refreshBootstrap();
      render();
      toast('已登记到达');
    }, 'primary'],
  ]);
}

function openTransferDelay(transferId) {
  openModal(`登记运输延误 · ${transferId}`, `
    <div class="alert warn">延误不会删除在途，而是推后 ETA、重算逾期罚款，并生成恢复任务。</div>
    <div class="row" style="margin-top:10px">
      <label class="tiny muted">延误天数</label>
      <input id="delayDays" type="number" min="1" value="2" style="width:100px">
      <label class="tiny muted">原因</label>
      <input id="delayReason" type="text" placeholder="例如：高速封路" style="flex:1">
    </div>
  `, [
    ['取消', null],
    ['确认延误', async () => {
      await api(`/api/transfers/${encodeURIComponent(transferId)}/delay`, {
        method: 'POST',
        body: { delayDays: Number($('#delayDays').value), reason: $('#delayReason').value },
      });
      closeModal();
      await refreshBootstrap();
      render();
      toast('已登记延误，生成恢复任务');
    }, 'primary'],
  ]);
}

function openReceiptCorrect(receiptId) {
  openModal(`更正到货计划 · ${receiptId}`, `
    <div class="alert warn">更正会更新依据指纹，并把受影响的正式方案标记为"依据已变"，
      相关方案需要复核后才能继续；不会静默修改已确认的占用。</div>
    <div class="row" style="margin-top:10px">
      <label class="tiny muted">更正数量</label>
      <input id="rcQty" type="number" min="0" step="0.01" style="width:120px" placeholder="留空 = 不变">
      <label class="tiny muted">新 ETA</label>
      <input id="rcEta" type="date" style="width:150px">
    </div>
    <div class="row" style="margin-top:8px">
      <label class="tiny muted">更正原因</label>
      <input id="rcReason" type="text" placeholder="例如：供应商少发" style="flex:1">
    </div>
  `, [
    ['取消', null],
    ['确认更正', async () => {
      await api(`/api/receipts/${encodeURIComponent(receiptId)}/correct`, {
        method: 'POST',
        body: {
          qty: $('#rcQty').value ? Number($('#rcQty').value) : undefined,
          etaAt: $('#rcEta').value || undefined,
          reason: $('#rcReason').value,
        },
      });
      closeModal();
      await refreshBootstrap();
      render();
      toast('到货计划已更正');
    }, 'primary'],
  ]);
}

function openReceiptArrive(receiptId) {
  openModal(`登记到货 · ${receiptId}`, `
    <div class="alert info">登记到货会写入 <code class="k">receipt</code> 流水，库存预测随之更新。</div>
    <div class="row" style="margin-top:10px">
      <label class="tiny muted">实际到货数量</label>
      <input id="raQty" type="number" min="0" step="0.01" placeholder="留空 = 按计划数量" style="width:150px">
    </div>
  `, [
    ['取消', null],
    ['确认到货', async () => {
      await api(`/api/receipts/${encodeURIComponent(receiptId)}/arrive`, {
        method: 'POST',
        body: { qty: $('#raQty').value ? Number($('#raQty').value) : undefined },
      });
      closeModal();
      await refreshBootstrap();
      render();
      toast('已登记到货');
    }, 'primary'],
  ]);
}

function openCancelOrder(orderId) {
  openModal(`取消订单 · ${orderId}`, `
    <div class="alert warn">取消会释放该订单所有未执行占用（已执行部分保留），并生成恢复任务提示重新分配。</div>
    <div class="row" style="margin-top:10px">
      <label class="tiny muted">取消原因</label>
      <input id="coReason" type="text" placeholder="例如：客户改期" style="flex:1">
    </div>
  `, [
    ['取消', null],
    ['确认取消订单', async () => {
      await api(`/api/orders/${encodeURIComponent(orderId)}/cancel`, {
        method: 'POST',
        body: { reason: $('#coReason').value },
      });
      closeModal();
      await refreshBootstrap();
      if (state.plan) await openPlan(state.plan.id);
      render();
      toast('订单已取消，占用已释放');
    }, 'danger'],
  ]);
}

async function recoverTask(taskId, objective, btn) {
  btn.disabled = true;
  try {
    const out = await api(`/api/recovery/${encodeURIComponent(taskId)}/plan`, {
      method: 'POST',
      body: { objective },
    });
    await refreshBootstrap();
    state.selectedPlanId = out.plan.id;
    state.plan = out.plan;
    state.tab = 'plans';
    render();
    toast(`已生成恢复方案 ${out.plan.id}（草稿）`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function dismissTask(taskId) {
  const resolution = prompt('处理说明（会写入事件）：', '已人工确认为可接受');
  if (resolution === null) return;
  try {
    await api(`/api/recovery/${encodeURIComponent(taskId)}/dismiss`, { method: 'POST', body: { resolution } });
    await refreshBootstrap();
    render();
    toast('恢复任务已关闭');
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------------------------------------------------------------------------
// 模态框
// ---------------------------------------------------------------------------
let modalEsc = null;
function openModal(title, bodyHtml, buttons) {
  const root = $('#modalRoot');
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true">
        <header><h3>${esc(title)}</h3><button class="ghost small" data-close>关闭</button></header>
        <div class="body">${bodyHtml}</div>
        <footer>
          ${buttons.map(([label, fn, cls], i) => `<button class="${cls ?? ''}" data-btn="${i}">${esc(label)}</button>`).join('')}
        </footer>
      </div>
    </div>`;
  root.querySelector('[data-close]').addEventListener('click', closeModal);
  root.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) closeModal();
  });
  buttons.forEach(([label, fn], i) => {
    if (!fn) return;
    root.querySelector(`[data-btn="${i}"]`).addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await fn();
      } catch (err) {
        toast(err.message, true);
        e.target.disabled = false;
      }
    });
  });
  modalEsc = (ev) => { if (ev.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', modalEsc);
}

function closeModal() {
  $('#modalRoot').innerHTML = '';
  if (modalEsc) document.removeEventListener('keydown', modalEsc);
  modalEsc = null;
}

// ---------------------------------------------------------------------------
// 导出纯渲染函数与状态，便于 Node 端做渲染测试。

export {
  state, render, renderOverview, renderCompare, renderCompareResult, renderPlans,
  renderPlanDetail, renderExecute, renderRecovery, renderAllocTable, renderStockTable,
  renderTransfers, renderReceipts, renderReplay, esc, fmt,
};

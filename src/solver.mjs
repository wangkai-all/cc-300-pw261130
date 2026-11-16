// 方案计算（纯函数，不接触数据库）。
//
// central —— 集中求解：把范围内所有订单、各仓每日可承诺库存、线路每日运力
//            放进同一张最小费用流网络。缺货被建模为一条"每件缺货成本"的兜底边，
//            于是求解结果就是"运费 + 操作费 + 逾期罚款 + 缺货成本"总和最小。
//            稀缺库存会流向更能避免缺货的订单，而不是谁先算谁拿走。
// phased  —— 分阶段分配：按到期日逐单处理，每张单只挑自己单价成本最低的来源，
//            先到先得，不做全局权衡。局部便宜，但可能把别的仓 / 更急的单挤成缺货。
//
// 说明：固定运费（每条线路每批）在最小费用流里是阶梯成本，这里按"单件变动成本 +
// 缺货成本"寻优，出结果后把固定运费按实际发运批次计入总成本。演示数据里这不会
// 改变方案结构，真实上线时应改为混合整数模型。
import { addDays, daysBetween, minDay } from './dates.mjs';

export const EPS = 1e-6;
const INF = 1e15;
const SCALE = 100; // 数量放大 100 倍，转成整数流量

export class PlanError extends Error {
  constructor(message, status = 400, code = 'PLAN_INVALID', detail) {
    super(message);
    this.name = 'PlanError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

const cents = (yuan) => Math.round(Number(yuan) * 100);

/**
 * @param {object} input
 * @param {string} input.today
 * @param {Array} input.orders   [{id, wh_id, sku_id, qty_open, due_at, shortage_cost_per_unit, late_penalty_per_unit_day}]
 * @param {Array} input.availability [{wh_id, sku_id, day, qty}] 每日可承诺库存（已扣安全库存与正式占用）
 * @param {Array} input.lanes
 * @param {Array} input.skus
 */
export function computePlan(input, { objective = 'central', allowEmpty = false } = {}) {
  if (!['central', 'phased'].includes(objective)) {
    throw new PlanError(`未知求解口径: ${objective}`);
  }
  const orders = (input.orders ?? [])
    .filter((o) => Number(o.qty_open) > EPS)
    .map((o) => ({ ...o, qty_open: Number(o.qty_open) }));
  if (!orders.length) {
    if (!allowEmpty) throw new PlanError('所选范围内没有未满足的订单。', 422, 'EMPTY_SCOPE');
    return {
      objective,
      allocations: [],
      metrics: summarize([], [], objective),
      basis: {},
    };
  }

  const skuMap = new Map((input.skus ?? []).map((s) => [s.id, s]));
  const lanes = (input.lanes ?? []).map((l) => ({
    ...l,
    transit_days: Number(l.transit_days),
    base_cost: Number(l.base_cost),
    per_unit_cost: Number(l.per_unit_cost),
    capacity_per_day: Number(l.capacity_per_day),
  }));
  const network = new SupplyNetwork(input);
  const raw = objective === 'central'
    ? solveCentral(network, orders, lanes, skuMap)
    : solvePhased(network, orders, lanes, skuMap);
  const allocations = materialize(raw, orders, lanes, skuMap, objective);
  return {
    objective,
    allocations,
    metrics: summarize(orders, allocations, objective),
    basis: network.basis(),
  };
}

// ---------------------------------------------------------------------------
// 可承诺库存：points 为"当日日终的可承诺量"（已扣安全库存与正式占用）。
// 消耗按累计口径计算：今天拿走的货，明天不会再出现。
// ---------------------------------------------------------------------------
class SupplyNetwork {
  constructor({ today, availability }) {
    this.today = today;
    this.series = new Map();
    for (const row of availability ?? []) {
      const key = `${row.wh_id}|${row.sku_id}`;
      const s = this.series.get(key) ?? { wh: row.wh_id, sku: row.sku_id, points: [], used: new Map() };
      s.points.push({ day: row.day, qty: Number(row.qty) });
      this.series.set(key, s);
    }
    for (const s of this.series.values()) s.points.sort((a, b) => a.day.localeCompare(b.day));
    this.laneUsed = new Map();
  }

  has(wh, sku) { return this.series.has(`${wh}|${sku}`); }
  seriesFor(wh, sku) { return this.series.get(`${wh}|${sku}`); }

  consumedThrough(wh, sku, day) {
    const s = this.seriesFor(wh, sku);
    if (!s) return 0;
    let n = 0;
    for (const [d, q] of s.used) if (d <= day) n += q;
    return n;
  }

  availableOn(wh, sku, day) {
    const s = this.seriesFor(wh, sku);
    if (!s) return 0;
    const p = s.points.find((x) => x.day === day);
    if (!p) return 0;
    return Math.max(0, p.qty - this.consumedThrough(wh, sku, day));
  }

  // 从 notBefore 起最早还有货的一天
  earliest(wh, sku, notBefore) {
    const s = this.seriesFor(wh, sku);
    if (!s) return null;
    const days = s.points
      .filter((p) => p.day >= notBefore && this.availableOn(wh, sku, p.day) > EPS)
      .map((p) => p.day);
    return minDay(...days) ?? null;
  }

  consume(wh, sku, day, qty) {
    if (this.availableOn(wh, sku, day) + EPS < qty) return false;
    this.seriesFor(wh, sku).used.set(day, (this.seriesFor(wh, sku).used.get(day) ?? 0) + qty);
    return true;
  }

  laneFree(lane, day, qty) {
    return (this.laneUsed.get(`${lane.id}|${day}`) ?? 0) + qty <= Number(lane.capacity_per_day) + EPS;
  }

  useLane(lane, day, qty) {
    const k = `${lane.id}|${day}`;
    this.laneUsed.set(k, (this.laneUsed.get(k) ?? 0) + qty);
  }

  basis() {
    const availability = {};
    for (const [key, s] of this.series) {
      availability[key] = s.points.map((p) => ({ day: p.day, qty: p.qty }));
    }
    return { availability };
  }
}

const handlingOf = (skuMap, skuId) => Number(skuMap.get(skuId)?.local_handling_cost ?? 0);

function lateness(order, arrivalDay, { deadline = false } = {}) {
  const days = Math.max(0, daysBetween(order.due_at, arrivalDay));
  const perUnit = round2(days * Number(order.late_penalty_per_unit_day ?? 0));
  return { days, perUnit, deadline };
}

const shortagePerUnit = (order) => Number(order.shortage_cost_per_unit ?? 0);

// ---------------------------------------------------------------------------
// 最小费用流（SPFA 逐次最短路）
// ---------------------------------------------------------------------------
class MinCostFlow {
  constructor() {
    this.nodes = [];
    this.edges = [];
  }

  addNode(meta = {}) {
    const id = this.nodes.length;
    this.nodes.push({ id, out: [], meta });
    return id;
  }

  addEdge(from, to, cap, cost, meta = {}) {
    const e = { from, to, cap, cost, flow: 0, meta };
    const r = { from: to, to: from, cap: 0, cost: -cost, flow: 0, meta: { residual: true }, twin: e };
    e.twin = r;
    this.nodes[from].out.push(e);
    this.nodes[to].out.push(r);
    this.edges.push(e);
    return e;
  }

  shortest(source, sink) {
    const n = this.nodes.length;
    const dist = new Float64Array(n).fill(Infinity);
    const inQueue = new Uint8Array(n);
    const prev = new Array(n).fill(null);
    dist[source] = 0;
    const queue = [source];
    inQueue[source] = 1;
    while (queue.length) {
      const u = queue.shift();
      inQueue[u] = 0;
      for (const e of this.nodes[u].out) {
        const residual = e.cap - e.flow;
        if (residual <= 0) continue;
        const nd = dist[u] + e.cost;
        if (nd < dist[e.to] - 1e-9) {
          dist[e.to] = nd;
          prev[e.to] = e;
          if (!inQueue[e.to]) { queue.push(e.to); inQueue[e.to] = 1; }
        }
      }
    }
    if (prev[sink] == null) return false;
    let push = Infinity;
    for (let v = sink; v !== source; v = prev[v].from) push = Math.min(push, prev[v].cap - prev[v].flow);
    for (let v = sink; v !== source; v = prev[v].from) {
      prev[v].flow += push;
      prev[v].twin.flow -= push;
    }
    return true;
  }

  maxflow(source, sink) {
    let guard = 0;
    while (this.shortest(source, sink)) {
      guard += 1;
      if (guard > 200000) throw new PlanError('网络求解超出迭代上限。', 500, 'FLOW_ITER_LIMIT');
    }
  }
}

// ---------------------------------------------------------------------------
// 集中求解：最小费用流
// ---------------------------------------------------------------------------
function solveCentral(network, orders, lanes, skuMap) {
  const mcf = new MinCostFlow();
  const S = mcf.addNode({ kind: 'source' });
  const T = mcf.addNode({ kind: 'sink' });
  const stockNode = new Map(); // wh|sku|day -> node
  const orderNode = new Map(); // demandId -> node
  const laneCapNode = new Map(); // lane|day -> node
  const laneInNode = new Map(); // lane|day -> node (进入容量节点的发运集合点)

  // 1) 时间展开库存。
  //    当天可承诺量 = 昨天结转 + 当天新增；用供给增量 + 结转边表达，
  //    结转边的容量取后一天的可承诺量，保证任何一天都不超卖。
  for (const [key, s] of network.series) {
    let prev = null;
    let prevQty = 0;
    for (const p of s.points) {
      const node = mcf.addNode({ kind: 'stock', wh: s.wh, sku: s.sku, day: p.day });
      stockNode.set(`${key}|${p.day}`, node);
      const inc = Math.round((p.qty - prevQty) * SCALE);
      if (inc > 0) mcf.addEdge(S, node, inc, 0, { kind: 'supply', wh: s.wh, sku: s.sku, day: p.day });
      if (prev != null) {
        const cap = Math.max(0, Math.round(p.qty * SCALE));
        if (cap > 0) mcf.addEdge(prev, node, cap, 0, { kind: 'carry', wh: s.wh, sku: s.sku, day: p.day });
      }
      prev = node;
      prevQty = p.qty;
    }
  }

  // 2) 订单节点。
  //    每条订单必须被"凑满" qty_open：可以由库存/调拨供给，也可以由
  //    S -> 订单 的缺货边以缺货成本虚拟供给。订单 -> 汇点 容量恰为需求量，
  //    因此流量守恒直接保证"满足量 + 缺货量 = 需求量"，不会超分配。
  for (const order of orders) {
    const node = mcf.addNode({ kind: 'order', demandId: order.id });
    orderNode.set(order.id, node);
    const demand = Math.round(order.qty_open * SCALE);
    mcf.addEdge(S, node, demand, cents(shortagePerUnit(order)), {
      kind: 'unmet', demandId: order.id,
    });
    mcf.addEdge(node, T, demand, 0, { kind: 'demand', demandId: order.id });
  }

  // 3) 本地边：库存日 -> 订单，成本 = 操作费 + 逾期罚款
  for (const order of orders) {
    const s = network.seriesFor(order.wh_id, order.sku_id);
    if (!s) continue;
    for (const p of s.points) {
      const src = stockNode.get(`${order.wh_id}|${order.sku_id}|${p.day}`);
      if (src == null) continue;
      const late = lateness(order, p.day);
      mcf.addEdge(src, orderNode.get(order.id), INF, cents(handlingOf(skuMap, order.sku_id) + late.perUnit), {
        kind: 'local', demandId: order.id, wh: order.wh_id, sku: order.sku_id, day: p.day, lateDays: late.days,
      });
    }
  }

  // 4) 转运边：发运日库存 -> 线路日节点 -> 线路每日容量 -> 订单。
  //    固定运费是阶梯成本，最小费用流只能处理线性成本，因此按"典型批量"摊销
  //    到每件上参与寻优；最终成本仍按实际发运批次数结算（materialize 里做）。
  for (const lane of lanes) {
    const laneDemand = orders
      .filter((o) => o.wh_id === lane.to_wh && network.has(lane.from_wh, o.sku_id))
      .reduce((n, o) => n + o.qty_open, 0);
    const typicalBatch = Math.max(1, Math.min(lane.capacity_per_day, laneDemand || lane.capacity_per_day));
    const amortizedFixed = Number(lane.base_cost) / typicalBatch;
    for (const [key, s] of network.series) {
      if (s.wh !== lane.from_wh) continue;
      for (const p of s.points) {
        // 线路运力按 SKU 分开计（同一线路不同 SKU 不共享车厢容量）
        const lk = `${lane.id}|${s.sku}|${p.day}`;
        let capNode = laneCapNode.get(lk);
        if (capNode == null) {
          const inNode = mcf.addNode({ kind: 'lane', laneId: lane.id, sku: s.sku, day: p.day });
          capNode = mcf.addNode({ kind: 'lane-cap', laneId: lane.id, sku: s.sku, day: p.day });
          laneCapNode.set(lk, capNode);
          laneInNode.set(lk, inNode);
          mcf.addEdge(inNode, capNode, Math.round(lane.capacity_per_day * SCALE), 0, {
            kind: 'lane-capacity', laneId: lane.id, day: p.day,
          });
          for (const order of orders) {
            if (order.wh_id !== lane.to_wh || order.sku_id !== s.sku) continue;
            const arrival = addDays(p.day, lane.transit_days);
            const late = lateness(order, arrival);
            mcf.addEdge(capNode, orderNode.get(order.id), INF, cents(handlingOf(skuMap, order.sku_id) + late.perUnit), {
              kind: 'transfer', demandId: order.id, laneId: lane.id, wh: lane.from_wh,
              sku: order.sku_id, day: p.day, arrival, lateDays: late.days,
            });
          }
        }
        const src = stockNode.get(`${key}|${p.day}`);
        if (src == null) continue;
        mcf.addEdge(src, laneInNode.get(lk), INF, cents(lane.per_unit_cost + amortizedFixed), {
          kind: 'lane-load', laneId: lane.id, sku: s.sku, day: p.day,
        });
      }
    }
  }

  mcf.maxflow(S, T);
  const totalDemand = orders.reduce((n, o) => n + Math.round(o.qty_open * SCALE), 0);
  const delivered = mcf.edges.filter((e) => e.meta.kind === 'demand').reduce((n, e) => n + e.flow, 0);
  if (delivered !== totalDemand) {
    throw new PlanError('网络未覆盖全部需求，输入存在不一致。', 500, 'FLOW_INFEASIBLE', { delivered, totalDemand });
  }

  // 5) 读解
  const raw = [];
  for (const e of mcf.edges) {
    if (e.flow <= 0) continue;
    const qty = e.flow / SCALE;
    if (e.meta.kind === 'local') {
      const order = orders.find((o) => o.id === e.meta.demandId);
      raw.push({
        demandId: e.meta.demandId, source_type: 'local', from_wh: e.meta.wh, sku_id: e.meta.sku,
        lane_id: null, qty, depart_date: e.meta.day, arrival_date: e.meta.day,
        late: lateness(order, e.meta.day), unit_freight: 0,
      });
    } else if (e.meta.kind === 'transfer') {
      const order = orders.find((o) => o.id === e.meta.demandId);
      raw.push({
        demandId: e.meta.demandId, source_type: 'transfer', from_wh: e.meta.wh, sku_id: e.meta.sku,
        lane_id: e.meta.laneId, qty, depart_date: e.meta.day, arrival_date: e.meta.arrival,
        late: lateness(order, e.meta.arrival),
        unit_freight: Number(lanes.find((l) => l.id === e.meta.laneId)?.per_unit_cost ?? 0),
      });
    } else if (e.meta.kind === 'unmet') {
      const order = orders.find((o) => o.id === e.meta.demandId);
      raw.push({
        demandId: e.meta.demandId, source_type: 'unmet', from_wh: null, sku_id: order?.sku_id,
        lane_id: null, qty, depart_date: null, arrival_date: null,
        late: { days: 0, perUnit: 0 }, unit_freight: 0,
      });
    }
  }

  for (const r of raw) {
    if (r.source_type === 'local') {
      r.why = r.late.days > 0
        ? `本地库存最早 ${r.depart_date} 才凑齐，晚于承诺 ${r.late.days} 天；全局权衡后仍优于调拨或缺货。`
        : '本地库存直接满足，无仓间运输，计入操作费。';
    } else if (r.source_type === 'transfer') {
      r.why = `从 ${r.from_wh} 经 ${r.lane_id} 调拨：${r.depart_date} 发出、${r.arrival_date} 到达${r.late.days > 0 ? `，晚 ${r.late.days} 天` : '，按期履约'}。集中求解认为把这批货用在本单比留给调出仓更划算。`;
    } else {
      const order = orders.find((o) => o.id === r.demandId);
      r.why = `集中求解的全局最优解：本单每件缺货成本 ${shortagePerUnit(order).toFixed(2)} 元，低于从任何仓库补齐的到家成本，或库存已分配给更能减少系统总成本的订单。`;
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// 分阶段分配：按到期日逐单，先到先得，只看本单单价
// ---------------------------------------------------------------------------
function solvePhased(network, orders, lanes, skuMap) {
  const raw = [];
  const ordered = [...orders].sort(
    (a, b) => a.due_at.localeCompare(b.due_at)
      || (shortagePerUnit(b) - shortagePerUnit(a))
      || a.id.localeCompare(b.id),
  );
  for (const order of ordered) {
    let left = order.qty_open;

    // 1) 本地库存（本单最便宜，能拿多少拿多少）
    if (network.has(order.wh_id, order.sku_id)) {
      const s = network.seriesFor(order.wh_id, order.sku_id);
      for (const p of s.points) {
        if (left <= EPS) break;
        if (p.day < network.today) continue;
        const avail = network.availableOn(order.wh_id, order.sku_id, p.day);
        if (avail <= EPS) continue;
        const qty = Math.min(avail, left);
        network.consume(order.wh_id, order.sku_id, p.day, qty);
        const late = lateness(order, p.day);
        raw.push({
          demandId: order.id, source_type: 'local', from_wh: order.wh_id,
          sku_id: order.sku_id, lane_id: null, qty, depart_date: p.day, arrival_date: p.day, late,
          unit_freight: 0,
          why: late.days > 0
            ? `本地库存到 ${p.day} 才凑出 ${round2(qty)} 件，晚 ${late.days} 天；分阶段口径仍优先用本地。`
            : `本地库存先到先得，直接满足 ${round2(qty)} 件。`,
        });
        left -= qty;
      }
    }

    // 2) 转运：只比较这张单自己的单价，不看调出仓后续
    while (left > EPS) {
      const options = [];
      for (const lane of lanes) {
        if (lane.to_wh !== order.wh_id) continue;
        if (!network.has(lane.from_wh, order.sku_id)) continue;
        const s = network.seriesFor(lane.from_wh, order.sku_id);
        for (const p of s.points) {
          if (p.day < network.today) continue;
          const avail = network.availableOn(lane.from_wh, order.sku_id, p.day);
          if (avail <= EPS) continue;
          const qty = Math.min(avail, left, lane.capacity_per_day);
          if (!network.laneFree(lane, p.day, qty)) continue;
          const arrival = addDays(p.day, lane.transit_days);
          const late = lateness(order, arrival);
          const unit = Number(lane.per_unit_cost) + handlingOf(skuMap, order.sku_id) + late.perUnit;
          const withFixed = unit + Number(lane.base_cost) / Math.max(qty, 1);
          if (withFixed >= shortagePerUnit(order)) continue;
          options.push({ lane, p, qty, arrival, late, unit, fixed: Number(lane.base_cost) });
        }
      }
      if (!options.length) break;
      options.sort((a, b) =>
        (a.unit + a.fixed / Math.max(a.qty, 1)) - (b.unit + b.fixed / Math.max(b.qty, 1))
        || a.arrival.localeCompare(b.arrival) || a.lane.id.localeCompare(b.lane.id));
      const c = options[0];
      if (!network.consume(c.lane.from_wh, order.sku_id, c.p.day, c.qty)) break;
      network.useLane(c.lane, c.p.day, c.qty);
      raw.push({
        demandId: order.id, source_type: 'transfer', from_wh: c.lane.from_wh,
        sku_id: order.sku_id, lane_id: c.lane.id, qty: c.qty,
        depart_date: c.p.day, arrival_date: c.arrival, late: c.late,
        unit_freight: Number(c.lane.per_unit_cost),
        why: `本单单价最低：运费 ${Number(c.lane.per_unit_cost).toFixed(2)} + 固定运费分摊 ${(c.fixed / c.qty).toFixed(2)} + 操作费 ${handlingOf(skuMap, order.sku_id).toFixed(2)}${c.late.days ? ` + 逾期 ${c.late.perUnit.toFixed(2)}` : ''}，低于缺货成本 ${shortagePerUnit(order).toFixed(2)} 元/件；未评估调出仓自身后续订单。`,
      });
      left -= c.qty;
    }

    if (left > EPS) {
      raw.push({
        demandId: order.id, source_type: 'unmet', from_wh: null, sku_id: order.sku_id,
        lane_id: null, qty: left, depart_date: null, arrival_date: null,
        late: { days: 0, perUnit: 0 }, unit_freight: 0,
        why: `轮到此单时本地和可调拨库存已被前面（更早到期）的订单用掉，剩余 ${round2(left)} 件记为缺货；分阶段口径不会回头重排。`,
      });
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// 成本拆解、固定运费归集、同源合并
// ---------------------------------------------------------------------------
function materialize(raw, orders, lanes, skuMap, objective) {
  const orderMap = new Map(orders.map((o) => [o.id, o]));
  const laneMap = new Map(lanes.map((l) => [l.id, l]));
  const rows = [];
  for (const r of raw) {
    if (r.qty <= EPS) continue;
    const order = orderMap.get(r.demandId);
    if (!order) continue;
    const qty = round2(r.qty);
    rows.push({
      demand_id: order.id,
      wh_id: order.wh_id,
      sku_id: order.sku_id,
      due_at: order.due_at,
      qty,
      source_type: r.source_type,
      from_wh: r.from_wh,
      lane_id: r.lane_id ?? null,
      depart_date: r.depart_date,
      arrival_date: r.arrival_date,
      reserve_date: r.source_type === 'unmet' ? order.due_at : r.depart_date,
      unit_freight: round2(Number(r.unit_freight) || 0),
      unit_handling: r.source_type === 'unmet' ? 0 : round2(handlingOf(skuMap, order.sku_id)),
      fixed_cost: 0,
      late_days: r.late?.days ?? 0,
      late_penalty: r.source_type === 'unmet' ? 0 : round2(Number(order.late_penalty_per_unit_day ?? 0) * (r.late?.days ?? 0) * qty),
      shortage_unit_cost: r.source_type === 'unmet' ? shortagePerUnit(order) : 0,
      shortage_cost: r.source_type === 'unmet' ? round2(shortagePerUnit(order) * qty) : 0,
      reason_code: `${objective}.${r.source_type}`,
      why: r.why,
    });
  }

  // 同一订单、同一线路、同一发运日合并成一批；固定运费每批只收一次
  const merged = new Map();
  for (const row of rows) {
    const key = [row.demand_id, row.source_type, row.from_wh, row.lane_id, row.depart_date, row.late_days].join('|');
    const prev = merged.get(key);
    if (!prev) { merged.set(key, { ...row, batchKey: key }); continue; }
    prev.qty = round2(prev.qty + row.qty);
    prev.late_penalty = round2(prev.late_penalty + row.late_penalty);
    prev.shortage_cost = round2(prev.shortage_cost + row.shortage_cost);
    merged.set(key, prev);
  }

  const out = [];
  for (const row of merged.values()) {
    if (row.source_type === 'transfer' && row.lane_id) {
      row.fixed_cost = round2(Number(laneMap.get(row.lane_id)?.base_cost ?? 0));
    }
    row.freight_cost = round2(row.unit_freight * row.qty);
    row.handling_cost = round2(row.unit_handling * row.qty);
    row.total_cost = round2(
      row.fixed_cost + row.freight_cost + row.handling_cost + row.late_penalty + row.shortage_cost,
    );
    const { batchKey, ...rest } = row;
    void batchKey;
    out.push(rest);
  }
  out.sort((a, b) => a.due_at.localeCompare(b.due_at) || a.demand_id.localeCompare(b.demand_id) || a.source_type.localeCompare(b.source_type));
  return out;
}

export function summarize(orders, allocations, objective) {
  const byOrder = new Map();
  for (const a of allocations) {
    const list = byOrder.get(a.demand_id) ?? [];
    list.push(a);
    byOrder.set(a.demand_id, list);
  }
  const qtySum = (pred) => round2(allocations.filter(pred).reduce((n, a) => n + a.qty, 0));
  const costSum = (key) => round2(allocations.reduce((n, a) => n + (a[key] ?? 0), 0));
  const qty = round2(orders.reduce((n, o) => n + Number(o.qty_open), 0));
  const shortageQty = qtySum((a) => a.source_type === 'unmet');
  return {
    objective,
    orders: orders.length,
    fullyMetOrders: orders.filter((o) => {
      const list = byOrder.get(o.id) ?? [];
      return list.length > 0 && list.every((a) => a.source_type !== 'unmet');
    }).length,
    lateOrders: orders.filter((o) => (byOrder.get(o.id) ?? []).some((a) => a.late_days > 0)).length,
    demandQty: qty,
    localQty: qtySum((a) => a.source_type === 'local'),
    transferredQty: qtySum((a) => a.source_type === 'transfer'),
    shortageQty,
    fillRate: qty > 0 ? round2((qty - shortageQty) / qty) : 1,
    cost: {
      total: costSum('total_cost'),
      freight: round2(costSum('freight_cost') + costSum('fixed_cost')),
      variableFreight: costSum('freight_cost'),
      fixedFreight: costSum('fixed_cost'),
      handling: costSum('handling_cost'),
      late: costSum('late_penalty'),
      shortage: costSum('shortage_cost'),
    },
  };
}

// A/B 对比：逐单成本、缺口，以及"局部便宜、别处断货"的说明
export function comparePlans(a, b, { orders = [] } = {}) {
  const orderMap = new Map(orders.map((o) => [o.id, o]));
  const byDemand = (result) => {
    const m = new Map();
    for (const alloc of result.allocations) {
      const list = m.get(alloc.demand_id) ?? [];
      list.push(alloc);
      m.set(alloc.demand_id, list);
    }
    return m;
  };
  const ma = byDemand(a);
  const mb = byDemand(b);
  const ids = [...new Set([...ma.keys(), ...mb.keys()])].sort();
  const rows = [];
  let starvedCount = 0;
  for (const id of ids) {
    const la = ma.get(id) ?? [];
    const lb = mb.get(id) ?? [];
    const agg = (list) => ({
      qty: round2(list.reduce((n, x) => n + x.qty, 0)),
      cost: round2(list.reduce((n, x) => n + x.total_cost, 0)),
      shortage: round2(list.filter((x) => x.source_type === 'unmet').reduce((n, x) => n + x.qty, 0)),
      transfer: round2(list.filter((x) => x.source_type === 'transfer').reduce((n, x) => n + x.qty, 0)),
      local: round2(list.filter((x) => x.source_type === 'local').reduce((n, x) => n + x.qty, 0)),
      late: Math.max(0, ...list.map((x) => x.late_days)),
    });
    const sa = agg(la);
    const sb = agg(lb);
    const order = orderMap.get(id) ?? {
      wh_id: la[0]?.wh_id ?? lb[0]?.wh_id,
      due_at: la[0]?.due_at ?? lb[0]?.due_at,
    };
    if (sa.shortage < sb.shortage - EPS) starvedCount += 1;
    rows.push({
      demandId: id,
      whId: order.wh_id,
      dueAt: order.due_at,
      skuId: la[0]?.sku_id ?? lb[0]?.sku_id,
      costA: sa.cost,
      costB: sb.cost,
      delta: round2(sb.cost - sa.cost),
      shortageA: sa.shortage,
      shortageB: sb.shortage,
      transferA: sa.transfer,
      transferB: sb.transfer,
      localA: sa.local,
      localB: sb.local,
      lateA: sa.late,
      lateB: sb.late,
      note: rowNote(order, sa, sb, a, b, la[0]?.sku_id ?? lb[0]?.sku_id, id),
    });
  }
  return {
    costDelta: round2(b.metrics.cost.total - a.metrics.cost.total),
    shortageDelta: round2(b.metrics.shortageQty - a.metrics.shortageQty),
    rows,
    starvedCount,
    narrative: buildNarrative(a, b, rows),
  };
}

function rowNote(order, sa, sb, a, b, skuId, id) {
  if (sa.shortage < sb.shortage - EPS) {
    const who = (b.allocations ?? []).filter(
      (x) => x.source_type !== 'unmet' && x.from_wh === order.wh_id && x.sku_id === skuId && x.demand_id !== id,
    );
    const names = [...new Set(who.map((x) => x.demand_id))];
    return names.length
      ? `B 中本仓库存被 ${names.join('、')} 以“本单更便宜”为由先用掉，本单缺口 ${sb.shortage}。`
      : `B 中本仓库存更早被占用，本单缺口 ${sb.shortage}。`;
  }
  if (sa.shortage > sb.shortage + EPS) {
    return `A 将本仓库存留给缺货成本更高的订单，本单承担缺口 ${sa.shortage}，换取总成本更低。`;
  }
  if (sa.transfer > sb.transfer + EPS) return `A 多调拨 ${sa.transfer} 件；B 更依赖本地库存或缺口。`;
  if (sb.transfer > sa.transfer + EPS) return `B 多调拨 ${sb.transfer} 件，正是"局部便宜"的来源。`;
  if (Math.abs(sa.late - sb.late) >= 1) return `逾期天数 A=${sa.late}，B=${sb.late}。`;
  return '';
}

function buildNarrative(a, b, rows) {
  const out = [];
  const worse = [...rows]
    .filter((r) => r.shortageB > r.shortageA + EPS)
    .sort((x, y) => (y.shortageB - y.shortageA) - (x.shortageB - x.shortageA));
  if (b.metrics.shortageQty > a.metrics.shortageQty + EPS) {
    out.push(`分阶段分配逐单挑"自己最便宜"的来源，把库存调去运费更低的地方，却让调出仓自己的订单断货：缺货量 ${a.metrics.shortageQty} → ${b.metrics.shortageQty} 件，缺货成本 ${a.metrics.cost.shortage} → ${b.metrics.cost.shortage} 元。`);
  } else if (Math.abs(b.metrics.shortageQty - a.metrics.shortageQty) <= EPS && worse.length) {
    out.push(`两种口径的缺货总量相同（${a.metrics.shortageQty} 件），但缺货落在谁身上不同：分阶段方案把缺口转移到 ${worse.map((r) => r.demandId).join('、')} 这些缺货成本更高的订单上，因此总成本更高。`);
  } else if (b.metrics.shortageQty < a.metrics.shortageQty - EPS) {
    out.push(`本例中分阶段分配的缺货量反而更低（${a.metrics.shortageQty} → ${b.metrics.shortageQty} 件），这是具体数据的结果，不能当成通用结论。`);
  } else {
    out.push(`两种口径的缺货量相同（${a.metrics.shortageQty} 件），差异主要体现在运费与逾期成本上。`);
  }
  if (b.metrics.cost.freight < a.metrics.cost.freight - EPS) {
    out.push(`分阶段方案的运费确实更低（${b.metrics.cost.freight} vs ${a.metrics.cost.freight} 元），这正是"局部便宜"的来源；但加上缺货与逾期后，总成本 ${b.metrics.cost.total} vs ${a.metrics.cost.total} 元。`);
  }
  if (worse.length) {
    out.push(`被挤掉的是 ${worse.map((r) => `${r.demandId}（+${round2(r.shortageB - r.shortageA)} 件缺口）`).join('、')}，它们缺货成本更高但到期更晚，在逐单分配里排在后面。`);
  }
  out.push(`总成本：集中 ${a.metrics.cost.total} 元 vs 分阶段 ${b.metrics.cost.total} 元；${a.metrics.cost.total <= b.metrics.cost.total ? '集中方案更低' : '分阶段方案更低'}。`);
  return out;
}

// 方案编排：取事实 -> 计算 -> 保存草稿 -> 转正式（占用核对）-> 执行/撤销 -> 延误/恢复。
// 所有修改性操作都在 SQLite 事务里完成，并做乐观并发检查。
import crypto from 'node:crypto';
import { computePlan, comparePlans, PlanError, EPS, round2 } from './solver.mjs';
import {
  DataError, bumpDataVersion, dataVersion, currentDay,
  stockAt, openDemand, allLanes, allSkus, allWarehouses, safetyStock,
  appendStockEvent, logEvent,
} from './inventory.mjs';
import { addDays, eachDay, daysBetween, nowIso, parseDay, parseTime } from './dates.mjs';

export { PlanError, DataError };

const DEFAULT_SETTINGS = { horizonDays: 21, latePenaltyWeight: 1 };

// 从数据库取"事实快照"，任何方案计算都基于它
export function loadFacts(db, scope = {}) {
  const today = currentDay(db);
  const horizon = Number(scope.horizonDays ?? DEFAULT_SETTINGS.horizonDays);
  const skuIds = scope.skuIds?.length ? scope.skuIds : allSkus(db).map((s) => s.id);
  const whIds = scope.whIds?.length ? scope.whIds : allWarehouses(db).map((w) => w.id);
  const warehouses = allWarehouses(db);
  const skus = allSkus(db);
  const lanes = allLanes(db);
  const lastDay = addDays(today, horizon);

  // 每日可承诺库存 = 日终库存 - 安全库存 - 截至当日的未执行占用。
  // 占用按累计口径扣减：一条 11-18 出库的占用，会让 11-18 及之后的可用量都减少。
  const held = db
    .prepare(
      `SELECT wh_id, sku_id, date, SUM(qty - executed_qty - released_qty) AS qty
         FROM reservations
        WHERE state = 'held' AND date >= date(?) AND date <= date(?)
        GROUP BY wh_id, sku_id, date ORDER BY date`,
    )
    .all(today, lastDay);
  const heldByKey = new Map();
  for (const r of held) {
    const k = `${r.wh_id}|${r.sku_id}`;
    const list = heldByKey.get(k) ?? [];
    list.push({ date: r.date, qty: Number(r.qty) });
    heldByKey.set(k, list);
  }
  const heldTotalThrough = (key, day) => {
    let n = 0;
    for (const item of heldByKey.get(key) ?? []) {
      if (item.date <= day) n += item.qty;
    }
    return n;
  };

  const availability = [];
  const grossAvailability = [];
  for (const w of warehouses) {
    for (const s of skus) {
      if (!skuIds.includes(s.id)) continue;
      const safety = safetyStock(db, w.id, s.id);
      const series = dailyStock(db, w.id, s.id, today, lastDay);
      for (const p of series) {
        const reserved = heldTotalThrough(`${w.id}|${s.id}`, p.day);
        const qty = Math.max(0, p.qty - safety - reserved);
        availability.push({ wh_id: w.id, sku_id: s.id, day: p.day, qty, gross: p.qty, safety, reserved });
        grossAvailability.push({ wh_id: w.id, sku_id: s.id, day: p.day, qty: Math.max(0, p.qty - safety) });
      }
    }
  }

  // 已被正式方案承诺、尚未取消的订单量不再进入新一轮试算：
  // 否则第二个方案会重新承诺同一批需求，撞车原因就会变成"订单重复承诺"而不是"库存不够"。
  const promised = new Map();
  for (const r of db.prepare(
    `SELECT demand_id, SUM(qty - executed_qty - released_qty) AS qty
       FROM reservations
      WHERE state = 'held' AND kind = 'demand' AND demand_id IS NOT NULL
      GROUP BY demand_id`,
  ).all()) {
    promised.set(r.demand_id, Number(r.qty));
  }
  // 计算时只把"还没被正式承诺"的余量放进模型，但保留全量未满足订单，
  // 供依据指纹与页面展示使用。
  const allOpenOrders = openDemand(db, { fromDay: today })
    .filter((o) => skuIds.includes(o.sku_id) && whIds.includes(o.wh_id))
    .map((o) => {
      const held = promised.get(o.id) ?? 0;
      return {
        ...o,
        qty_total_open: Number(o.qty_open),
        qty_promised: held,
        qty_open: Math.max(0, Number(o.qty_open) - held),
      };
    });
  const orders = allOpenOrders.filter((o) => o.qty_open > 0);

  return {
    today,
    horizonDays: horizon,
    orders,
    allOpenOrders,
    availability,
    grossAvailability,
    lanes,
    skus,
    warehouses,
    settings: { ...DEFAULT_SETTINGS, ...(scope.settings ?? {}) },
  };
}

// 日终库存预测 = 已发生流水 + 已确认的预计到货（receipts）
// 在途调拨只在真正到达（transfer_in 流水）时计入，避免把未到货当成已有库存。
export function dailyStock(db, whId, skuId, fromDay, toDay) {
  const base = stockAt(db, whId, skuId, addDays(fromDay, -1));
  const ev = db
    .prepare(
      `SELECT date(occurred_at) AS day, SUM(qty_delta) AS delta FROM stock_events
        WHERE wh_id = ? AND sku_id = ? AND date(occurred_at) >= date(?) AND date(occurred_at) <= date(?)
        GROUP BY date(occurred_at)`,
    )
    .all(whId, skuId, fromDay, toDay);
  const byDay = new Map(ev.map((e) => [e.day, Number(e.delta)]));
  const receipts = db.prepare(
    `SELECT date(eta_at) AS day, SUM(qty) AS qty FROM receipts
      WHERE wh_id = ? AND sku_id = ? AND status = 'scheduled'
        AND date(eta_at) >= date(?) AND date(eta_at) <= date(?)
      GROUP BY date(eta_at)`,
  ).all(whId, skuId, fromDay, toDay);
  const receiptByDay = new Map(receipts.map((r) => [r.day, Number(r.qty)]));
  let running = base;
  return eachDay(fromDay, toDay).map((day) => {
    running += (byDay.get(day) ?? 0) + (receiptByDay.get(day) ?? 0);
    return { day, qty: running };
  });
}

// 事实指纹：方案转正式时据此核对"依据是否过期"
export function factsFingerprint(facts) {
  const relevant = {
    today: facts.today,
    // 用订单"原始未满足量"，而不是扣除其他方案承诺后的余量：
    // 其他方案先转正式只应导致"资源被占"的冲突，不应让本方案变成"依据过期"。
    orders: (facts.allOpenOrders ?? facts.orders).map((o) => [o.id, o.qty_total_open ?? o.qty_open, o.due_at, o.status]).sort(),
    // 只包含"事实"（库存流水、到货计划、订单、线路），不包含其他方案的占用：
    // 占用变化在转正式时用槽位核对处理，不应把方案判成"依据过期"。
    availability: (facts.grossAvailability ?? facts.availability).map((a) => [a.wh_id, a.sku_id, a.day, a.qty]),
    lanes: facts.lanes.map((l) => [l.id, l.transit_days, l.base_cost, l.per_unit_cost, l.capacity_per_day]),
    settings: facts.settings,
  };
  return crypto.createHash('sha256').update(JSON.stringify(relevant)).digest('hex').slice(0, 16);
}

export function previewPlan(db, { objective = 'central', scope = {}, allowEmpty = false } = {}) {
  const facts = loadFacts(db, scope);
  const result = computePlan(facts, { objective, allowEmpty });
  return {
    ...result,
    orders: facts.orders,
    factsVersion: dataVersion(db),
    factsHash: factsFingerprint(facts),
    scope: normalizeScope(scope),
    scopeWhIds: facts.warehouses.map((w) => w.id).filter((w) => !scope.whIds?.length || scope.whIds.includes(w)),
    snapshot: factSummary(facts),
  };
}

function normalizeScope(scope = {}) {
  return {
    whIds: scope.whIds ?? [],
    skuIds: scope.skuIds ?? [],
    horizonDays: Number(scope.horizonDays ?? DEFAULT_SETTINGS.horizonDays),
    settings: { ...DEFAULT_SETTINGS, ...(scope.settings ?? {}) },
  };
}

function factSummary(facts) {
  const byWh = {};
  for (const a of facts.availability) {
    const k = `${a.wh_id}|${a.sku_id}`;
    const cur = byWh[k] ?? { wh_id: a.wh_id, sku_id: a.sku_id, today: null, safety: a.safety, reservedToday: 0 };
    if (a.day === facts.today) {
      cur.today = a.gross;
      cur.reservedToday = a.reserved;
      cur.free = a.qty;
      cur.safety = a.safety;
    }
    byWh[k] = cur;
  }
  return {
    today: facts.today,
    orders: facts.orders.length,
    demandQty: round2(facts.orders.reduce((n, o) => n + Number(o.qty_open), 0)),
    availability: Object.values(byWh),
  };
}

export function createPlan(db, { name, objective, scope, actor, settings, allowEmpty = false }) {
  if (!name?.trim()) throw new PlanError('方案名称不能为空。', 422, 'NAME_REQUIRED');
  if (!['central', 'phased'].includes(objective)) throw new PlanError('求解口径必须是 central 或 phased。', 422, 'BAD_OBJECTIVE');
  const result = previewPlan(db, { objective, scope: { ...(scope ?? {}), settings }, allowEmpty });
  const id = `PL-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const at = nowIso();
  const nscope = normalizeScope({ ...(scope ?? {}), settings });
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO plans(id, name, objective, status, created_by, created_at, updated_at,
        basis_version, basis_json, data_version, facts_version, facts_hash, metrics_json, scope_json, row_version)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(
      id, name.trim(), objective, actor, at, at,
      result.factsVersion, JSON.stringify(result.basis), result.factsVersion,
      result.factsVersion, result.factsHash,
      JSON.stringify(result.metrics), JSON.stringify(nscope),
    );
    insertAllocations(db, id, result.allocations);
    logPlanEvent(db, id, 'created', actor, {
      objective, metrics: result.metrics, factsVersion: result.factsVersion,
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getPlan(db, id);
}

function insertAllocations(db, planId, allocations) {
  const stmt = db.prepare(
    `INSERT INTO allocations(plan_id, demand_id, wh_id, sku_id, qty, source_type, from_wh, lane_id,
       depart_date, arrival_date, reserve_date, fixed_cost, unit_freight, unit_handling,
       late_days, late_penalty, shortage_unit_cost, shortage_cost, total_cost,
       reason_code, why, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned')`,
  );
  for (const a of allocations) {
    stmt.run(
      planId, a.demand_id, a.wh_id, a.sku_id, a.qty, a.source_type, a.from_wh, a.lane_id,
      a.depart_date, a.arrival_date, a.reserve_date, a.fixed_cost, a.unit_freight, a.unit_handling,
      a.late_days, a.late_penalty, a.shortage_unit_cost, a.shortage_cost, a.total_cost,
      a.reason_code, a.why,
    );
  }
}

function logPlanEvent(db, planId, kind, actor, detail = {}) {
  db.prepare('INSERT INTO plan_events(plan_id, kind, actor, at, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(planId, kind, actor, nowIso(), JSON.stringify(detail));
}

export function listPlans(db) {
  return db.prepare(
    `SELECT p.*, 
       (SELECT COUNT(*) FROM allocations a WHERE a.plan_id = p.id) AS alloc_count
       FROM plans p ORDER BY p.created_at DESC`,
  ).all().map(decodePlan);
}

function decodePlan(p) {
  if (!p) return null;
  return {
    ...p,
    basis: JSON.parse(p.basis_json),
    metrics: JSON.parse(p.metrics_json),
    scope: JSON.parse(p.scope_json),
  };
}

export function getPlan(db, id) {
  const plan = decodePlan(db.prepare('SELECT * FROM plans WHERE id = ?').get(id));
  if (!plan) throw new DataError('方案不存在。', 404, 'PLAN_NOT_FOUND');
  const allocations = db.prepare(
    `SELECT a.*, o.note AS order_note, o.due_at, o.status AS order_status,
            o.shortage_cost_per_unit, o.late_penalty_per_unit_day
       FROM allocations a JOIN orders o ON o.id = a.demand_id
      WHERE a.plan_id = ? ORDER BY a.demand_id, a.id`,
  ).all(id).map((a) => ({
    ...a,
    qty: Number(a.qty),
    committed_qty: Number(a.committed_qty),
    executed_qty: Number(a.executed_qty),
    delivered_qty: Number(a.delivered_qty),
    returned_qty: Number(a.returned_qty),
  }));
  const events = db.prepare('SELECT * FROM plan_events WHERE plan_id = ? ORDER BY id').all(id)
    .map((e) => ({ ...e, detail: JSON.parse(e.detail_json) }));
  const reservations = db.prepare(
    `SELECT r.*, a.demand_id, a.source_type FROM reservations r
       JOIN allocations a ON a.id = r.alloc_id
      WHERE r.plan_id = ? ORDER BY r.date, r.id`,
  ).all(id);
  return { ...plan, allocations, events, reservations };
}

// ---------------------------------------------------------------------------
// 转正式：重新核对依据 -> 检查每个资源槽位是否超占 -> 写占用
// ---------------------------------------------------------------------------
export function commitPlan(db, id, { actor, expectedRowVersion } = {}) {
  const plan = getPlan(db, id);
  if (plan.status !== 'draft') {
    throw new PlanError(`只有草稿方案可以转正式，当前状态：${plan.status}。`, 409, 'BAD_STATUS');
  }
  if (expectedRowVersion != null && Number(expectedRowVersion) !== Number(plan.row_version)) {
    throw new PlanError('方案已被其他计划员修改，请刷新后再确认。', 409, 'STALE_PLAN', {
      incoming: expectedRowVersion, current: plan.row_version,
    });
  }

  // 1) 依据重算：同样的 scope 重新取一次事实
  const fresh = previewPlan(db, { objective: plan.objective, scope: plan.scope, allowEmpty: true });
  const drift = describeDrift(plan.basis, fresh.basis, plan.scope, fresh.snapshot);
  const factsChanged = fresh.factsHash !== plan.facts_hash;

  // 2) 占用核对：每个 (仓,SKU,出库日) 的累计占用不得超过当日可承诺库存。
  //    即使依据已变，也先把"会撞到谁"算出来，方便页面一次性说明。
  const slots = buildSlots(db, plan, fresh);
  const conflicts = checkSlots(db, slots, id);

  if (factsChanged) {
    // 过期方案不允许直接转正式：即使槽位暂时没撞车，方案里的数量/日期也已经不可信。
    writePlanMeta(db, id, { stale_reason: JSON.stringify({ drift, conflicts }), facts_version: fresh.factsVersion });
    logPlanEvent(db, id, 'commit_rejected', actor, { reason: 'stale', drift, conflicts });
    throw new PlanError('方案所依据的库存/订单已变化，请先刷新方案再转正式。', 409, 'PLAN_STALE', {
      drift,
      conflicts,
      factsVersion: fresh.factsVersion,
      currentFacts: fresh.snapshot,
    });
  }

  if (conflicts.length) {
    logPlanEvent(db, id, 'commit_rejected', actor, { reason: 'overcommit', conflicts });
    throw new PlanError('方案会超占已被其他正式方案锁定的库存或需求。', 409, 'OVERCOMMIT', {
      conflicts,
      hint: '可撤销/完成冲突方案，或刷新本方案按剩余资源重算。',
    });
  }

  const at = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const a of plan.allocations) {
      if (a.source_type === 'unmet') continue;
      db.prepare(
        `UPDATE allocations SET status = 'reserved', committed_qty = qty WHERE id = ?`,
      ).run(a.id);
      for (const slot of slots.byAlloc.get(a.id) ?? []) {
        db.prepare(
          `INSERT INTO reservations(plan_id, alloc_id, demand_id, kind, wh_id, sku_id, lane_id, date, qty, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?)`,
        ).run(id, a.id, a.demand_id, slot.kind, slot.wh_id, slot.sku_id ?? a.sku_id, slot.lane_id ?? null, slot.date, slot.qty, at);
      }
    }
    db.prepare(
      `UPDATE plans SET status = 'official', committed_at = ?, committed_by = ?, updated_at = ?,
         row_version = row_version + 1, stale_reason = NULL, facts_hash = ?, facts_version = ?
       WHERE id = ?`,
    ).run(at, actor, at, fresh.factsHash, fresh.factsVersion, id);
    logPlanEvent(db, id, 'committed', actor, { slots: slots.flat.length, factsVersion: fresh.factsVersion });
    logEvent(db, {
      at, actor, kind: 'plan.committed', entityType: 'plan', entityId: id,
      summary: `方案 ${plan.name} 转为正式，占用 ${slots.flat.length} 个库存/线路槽位`,
      detail: { slots: slots.flat.length, metrics: plan.metrics },
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getPlan(db, id);
}

function writePlanMeta(db, id, fields) {
  const map = {
    stale_reason: 'stale_reason', facts_version: 'facts_version',
    row_version_inc: 'row_version',
  };
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    const col = map[k];
    if (!col) continue;
    if (k === 'row_version_inc') sets.push('row_version = row_version + 1');
    else { sets.push(`${col} = ?`); vals.push(v); }
  }
  if (!sets.length) return;
  db.prepare(`UPDATE plans SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, nowIso(), id);
}

// 方案占用的槽位：本地/缺货单按出库日占用本仓库存；转运按发运日占用调出仓库存 + 线路运力
function buildSlots(db, plan, fresh) {
  const byAlloc = new Map();
  const flat = [];
  for (const a of plan.allocations) {
    // 缺货行不占任何资源，也不构成承诺：另一张方案可以补上这部分缺口。
    if (a.source_type === 'unmet') continue;
    // 有库存来源的行同时承诺了订单需求量，防止同一订单被两个正式方案重复承诺
    addSlot(byAlloc, flat, a.id, {
      kind: 'demand', wh_id: a.wh_id, sku_id: a.sku_id, lane_id: null, date: a.due_at, qty: a.qty, allocId: a.id,
    });
    const wh = a.source_type === 'local' ? a.wh_id : a.from_wh;
    addSlot(byAlloc, flat, a.id, {
      kind: 'stock', wh_id: wh, sku_id: a.sku_id, lane_id: null, date: a.depart_date, qty: a.qty, allocId: a.id,
    });
    if (a.source_type === 'transfer') {
      addSlot(byAlloc, flat, a.id, {
        kind: 'lane', wh_id: wh, sku_id: a.sku_id, lane_id: a.lane_id, date: a.depart_date, qty: a.qty, allocId: a.id,
      });
    }
  }
  return { byAlloc, flat };
}

function addSlot(byAlloc, flat, allocId, slot) {
  const list = byAlloc.get(allocId) ?? [];
  list.push(slot);
  byAlloc.set(allocId, list);
  flat.push(slot);
}

// 槽位核对：以"未扣占用的当日可承诺量"为上限，
// 其他正式方案已占 + 本方案拟占 不得超限；同一订单也不能被两个方案重复承诺。
function checkSlots(db, slots, planId) {
  const today = currentDay(db);
  const lanes = allLanes(db);
  const laneCap = new Map(lanes.map((l) => [l.id, Number(l.capacity_per_day)]));
  const conflicts = [];

  const grouped = new Map();
  for (const s of slots.flat) {
    if (s.kind === 'demand') continue;
    const key = s.kind === 'lane'
      ? `lane|${s.lane_id}|${s.date}`
      : `stock|${s.wh_id}|${s.sku_id}|${s.date}`;
    const list = grouped.get(key) ?? [];
    list.push(s);
    grouped.set(key, list);
  }

  for (const [key, list] of grouped) {
    const first = list[0];
    const needed = round2(list.reduce((n, s) => n + s.qty, 0));
    if (first.kind === 'lane') {
      const existing = db.prepare(
        `SELECT COALESCE(SUM(qty),0) AS q FROM reservations
          WHERE lane_id = ? AND date = ? AND kind = 'lane' AND state IN ('held','executed') AND plan_id <> ?`,
      ).get(first.lane_id, first.date, planId);
      const cap = laneCap.get(first.lane_id) ?? 0;
      if (Number(existing.q) + needed > cap + 0.001) {
        conflicts.push({
          kind: 'lane', lane_id: first.lane_id, date: first.date, sku_id: first.sku_id,
          requested: needed, alreadyHeld: Number(existing.q), capacity: cap,
          message: `线路 ${first.lane_id} 在 ${first.date} 的运力 ${cap} 件，已被其他正式方案占用 ${Number(existing.q)} 件，本方案再占 ${needed} 件会超限。`,
        });
      }
      continue;
    }
    // 未扣占用的可承诺量 = 当日日终库存 - 安全库存
    const gross = dailyStock(db, first.wh_id, first.sku_id, first.date, first.date)[0]?.qty ?? 0;
    const safety = safetyStock(db, first.wh_id, first.sku_id);
    const cap = Math.max(0, gross - safety);
    // 其他正式方案在"该日或之前"累计占用的未执行量（占用是跨日持续的资源）
    const existing = db.prepare(
      `SELECT COALESCE(SUM(qty - executed_qty - released_qty),0) AS q FROM reservations
        WHERE wh_id = ? AND sku_id = ? AND date <= ? AND kind = 'stock'
          AND state = 'held' AND plan_id <> ?`,
    ).get(first.wh_id, first.sku_id, first.date, planId);
    if (Number(existing.q) + needed > cap + 0.001) {
      conflicts.push({
        kind: 'stock', wh_id: first.wh_id, sku_id: first.sku_id, date: first.date,
        requested: needed, alreadyHeld: Number(existing.q), capacity: round2(cap),
        message: `${first.wh_id} / ${first.sku_id} 在 ${first.date} 可承诺 ${round2(cap)} 件（已扣安全库存 ${safety}），其中 ${Number(existing.q)} 件已被其他正式方案占用，本方案再占 ${needed} 件会超占。`,
      });
    }
  }

  // 同一订单不能被两个正式方案重复承诺。
  // 同一订单在一张方案里可能有多条分配行（分批出库），要先按订单汇总再判断。
  const demandSlots = slots.flat.filter((s) => s.kind === 'demand' && s.date >= today);
  const byDemand = new Map();
  for (const s of demandSlots) {
    const alloc = db.prepare('SELECT demand_id FROM allocations WHERE id = ?').get(s.allocId);
    if (!alloc) continue;
    const agg = byDemand.get(alloc.demand_id) ?? { qty: 0, date: s.date };
    agg.qty = round2(agg.qty + s.qty);
    byDemand.set(alloc.demand_id, agg);
  }
  for (const [demandId, agg] of byDemand) {
    const other = db.prepare(
      `SELECT COALESCE(SUM(qty - executed_qty - released_qty),0) AS q FROM reservations
        WHERE demand_id = ? AND kind = 'demand' AND state = 'held' AND plan_id <> ?`,
    ).get(demandId, planId);
    const order = db.prepare('SELECT qty_open FROM orders WHERE id = ?').get(demandId);
    const capacity = Number(order?.qty_open ?? 0);
    if (Number(other.q) + agg.qty > capacity + 0.001) {
      conflicts.push({
        kind: 'demand', demand_id: demandId, date: agg.date,
        requested: agg.qty, alreadyHeld: Number(other.q), capacity,
        message: `订单 ${demandId} 的 ${capacity} 件未满足量中已有 ${Number(other.q)} 件被其他正式方案承诺，本方案再承诺 ${agg.qty} 件会重复承诺。`,
      });
    }
  }
  return conflicts;
}

function describeDrift(oldBasis, newBasis, scope, snapshot) {
  const drift = [];
  const oldAvail = oldBasis?.availability ?? {};
  const newAvail = newBasis?.availability ?? {};
  for (const key of new Set([...Object.keys(oldAvail), ...Object.keys(newAvail)])) {
    const a = JSON.stringify(oldAvail[key] ?? null);
    const b = JSON.stringify(newAvail[key] ?? null);
    if (a !== b) {
      const [wh, sku] = key.split('|');
      drift.push({ kind: 'availability', wh_id: wh, sku_id: sku });
    }
  }
  return { changed: drift.length > 0, items: drift.slice(0, 20), snapshot };
}

// 刷新草稿：按最新事实重算，保留方案名与口径
export function refreshPlan(db, id, { actor } = {}) {
  const plan = getPlan(db, id);
  if (plan.status !== 'draft') {
    throw new PlanError('只有草稿方案可以刷新；正式方案需先撤销或完成。', 409, 'BAD_STATUS', { status: plan.status });
  }
  const fresh = previewPlan(db, { objective: plan.objective, scope: plan.scope, allowEmpty: true });
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM allocations WHERE plan_id = ?').run(id);
    insertAllocations(db, id, fresh.allocations);
    db.prepare(
      `UPDATE plans SET basis_version = ?, basis_json = ?, data_version = ?, facts_version = ?,
         facts_hash = ?, metrics_json = ?, row_version = row_version + 1, stale_reason = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(
      fresh.factsVersion, JSON.stringify(fresh.basis), fresh.factsVersion, fresh.factsVersion,
      fresh.factsHash, JSON.stringify(fresh.metrics), nowIso(), id,
    );
    logPlanEvent(db, id, 'refreshed', actor, { factsVersion: fresh.factsVersion });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getPlan(db, id);
}

// 撤销整张正式方案（未执行部分释放，已执行部分不动）
export function revokePlan(db, id, { actor, reason } = {}) {
  const plan = getPlan(db, id);
  if (!['official'].includes(plan.status)) {
    throw new PlanError('只有正式方案可以撤销。', 409, 'BAD_STATUS', { status: plan.status });
  }
  const at = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    const held = db.prepare(
      `SELECT * FROM reservations WHERE plan_id = ? AND state = 'held'`,
    ).all(id);
    releaseReservations(db, held, reason || '方案撤销', at, 'lapsed');
    db.prepare(
      `UPDATE allocations SET status = CASE WHEN executed_qty > 0 THEN 'returned' ELSE 'lapsed' END
        WHERE plan_id = ? AND status IN ('reserved','planned') AND source_type <> 'unmet'`,
    ).run(id);
    db.prepare(
      `UPDATE plans SET status = 'revoked', closed_at = ?, close_reason = ?, row_version = row_version + 1, updated_at = ?
        WHERE id = ?`,
    ).run(at, reason || '计划员撤销', at, id);
    logPlanEvent(db, id, 'revoked', actor, { reason, releasedSlots: held.length });
    logEvent(db, {
      at, actor, kind: 'plan.revoked', entityType: 'plan', entityId: id,
      summary: `方案 ${plan.name} 撤销，释放 ${held.length} 个未执行占用`,
      detail: { reason },
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getPlan(db, id);
}

// 释放占用的未执行部分；已执行部分保持不变。
// 状态含义：
//   held      仍有未执行余量（可继续执行或释放）
//   executed  全部数量已执行
//   released  余量全部释放（可能有部分已执行）
//   lapsed    因订单取消/方案过期整体作废
function releaseReservations(db, rows, reason, at, state = 'released', capPerRow = Infinity) {
  for (const r of rows) {
    const remaining = Number(r.qty) - Number(r.executed_qty) - Number(r.released_qty);
    if (remaining <= EPS) continue;
    // 每条槽位的数量与分配行一致；部分撤销时只释放对应数量，余量继续 held。
    const amount = Math.min(remaining, capPerRow);
    if (amount <= EPS) continue;
    const fullyReleased = Number(r.executed_qty) + Number(r.released_qty) + amount >= Number(r.qty) - 0.001;
    db.prepare(
      `UPDATE reservations SET state = CASE WHEN ? THEN ? ELSE state END,
         released_at = ?, release_reason = ?, released_qty = released_qty + ? WHERE id = ?`,
    ).run(fullyReleased ? 1 : 0, state, at, reason, amount, r.id);
  }
}

// ---------------------------------------------------------------------------
// 执行：部分/整单执行；撤销剩余（回滚）
// ---------------------------------------------------------------------------
export function executeAllocation(db, allocId, { actor, qty, note, at } = {}) {
  const alloc = db.prepare(
    `SELECT a.*, p.status AS plan_status, p.name AS plan_name, p.scope_json,
            o.status AS order_status, o.qty_open AS order_qty_open, o.qty_shipped
       FROM allocations a JOIN plans p ON p.id = a.plan_id JOIN orders o ON o.id = a.demand_id
      WHERE a.id = ?`,
  ).get(allocId);
  if (!alloc) throw new DataError('分配行不存在。', 404, 'ALLOC_NOT_FOUND');
  if (alloc.plan_status !== 'official') {
    throw new PlanError('只有正式方案中的分配行可以执行。', 409, 'PLAN_NOT_OFFICIAL', { status: alloc.plan_status });
  }
  if (alloc.status === 'returned' || alloc.status === 'lapsed') {
    throw new PlanError('该分配行剩余部分已撤销。', 409, 'ALREADY_RELEASED');
  }
  if (alloc.source_type === 'unmet') {
    throw new PlanError('缺货行没有可执行的库存动作。', 422, 'UNMET_NOT_EXECUTABLE');
  }
  if (alloc.order_status === 'cancelled') {
    throw new PlanError('订单已取消，请先撤销该分配行。', 409, 'ORDER_CANCELLED');
  }
  const remaining = round2(Number(alloc.committed_qty) - Number(alloc.executed_qty));
  const n = qty == null ? remaining : Number(qty);
  if (!(n > 0) || n > remaining + 0.001) {
    throw new PlanError(`执行数量必须在 0 与剩余 ${remaining} 之间。`, 422, 'BAD_QTY', { remaining });
  }
  const when = at ? parseTime(at) : nowIso();
  const day = parseDay(when);
  const fromWh = alloc.source_type === 'local' ? alloc.wh_id : alloc.from_wh;

  // 执行前现查：库存要够、订单未取消、线路未超发
  if (alloc.source_type === 'local' && alloc.order_status !== 'open') {
    throw new DataError('订单状态不允许执行。', 409, 'ORDER_NOT_OPEN');
  }
  const onHand = stockAt(db, fromWh, alloc.sku_id, day);
  if (alloc.source_type !== 'unmet' && onHand < n) {
    throw new DataError(`${fromWh} ${alloc.sku_id} 在 ${day} 只有 ${onHand} 件，无法执行 ${n} 件。`, 409, 'INSUFFICIENT_STOCK');
  }

  const ids = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    if (alloc.source_type === 'local') {
      ids.push(appendStockEvent(db, {
        wh_id: alloc.wh_id, sku_id: alloc.sku_id, qty_delta: -n, kind: 'ship',
        ref: `${alloc.plan_id}/${alloc.id}`, note: note || `执行方案 ${alloc.plan_name}`,
        occurred_at: when, created_by: actor,
      }));
      db.prepare('UPDATE orders SET qty_shipped = qty_shipped + ?, qty_open = MAX(0, qty_open - ?) WHERE id = ?')
        .run(n, n, alloc.demand_id);
      db.prepare(
        `UPDATE orders SET status = CASE WHEN qty_open <= 0 THEN 'shipped' ELSE status END WHERE id = ?`,
      ).run(alloc.demand_id);
    } else {
      // 转运：按整条线路发运；同一分配行可能被多次部分执行，按比例分摊固定运费
      const lane = allLanes(db).find((l) => l.id === alloc.lane_id);
      const departDay = alloc.depart_date ?? day;
      const trId = `TR-${alloc.id}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      ids.push(appendStockEvent(db, {
        wh_id: alloc.from_wh, sku_id: alloc.sku_id, qty_delta: -n, kind: 'transfer_out',
        ref: trId, note: `方案 ${alloc.plan_name} 调拨发出`,
        occurred_at: `${departDay}T08:00:00.000Z`, created_by: actor,
      }));
      db.prepare(
        `INSERT INTO transfers(id, sku_id, from_wh, to_wh, lane_id, qty, qty_arrived, status,
            allocation_id, demand_id, departed_at, eta_at, original_eta_at, note)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'in_transit', ?, ?, ?, ?, ?, ?)`,
      ).run(
        trId, alloc.sku_id, alloc.from_wh, alloc.wh_id, alloc.lane_id, n,
        alloc.id, alloc.demand_id, `${departDay}T08:00:00.000Z`,
        `${alloc.arrival_date}T18:00:00.000Z`, `${alloc.arrival_date}T18:00:00.000Z`,
        note || `方案 ${alloc.plan_name} 调拨`,
      );
      // 线路运力占用在正式时已锁定；执行时把 stock 占用转为 executed
    }
    const newExecuted = round2(Number(alloc.executed_qty) + n);
    // "执行完"= 已执行 + 已撤销余量 覆盖承诺量；撤销过的行不应永远停在 reserved
    db.prepare(
      `UPDATE allocations SET executed_qty = ?,
         status = CASE WHEN ? + returned_qty >= committed_qty - 0.001 THEN 'executed' ELSE 'reserved' END
        WHERE id = ?`,
    ).run(newExecuted, newExecuted, allocId);

    // 占用随执行核销：只增加 executed_qty，state 保持 held 直到整条被用掉。
    // 这样"已执行但未用完"的剩余量仍可被撤销，也不会与库存流水重复扣减。
    // 三类槽位一起核销：库存/线路是物理资源，需求槽位是"对订单的承诺"。
    // 需求槽位不核销会让一张订单在执行后仍被旧承诺挡住，剩余需求永远排不进新方案。
    db.prepare(
      `UPDATE reservations SET executed_qty = executed_qty + ?
        WHERE alloc_id = ? AND state = 'held'`,
    ).run(n, allocId);
    db.prepare(
      `UPDATE reservations SET state = 'executed'
        WHERE alloc_id = ? AND state = 'held' AND executed_qty + released_qty >= qty - 0.001`,
    ).run(allocId);

    db.prepare(
      `INSERT INTO executions(plan_id, alloc_id, action, qty, at, actor, note, stock_event_ids)
       VALUES (?, ?, 'execute', ?, ?, ?, ?, ?)`,
    ).run(alloc.plan_id, allocId, n, when, actor, note ?? null, JSON.stringify(ids));
    logPlanEvent(db, alloc.plan_id, 'executed', actor, {
      allocId, qty: n, source: alloc.source_type, from: fromWh, arrival: alloc.arrival_date,
    });
    logEvent(db, {
      at: when, actor, kind: 'allocation.executed', entityType: 'allocation', entityId: String(allocId),
      summary: `执行 ${alloc.demand_id} 的${alloc.source_type === 'local' ? '本地出库' : '调拨'} ${n} 件`,
      detail: { planId: alloc.plan_id, fromWh, sku: alloc.sku_id },
    });
    maybeCompletePlan(db, alloc.plan_id, actor, when);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { planId: alloc.plan_id, allocationId: allocId, executed: n };
}

// 撤销分配行的未执行部分（已执行的部分不回滚，需另走进货/退货流程）
export function returnAllocation(db, allocId, { actor, reason, qty } = {}) {
  const alloc = db.prepare(
    `SELECT a.*, p.status AS plan_status, p.name AS plan_name FROM allocations a
       JOIN plans p ON p.id = a.plan_id WHERE a.id = ?`,
  ).get(allocId);
  if (!alloc) throw new DataError('分配行不存在。', 404, 'ALLOC_NOT_FOUND');
  if (alloc.plan_status !== 'official') throw new PlanError('只有正式方案可以撤销分配。', 409, 'PLAN_NOT_OFFICIAL');
  if (alloc.source_type === 'unmet') throw new PlanError('缺货行无需撤销。', 422, 'UNMET_NOT_EXECUTABLE');
  const remaining = round2(Number(alloc.committed_qty) - Number(alloc.executed_qty) - Number(alloc.returned_qty));
  if (remaining <= EPS) throw new PlanError('该分配行没有可撤销的剩余数量。', 409, 'NOTHING_TO_RETURN');
  const n = qty == null ? remaining : Number(qty);
  if (!(n > 0) || n > remaining + 0.001) {
    throw new PlanError(`撤销数量必须在 0 与 ${remaining} 之间。`, 422, 'BAD_QTY', { remaining });
  }
  const at = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    // 需求槽位随余量一起释放：否则订单剩余量会被"已经撤销的承诺"继续挡住。
    const heldForAlloc = db.prepare(
      `SELECT * FROM reservations WHERE alloc_id = ? AND state = 'held'`,
    ).all(allocId);
    releaseReservations(db, heldForAlloc, reason || '部分执行后撤销剩余', at, 'released', n);
    db.prepare(
      `UPDATE allocations SET returned_qty = returned_qty + ?,
         status = CASE
           WHEN executed_qty >= committed_qty - 0.001 THEN 'executed'
           WHEN returned_qty + ? >= committed_qty - executed_qty - 0.001 THEN 'returned'
           ELSE status END
       WHERE id = ?`,
    ).run(n, n, allocId);
    db.prepare(
      `INSERT INTO executions(plan_id, alloc_id, action, qty, at, actor, note, stock_event_ids)
       VALUES (?, ?, 'return', ?, ?, ?, ?, '[]')`,
    ).run(alloc.plan_id, allocId, n, at, actor, reason ?? null);
    logPlanEvent(db, alloc.plan_id, 'returned', actor, { allocId, qty: n, reason });
    logEvent(db, {
      at, actor, kind: 'allocation.returned', entityType: 'allocation', entityId: String(allocId),
      summary: `撤销 ${alloc.demand_id} 的剩余占用 ${n} 件`,
      detail: { planId: alloc.plan_id, reason },
    });
    maybeCompletePlan(db, alloc.plan_id, actor, at);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { planId: alloc.plan_id, allocationId: allocId, returned: n };
}

// 订单取消：释放该订单尚未执行的占用，并记录事件 + 恢复任务
export function cancelOrder(db, orderId, { actor, reason } = {}) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new DataError('订单不存在。', 404, 'ORDER_NOT_FOUND');
  if (order.status !== 'open') throw new PlanError(`订单当前状态为 ${order.status}，无法取消。`, 409, 'BAD_ORDER_STATUS');
  const at = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    const held = db.prepare(
      `SELECT r.* FROM reservations r
        WHERE r.demand_id = ? AND r.state = 'held' AND r.kind <> 'demand'`,
    ).all(orderId);
    releaseReservations(db, held, `订单 ${orderId} 取消`, at, 'lapsed');
    db.prepare(
      `UPDATE reservations SET state = CASE WHEN executed_qty > 0 THEN 'executed' ELSE 'released' END,
         released_at = CASE WHEN executed_qty > 0 THEN released_at ELSE ? END
       WHERE demand_id = ? AND kind = 'demand' AND state = 'held'`,
    ).run(at, orderId);
    db.prepare("UPDATE orders SET status = 'cancelled', cancelled_at = ?, note = COALESCE(?, note) WHERE id = ?")
      .run(at, reason ? `取消原因：${reason}` : null, orderId);
    db.prepare(
      `UPDATE allocations SET status = CASE WHEN executed_qty > 0 THEN 'executed' ELSE 'lapsed' END
        WHERE demand_id = ? AND status IN ('planned','reserved') AND source_type <> 'unmet'`,
    ).run(orderId);
    logEvent(db, {
      at, actor, kind: 'order.cancelled', entityType: 'order', entityId: orderId,
      summary: `订单 ${orderId} 取消，释放 ${held.length} 个未执行占用`,
      detail: { reason, released: held.length },
    });
    if (held.length) {
      addRecoveryTask(db, {
        kind: 'reallocate',
        priority: 1,
        demandId: orderId,
        title: `订单 ${orderId} 取消，库存已释放，可重新分配`,
        detail: `释放了 ${held.reduce((n, r) => n + Number(r.qty), 0)} 件占用，建议检查是否有其他方案中的缺货行可以补上。`,
        suggestion: { releasedQty: held.reduce((n, r) => n + Number(r.qty), 0), candidates: [] },
        at, actor,
      });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
}

export function addRecoveryTask(db, { kind, priority = 2, demandId = null, planId = null, transferId = null, title, detail, suggestion = {}, at = nowIso(), actor = '系统' }) {
  const id = `RT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  db.prepare(
    `INSERT INTO recovery_tasks(id, kind, status, priority, demand_id, plan_id, transfer_id, title, detail,
        suggestion_json, created_at)
     VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, kind, priority, demandId, planId, transferId, title, detail, JSON.stringify(suggestion), at);
  logEvent(db, {
    at, actor, kind: 'recovery.created', entityType: 'recovery', entityId: id,
    summary: title, detail: { kind, demandId, planId, transferId },
  });
  return id;
}

// 到货更正（改数量/改期）；若关联正式方案需重新核对
export function correctReceipt(db, receiptId, { actor, qty, etaAt, reason } = {}) {
  const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(receiptId);
  if (!r) throw new DataError('到货计划不存在。', 404, 'RECEIPT_NOT_FOUND');
  if (r.status !== 'scheduled') throw new PlanError('只有计划中的到货可以更正。', 409, 'BAD_RECEIPT_STATUS');
  const newQty = qty == null ? Number(r.qty) : Number(qty);
  if (!(newQty >= 0)) throw new PlanError('更正数量不能为负。', 422, 'BAD_QTY');
  const newEta = etaAt ? parseDay(etaAt) : r.eta_at;
  const at = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE receipts SET qty = ?, eta_at = ?, revision = revision + 1, updated_at = ?, note = ? WHERE id = ?')
      .run(newQty, newEta, at, reason ? `${r.note ?? ''} / 更正：${reason}`.trim() : r.note, receiptId);
    bumpDataVersion(db);
    logEvent(db, {
      at, actor, kind: 'receipt.corrected', entityType: 'receipt', entityId: receiptId,
      summary: `${receiptId} 到货更正：${r.qty} → ${newQty} 件，ETA ${r.eta_at} → ${newEta}`,
      detail: { reason, before: { qty: Number(r.qty), eta: r.eta_at }, after: { qty: newQty, eta: newEta } },
    });
    // 受影响的正式方案标记"依据已变"，不静默改动
    const affected = db.prepare(
      `SELECT DISTINCT p.id, p.name FROM plans p
        JOIN reservations rv ON rv.plan_id = p.id
        WHERE p.status = 'official' AND rv.wh_id = ? AND rv.sku_id = ? AND rv.date >= ?`,
    ).all(r.wh_id, r.sku_id, newEta);
    for (const p of affected) {
      db.prepare('UPDATE plans SET stale_reason = ?, updated_at = ? WHERE id = ?').run(
        `到货 ${receiptId} 于 ${at} 更正为 ${newQty} 件 / ${newEta}`,
        at,
        p.id,
      );
      logPlanEvent(db, p.id, 'basis_changed', actor, { receiptId, before: { qty: Number(r.qty), eta: r.eta_at }, after: { qty: newQty, eta: newEta } });
    }
    if (affected.length) {
      addRecoveryTask(db, {
        kind: 'review', priority: 1, title: `到货更正影响 ${affected.length} 个正式方案`,
        detail: `${receiptId} 的到货数量/日期变化，以下正式方案需要复核：${affected.map((p) => `${p.name}(${p.id})`).join('、')}`,
        suggestion: { receiptId, plans: affected.map((p) => p.id) }, at, actor,
      });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return db.prepare('SELECT * FROM receipts WHERE id = ?').get(receiptId);
}

// 到货登记：真到达时写库存流水，并把到货计划标记完成
export function arriveReceipt(db, receiptId, { actor, qty, at } = {}) {
  const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(receiptId);
  if (!r) throw new DataError('到货计划不存在。', 404, 'RECEIPT_NOT_FOUND');
  if (r.status === 'arrived') throw new PlanError('该到货已登记。', 409, 'ALREADY_ARRIVED');
  const when = at ? parseTime(at) : nowIso();
  const n = qty == null ? Number(r.qty) : Number(qty);
  db.exec('BEGIN IMMEDIATE');
  try {
    const id = appendStockEvent(db, {
      wh_id: r.wh_id, sku_id: r.sku_id, qty_delta: n, kind: 'receipt', ref: receiptId,
      note: '到货登记', occurred_at: when, created_by: actor,
    });
    db.prepare("UPDATE receipts SET status = 'arrived', arrived_qty = ?, updated_at = ? WHERE id = ?").run(n, when, receiptId);
    logEvent(db, {
      at: when, actor, kind: 'receipt.arrived', entityType: 'receipt', entityId: receiptId,
      summary: `${receiptId} 到货 ${n} 件`, detail: { stockEventId: id },
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return db.prepare('SELECT * FROM receipts WHERE id = ?').get(receiptId);
}

// 在途到达：货到目的仓 -> 写 transfer_in + ship 流水 -> 订单发运 -> 交付核销
export function arriveTransfer(db, transferId, { actor, qty, at, note } = {}) {
  const t = db.prepare('SELECT * FROM transfers WHERE id = ?').get(transferId);
  if (!t) throw new DataError('在途运输不存在。', 404, 'TRANSFER_NOT_FOUND');
  if (!['in_transit', 'partially_arrived'].includes(t.status)) {
    throw new PlanError(`当前状态 ${t.status} 的运输不能再登记到达。`, 409, 'BAD_TRANSFER_STATUS');
  }
  const remaining = round2(Number(t.qty) - Number(t.qty_arrived));
  const n = qty == null ? remaining : Number(qty);
  if (!(n > 0) || n > remaining + 0.001) {
    throw new PlanError(`到达数量必须在 0 与剩余 ${remaining} 之间。`, 422, 'BAD_QTY', { remaining });
  }
  const when = at ? parseTime(at) : nowIso();
  const allocation = t.allocation_id
    ? db.prepare('SELECT * FROM allocations WHERE id = ?').get(t.allocation_id)
    : null;
  const ids = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    ids.push(appendStockEvent(db, {
      wh_id: t.to_wh, sku_id: t.sku_id, qty_delta: n, kind: 'transfer_in',
      ref: transferId, note: note || `在途 ${transferId} 到达`, occurred_at: when, created_by: actor,
    }));
    const arrived = round2(Number(t.qty_arrived) + n);
    db.prepare(
      `UPDATE transfers SET qty_arrived = ?, status = CASE WHEN ? >= qty - 0.001 THEN 'arrived' ELSE 'partially_arrived' END
        WHERE id = ?`,
    ).run(arrived, arrived, transferId);

    // 到达后立即从目的仓发给客户；订单数量在此核销
    const order = allocation ? db.prepare('SELECT * FROM orders WHERE id = ?').get(allocation.demand_id) : null;
    if (allocation && order && order.status === 'open') {
      const deliver = Math.min(n, Number(order.qty_open));
      if (deliver > 0) {
        ids.push(appendStockEvent(db, {
          wh_id: t.to_wh, sku_id: t.sku_id, qty_delta: -deliver, kind: 'ship',
          ref: `${allocation.plan_id}/${allocation.id}`, note: `调拨到达后交付 ${allocation.demand_id}`,
          occurred_at: when, created_by: actor,
        }));
        db.prepare('UPDATE orders SET qty_shipped = qty_shipped + ?, qty_open = MAX(0, qty_open - ?) WHERE id = ?')
          .run(deliver, deliver, order.id);
        db.prepare("UPDATE orders SET status = CASE WHEN qty_open <= 0 THEN 'shipped' ELSE status END WHERE id = ?")
          .run(order.id);
        db.prepare('UPDATE allocations SET delivered_qty = delivered_qty + ? WHERE id = ?')
          .run(deliver, allocation.id);
      }
      db.prepare(
        `INSERT INTO executions(plan_id, alloc_id, action, qty, at, actor, note, stock_event_ids)
         VALUES (?, ?, 'arrive', ?, ?, ?, ?, ?)`,
      ).run(allocation.plan_id, allocation.id, n, when, actor, note ?? null, JSON.stringify(ids));
      logPlanEvent(db, allocation.plan_id, 'transfer_arrived', actor, { transferId, qty: n, delivered: Math.min(n, Number(order.qty_open) + n) });
    }
    logEvent(db, {
      at: when, actor, kind: 'transfer.arrived', entityType: 'transfer', entityId: transferId,
      summary: `${transferId} 到达 ${t.to_wh} ${n} 件${t.delay_days > 0 ? `（累计延误 ${t.delay_days} 天）` : ''}`,
      detail: { qty: n, allocationId: t.allocation_id },
    });
    if (allocation) maybeCompletePlan(db, allocation.plan_id, actor, when);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return db.prepare('SELECT * FROM transfers WHERE id = ?').get(transferId);
}

// 运输延误：更新 ETA，把受影响分配的到达日推后，生成恢复任务
export function delayTransfer(db, transferId, { actor, delayDays, reason, newEta } = {}) {
  const t = db.prepare('SELECT * FROM transfers WHERE id = ?').get(transferId);
  if (!t) throw new DataError('在途运输不存在。', 404, 'TRANSFER_NOT_FOUND');
  if (!['in_transit', 'partially_arrived'].includes(t.status)) {
    throw new PlanError(`当前状态 ${t.status} 的运输不能登记延误。`, 409, 'BAD_TRANSFER_STATUS');
  }
  const days = Number(delayDays);
  if (!(days > 0)) throw new PlanError('延误天数必须大于 0。', 422, 'BAD_DELAY');
  const at = nowIso();
  const eta = newEta ? parseDay(newEta) : addDays(t.eta_at, days);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `UPDATE transfers SET eta_at = ?, delay_days = delay_days + ?, delay_reason = ? WHERE id = ?`,
    ).run(eta, days, reason ?? null, transferId);
    // 关联的分配行：到达日推后，逾期罚款重算，状态保持（已发出的运输不可"取消"）
    let impacted = [];
    if (t.allocation_id) {
      const a = db.prepare('SELECT * FROM allocations WHERE id = ?').get(t.allocation_id);
      if (a) {
        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(a.demand_id);
        const lateDays = Math.max(0, daysBetween(order.due_at, eta));
        const latePenalty = round2(lateDays * Number(order.late_penalty_per_unit_day ?? 0) * Number(a.qty));
        db.prepare(
          `UPDATE allocations SET arrival_date = ?, late_days = ?, late_penalty = ?,
             total_cost = fixed_cost + unit_freight * qty + unit_handling * qty + ? + shortage_cost
           WHERE id = ?`,
        ).run(eta, lateDays, latePenalty, latePenalty, a.id);
        impacted = [a.demand_id];
        logPlanEvent(db, a.plan_id, 'transfer_delayed', actor, {
          transferId, eta, lateDays, latePenalty,
        });
        recomputePlanMetrics(db, a.plan_id);
      }
    }
    // 线路运力是在"发运日"锁定的，延误不改变发运日，因此不动 lane 占用的日期。
    bumpDataVersion(db);
    logEvent(db, {
      at, actor, kind: 'transfer.delayed', entityType: 'transfer', entityId: transferId,
      summary: `${transferId} 延误 ${days} 天，ETA ${t.eta_at} → ${eta}`,
      detail: { reason, impacted },
    });
    addRecoveryTask(db, {
      kind: 'reallocate', priority: 1, demandId: t.demand_id, transferId, planId: t.allocation_id
        ? db.prepare('SELECT plan_id FROM allocations WHERE id = ?').get(t.allocation_id)?.plan_id : null,
      title: `在途 ${transferId} 延误 ${days} 天`,
      detail: `预计 ${eta} 到达${t.demand_id ? `，订单 ${t.demand_id} 可能逾期` : ''}。可考虑改用其他仓库存或补发。`,
      suggestion: { transferId, delayDays: days, newEta: eta }, at, actor,
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return db.prepare('SELECT * FROM transfers WHERE id = ?').get(transferId);
}

// 恢复：把延误/取消后的补救建议落到一个新方案（草稿）
export function buildRecoveryPlan(db, taskId, { actor, objective = 'central' } = {}) {
  const task = db.prepare('SELECT * FROM recovery_tasks WHERE id = ?').get(taskId);
  if (!task) throw new DataError('恢复任务不存在。', 404, 'TASK_NOT_FOUND');
  if (task.status !== 'open') throw new PlanError('该恢复任务已处理。', 409, 'TASK_CLOSED');
  const order = task.demand_id
    ? db.prepare('SELECT * FROM orders WHERE id = ?').get(task.demand_id)
    : null;
  const scope = order
    ? { whIds: [], skuIds: [order.sku_id], settings: { horizonDays: 10 } }
    : { whIds: [], skuIds: [], settings: { horizonDays: 10 } };
  // 恢复方案允许为空：可能资源已被其他正式方案占满，此时生成草稿供人工复核，
  // 而不是把它当成错误。
  const plan = createPlan(db, {
    name: `恢复-${task.id}${order ? `-${order.id}` : ''}`, objective, actor, scope, allowEmpty: true,
  });
  db.prepare("UPDATE recovery_tasks SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?")
    .run(nowIso(), actor, `生成恢复方案 ${plan.id}`, taskId);
  logEvent(db, {
    at: nowIso(), actor, kind: 'recovery.resolved', entityType: 'recovery', entityId: taskId,
    summary: `恢复任务生成方案 ${plan.id}`, detail: { planId: plan.id },
  });
  return plan;
}

export function dismissRecovery(db, taskId, { actor, resolution } = {}) {
  const task = db.prepare('SELECT * FROM recovery_tasks WHERE id = ?').get(taskId);
  if (!task) throw new DataError('恢复任务不存在。', 404, 'TASK_NOT_FOUND');
  if (task.status !== 'open') throw new PlanError('该恢复任务已处理。', 409, 'TASK_CLOSED');
  db.prepare("UPDATE recovery_tasks SET status = 'dismissed', resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?")
    .run(nowIso(), actor, resolution ?? '人工确认无需处理', taskId);
  return db.prepare('SELECT * FROM recovery_tasks WHERE id = ?').get(taskId);
}

export function listRecovery(db) {
  return db.prepare(
    `SELECT t.*, o.wh_id AS demand_wh, o.sku_id AS demand_sku, o.due_at AS demand_due
       FROM recovery_tasks t LEFT JOIN orders o ON o.id = t.demand_id
      ORDER BY CASE t.status WHEN 'open' THEN 0 ELSE 1 END, t.priority, t.created_at DESC`,
  ).all().map((t) => ({ ...t, suggestion: JSON.parse(t.suggestion_json) }));
}

// 批次方案：分阶段分配 = 按仓/按区域拆成若干子方案，各自独立求解。
// 每一阶段只看到自己范围内的订单与库存，上一阶段转正式后的占用会自然从下一阶段的可用量里扣掉。
export function createPhasedBatch(db, { name, actor, whIds = [], skuIds = [], stages = 2, objective = 'phased' } = {}) {
  const warehouses = whIds.length ? whIds : allWarehouses(db).map((w) => w.id);
  const skus = skuIds.length ? skuIds : allSkus(db).map((s) => s.id);
  const chunkSize = Math.ceil(warehouses.length / Math.max(1, stages));
  const chunks = [];
  for (let i = 0; i < warehouses.length; i += chunkSize) chunks.push(warehouses.slice(i, i + chunkSize));
  const batchId = `PB-${Date.now().toString(36).toUpperCase()}`;
  const created = [];
  const rollback = [];
  for (const [i, chunk] of chunks.entries()) {
    try {
      const p = createPlan(db, {
        name: `${name} · 阶段 ${i + 1}`,
        objective,
        actor,
        scope: { whIds: chunk, skuIds: skus },
        allowEmpty: false,
      });
      db.prepare('UPDATE plans SET phase_json = ? WHERE id = ?').run(
        JSON.stringify({ batchId, stage: i + 1, stages: chunks.length, whIds: chunk }),
        p.id,
      );
      created.push(getPlan(db, p.id));
    } catch (e) {
      rollback.push({ stage: i + 1, error: e.message, whIds: chunk });
    }
  }
  if (created.length) {
    logEvent(db, {
      at: nowIso(), actor, kind: 'plan.batch_created', entityType: 'plan', entityId: batchId,
      summary: `分阶段批次 ${name} 生成 ${created.length} 个草稿方案`,
      detail: { batchId, stages: created.map((p) => ({ id: p.id, whIds: p.scope.whIds })) },
    });
  }
  return { batchId, stages: created, errors: rollback };
}

// 方案内分配行成本变化后（例如运输延误导致逾期罚金重算），同步方案的汇总指标。
// 直接从分配行重算，避免依赖"订单仍未满足量"随执行变化而漂移。
function recomputePlanMetrics(db, planId) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  if (!plan) return;
  const rows = db.prepare('SELECT * FROM allocations WHERE plan_id = ?').all(planId);
  const byDemand = new Map();
  for (const a of rows) {
    byDemand.set(a.demand_id, [...(byDemand.get(a.demand_id) ?? []), a]);
  }
  const sum = (pred, pick) => round2(rows.filter(pred).reduce((n, a) => n + pick(a), 0));
  const demandQty = sum(() => true, (a) => Number(a.qty));
  const shortageQty = sum((a) => a.source_type === 'unmet', (a) => Number(a.qty));
  const metrics = {
    ...JSON.parse(plan.metrics_json),
    orders: byDemand.size,
    fullyMetOrders: [...byDemand.values()].filter((list) => list.every((a) => a.source_type !== 'unmet')).length,
    lateOrders: [...byDemand.values()].filter((list) => list.some((a) => Number(a.late_days) > 0)).length,
    demandQty,
    localQty: sum((a) => a.source_type === 'local', (a) => Number(a.qty)),
    transferredQty: sum((a) => a.source_type === 'transfer', (a) => Number(a.qty)),
    shortageQty,
    fillRate: demandQty > 0 ? round2((demandQty - shortageQty) / demandQty) : 1,
    cost: {
      total: sum(() => true, (a) => Number(a.total_cost)),
      freight: sum(() => true, (a) => Number(a.fixed_cost) + Number(a.unit_freight) * Number(a.qty)),
      variableFreight: sum(() => true, (a) => Number(a.unit_freight) * Number(a.qty)),
      fixedFreight: sum(() => true, (a) => Number(a.fixed_cost)),
      handling: sum(() => true, (a) => Number(a.unit_handling) * Number(a.qty)),
      late: sum(() => true, (a) => Number(a.late_penalty)),
      shortage: sum(() => true, (a) => Number(a.shortage_cost)),
    },
  };
  db.prepare('UPDATE plans SET metrics_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(metrics), nowIso(), planId);
}

// 方案完成后自动标记
function maybeCompletePlan(db, planId, actor, at) {
  const row = db.prepare(
    `SELECT COUNT(*) AS left FROM allocations
      WHERE plan_id = ? AND source_type <> 'unmet'
        AND committed_qty - executed_qty - returned_qty > 0.001`,
  ).get(planId);
  if (Number(row.left) > 0) return;
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  if (!plan || plan.status !== 'official') return;
  db.prepare("UPDATE plans SET status = 'completed', closed_at = ?, close_reason = ? WHERE id = ?")
    .run(at, '全部执行完毕', planId);
  logPlanEvent(db, planId, 'completed', actor, {});
  logEvent(db, {
    at, actor, kind: 'plan.completed', entityType: 'plan', entityId: planId,
    summary: `方案 ${plan.name} 全部执行完毕`, detail: {},
  });
}

export {
  stockAt, reservationLoad, eventLog, inventoryBoard, availableByDay, stockSnapshot,
  inboundReceipts, inboundTransfers, openDemand, allLanes, allSkus, allWarehouses,
} from './inventory.mjs';
export { comparePlans };

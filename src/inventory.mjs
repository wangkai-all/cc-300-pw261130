// 事件库存：所有数量都由库存流水推导，任何"试算"都不写入流水。
import { eachDay, parseDay, parseTime } from './dates.mjs';

export class DataError extends Error {
  constructor(message, status = 409, code = 'DATA_CONFLICT', detail = undefined) {
    super(message);
    this.name = 'DataError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

export function bumpDataVersion(db, by = 1) {
  const v = Number(getMeta(db, 'data_version', '1')) + by;
  setMeta(db, 'data_version', v);
  return v;
}

export function dataVersion(db) {
  return Number(getMeta(db, 'data_version', '1'));
}

export function currentDay(db) {
  return getMeta(db, 'today', '2026-11-16');
}

// 截至某日结束时的库存
export function stockAt(db, whId, skuId, day) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(qty_delta), 0) AS qty
         FROM stock_events
        WHERE wh_id = ? AND sku_id = ? AND date(occurred_at) <= date(?)`,
    )
    .get(whId, skuId, parseDay(day));
  return Number(row.qty);
}

// 完整库存快照：仓 × SKU
export function stockSnapshot(db, day) {
  const rows = db
    .prepare(
      `SELECT w.id AS wh_id, w.name AS wh_name, s.id AS sku_id, s.name AS sku_name,
              s.unit AS unit,
              COALESCE(SUM(CASE WHEN date(e.occurred_at) <= date(?) THEN e.qty_delta END), 0) AS qty_on_hand,
              COALESCE(SUM(CASE WHEN e.kind = 'transfer_out'
                                 AND date(e.occurred_at) <= date(?) THEN -e.qty_delta END), 0) AS out_in_transit
         FROM warehouses w
         CROSS JOIN skus s
         LEFT JOIN stock_events e ON e.wh_id = w.id AND e.sku_id = s.id
        GROUP BY w.id, s.id
        ORDER BY w.id, s.id`,
    )
    .all(parseDay(day), parseDay(day));
  return rows.map((r) => ({
    ...r,
    qty_on_hand: Number(r.qty_on_hand),
    out_in_transit: Number(r.out_in_transit),
  }));
}

// 未来每日净库存（不考虑方案占用）：给定 t 日结束时的库存 + 之后流水
// 用于回答"如果什么都不做，某仓哪一天会断"。期初库存不足则第 0 天即为负。
export function projectedStockSeries(db, whId, skuId, fromDay, horizonDays) {
  const days = eachDay(fromDay, addDayCount(fromDay, horizonDays));
  const base = stockAt(db, whId, skuId, fromDay);
  const events = db
    .prepare(
      `SELECT date(occurred_at) AS day, SUM(qty_delta) AS delta
         FROM stock_events
        WHERE wh_id = ? AND sku_id = ?
        GROUP BY date(occurred_at)`,
    )
    .all(whId, skuId);
  const byDay = new Map(events.map((e) => [e.day, Number(e.delta)]));
  let running = base;
  return days.map((day) => {
    // fromDay 之后才叠加
    if (day > fromDay) running += byDay.get(day) ?? 0;
    return { day, qty: running };
  });
}

function addDayCount(day, n) {
  const d = new Date(`${parseDay(day)}T00:00:00.000Z`);
  return new Date(d.getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

export function inboundReceipts(db, whId, skuId, fromDay) {
  return db
    .prepare(
      `SELECT * FROM receipts
        WHERE wh_id = ? AND sku_id = ? AND status = 'scheduled' AND date(eta_at) >= date(?)
        ORDER BY date(eta_at)`,
    )
    .all(whId, skuId, parseDay(fromDay))
    .map((r) => ({ ...r, qty: Number(r.qty), original_qty: Number(r.original_qty) }));
}

export function inboundTransfers(db, whId, skuId, fromDay) {
  return db
    .prepare(
      `SELECT t.*, l.transit_days AS lane_transit_days
         FROM transfers t
         JOIN lanes l ON l.id = t.lane_id
        WHERE t.to_wh = ? AND t.sku_id = ?
          AND t.status IN ('in_transit', 'partially_arrived')
          AND date(t.eta_at) >= date(?)
        ORDER BY date(t.eta_at)`,
    )
    .all(whId, skuId, parseDay(fromDay))
    .map((r) => ({ ...r, qty: Number(r.qty), qty_arrived: Number(r.qty_arrived) }));
}

// 未满足的订单需求（open，剩余未发）
export function openDemand(db, { fromDay, whId, skuId } = {}) {
  const where = ["o.status = 'open'", 'date(o.due_at) >= date(?)'];
  const params = [parseDay(fromDay ?? currentDay(db))];
  if (whId) {
    where.push('o.wh_id = ?');
    params.push(whId);
  }
  if (skuId) {
    where.push('o.sku_id = ?');
    params.push(skuId);
  }
  return db
    .prepare(
      `SELECT o.*, w.name AS wh_name, s.name AS sku_name
         FROM orders o
         JOIN warehouses w ON w.id = o.wh_id
         JOIN skus s ON s.id = o.sku_id
        WHERE ${where.join(' AND ')}
        ORDER BY date(o.due_at), o.id`,
    )
    .all(...params)
    .map((o) => ({ ...o, qty_open: Number(o.qty_open), qty_shipped: Number(o.qty_shipped) }));
}

export function allSkus(db) {
  return db.prepare('SELECT * FROM skus ORDER BY id').all();
}

export function allWarehouses(db) {
  return db.prepare('SELECT * FROM warehouses ORDER BY id').all();
}

export function allLanes(db) {
  return db.prepare('SELECT * FROM lanes ORDER BY id').all().map((l) => ({
    ...l,
    transit_days: Number(l.transit_days),
    base_cost: Number(l.base_cost),
    per_unit_cost: Number(l.per_unit_cost),
    capacity_per_day: Number(l.capacity_per_day),
  }));
}

export function getLane(db, id) {
  return allLanes(db).find((l) => l.id === id);
}

export function skuInfo(db, id) {
  return db.prepare('SELECT * FROM skus WHERE id = ?').get(id);
}

export function safetyStock(db, whId, skuId) {
  const row = db
    .prepare('SELECT qty FROM safety_stock WHERE wh_id = ? AND sku_id = ?')
    .get(whId, skuId);
  return Number(row?.qty ?? 0);
}

// 汇总"今天"的全局视图，供前端首屏使用
export function inventoryBoard(db, day = currentDay(db)) {
  const snapshot = stockSnapshot(db, day);
  const receipts = db
    .prepare(
      `SELECT * FROM receipts WHERE status = 'scheduled' AND date(eta_at) >= date(?)
        ORDER BY date(eta_at)`,
    )
    .all(parseDay(day));
  const transfers = db
    .prepare(
      `SELECT t.*, l.transit_days AS lane_transit_days, w1.name AS from_name, w2.name AS to_name
         FROM transfers t
         JOIN lanes l ON l.id = t.lane_id
         JOIN warehouses w1 ON w1.id = t.from_wh
         JOIN warehouses w2 ON w2.id = t.to_wh
        WHERE t.status IN ('in_transit', 'partially_arrived')
        ORDER BY date(t.eta_at)`,
    )
    .all();
  const reservations = reservationLoad(db, day);
  return { day, snapshot, receipts, transfers, reservations };
}

// 各 (仓,SKU,日期) 当前被正式方案占用的数量。
// held 只计"尚未执行、尚未释放"的余量；executed 单列，避免与库存流水重复扣减。
export function reservationLoad(db, fromDay) {
  return db
    .prepare(
      `SELECT wh_id, sku_id, date,
              SUM(CASE WHEN state = 'held' THEN qty - executed_qty - released_qty ELSE 0 END) AS held,
              SUM(executed_qty) AS executed,
              SUM(CASE WHEN state = 'released' THEN released_qty ELSE 0 END) AS released
         FROM reservations
        WHERE date >= date(?)
        GROUP BY wh_id, sku_id, date
        HAVING held > 0 OR executed > 0
        ORDER BY date, wh_id, sku_id`,
    )
    .all(parseDay(fromDay))
    .map((r) => ({ ...r, held: Number(r.held), executed: Number(r.executed), released: Number(r.released) }));
}

export function availableByDay(db, whId, skuId, day, horizonDays = 21) {
  const days = eachDay(day, addDayCount(day, horizonDays));
  const series = new Map(projectedStockSeries(db, whId, skuId, day, horizonDays).map((p) => [p.day, p.qty]));
  const res = db
    .prepare(
      `SELECT date, SUM(qty - executed_qty - released_qty) AS qty FROM reservations
        WHERE wh_id = ? AND sku_id = ? AND state = 'held'
          AND date >= date(?) AND date <= date(?)
        GROUP BY date ORDER BY date`,
    )
    .all(whId, skuId, parseDay(day), days.at(-1));
  // 占用量按"截至当日"累计：3 号被占的货，5 号也不会重新出现。
  let cum = 0;
  const resByDay = new Map();
  for (const r of res) {
    cum += Number(r.qty);
    resByDay.set(r.date, cum);
  }
  let running = 0;
  return days.map((d) => {
    if (resByDay.has(d)) running = resByDay.get(d);
    return {
      day: d,
      projected: series.get(d) ?? 0,
      reserved: running,
      free: (series.get(d) ?? 0) - running,
    };
  });
}

export function appendStockEvent(db, ev) {
  const at = parseTime(ev.occurred_at);
  const info = db
    .prepare(
      `INSERT INTO stock_events(wh_id, sku_id, qty_delta, kind, ref, note, occurred_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ev.wh_id,
      ev.sku_id,
      ev.qty_delta,
      ev.kind,
      ev.ref ?? null,
      ev.note ?? null,
      at,
      ev.created_by,
      new Date().toISOString(),
    );
  bumpDataVersion(db);
  return Number(info.lastInsertRowid);
}

export function eventLog(db, limit = 200) {
  return db
    .prepare(
      `SELECT * FROM events ORDER BY id DESC LIMIT ?`,
    )
    .all(limit);
}

export function logEvent(db, { at, actor, kind, entityType, entityId, summary, detail = {} }) {
  db.prepare(
    `INSERT INTO events(at, actor, kind, entity_type, entity_id, summary, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(at, actor, kind, entityType, entityId, summary, JSON.stringify(detail));
}

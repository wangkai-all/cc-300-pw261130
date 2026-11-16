// 事件库存与转运方案 —— 数据库结构
// 库存数字全部由 stock_events 推导；方案草稿不改动任何库存事实。
// 只有方案转正式会写入 reservations / allocations，执行后才写入库存流水。

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS warehouses (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  region TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skus (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  unit         TEXT NOT NULL,
  local_handling_cost REAL NOT NULL DEFAULT 0
);

-- 仓间线路：时效、基础运费、单件运费、每日发运上限
CREATE TABLE IF NOT EXISTS lanes (
  id              TEXT PRIMARY KEY,
  from_wh         TEXT NOT NULL REFERENCES warehouses(id),
  to_wh           TEXT NOT NULL REFERENCES warehouses(id),
  transit_days    INTEGER NOT NULL,
  base_cost       REAL NOT NULL,
  per_unit_cost   REAL NOT NULL,
  capacity_per_day REAL NOT NULL,
  note            TEXT
);

CREATE TABLE IF NOT EXISTS safety_stock (
  wh_id TEXT NOT NULL REFERENCES warehouses(id),
  sku_id TEXT NOT NULL REFERENCES skus(id),
  qty   REAL NOT NULL,
  PRIMARY KEY (wh_id, sku_id)
);

-- 订单：status = open | cancelled | shipped
CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,
  wh_id       TEXT NOT NULL REFERENCES warehouses(id),
  sku_id      TEXT NOT NULL REFERENCES skus(id),
  qty_open    REAL NOT NULL,
  due_at      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  cancelled_at TEXT,
  qty_shipped  REAL NOT NULL DEFAULT 0,
  shortage_cost_per_unit REAL NOT NULL,
  late_penalty_per_unit_day REAL NOT NULL DEFAULT 0,
  note        TEXT
);

-- 事件库存的事实来源
-- kind: opening | receipt | receipt_correction | ship | transfer_in | transfer_out | adjust
CREATE TABLE IF NOT EXISTS stock_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  wh_id       TEXT NOT NULL REFERENCES warehouses(id),
  sku_id      TEXT NOT NULL REFERENCES skus(id),
  qty_delta   REAL NOT NULL,
  kind        TEXT NOT NULL,
  ref         TEXT,
  note        TEXT,
  occurred_at TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_events_lookup
  ON stock_events(wh_id, sku_id, occurred_at);

-- 在途：transfer_out 已发出，等待 transfer_in
CREATE TABLE IF NOT EXISTS transfers (
  id             TEXT PRIMARY KEY,
  sku_id         TEXT NOT NULL REFERENCES skus(id),
  from_wh        TEXT NOT NULL REFERENCES warehouses(id),
  to_wh          TEXT NOT NULL REFERENCES warehouses(id),
  lane_id        TEXT NOT NULL REFERENCES lanes(id),
  qty            REAL NOT NULL,
  qty_arrived    REAL NOT NULL DEFAULT 0,
  status         TEXT NOT NULL, -- in_transit | arrived | partially_arrived | cancelled
  allocation_id  INTEGER REFERENCES allocations(id),
  demand_id      TEXT REFERENCES orders(id),
  departed_at    TEXT NOT NULL,
  eta_at         TEXT NOT NULL,
  original_eta_at TEXT NOT NULL,
  delay_days     REAL NOT NULL DEFAULT 0,
  delay_reason   TEXT,
  note           TEXT
);

-- 到货计划（在途预计到货）
-- status: scheduled | arrived | cancelled
CREATE TABLE IF NOT EXISTS receipts (
  id          TEXT PRIMARY KEY,
  wh_id       TEXT NOT NULL REFERENCES warehouses(id),
  sku_id      TEXT NOT NULL REFERENCES skus(id),
  qty         REAL NOT NULL,
  original_qty REAL NOT NULL,
  eta_at      TEXT NOT NULL,
  original_eta_at TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'scheduled',
  arrived_qty REAL,
  revision    INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  objective      TEXT NOT NULL, -- central | phased
  status         TEXT NOT NULL DEFAULT 'draft', -- draft | official | completed | revoked
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  basis_version  INTEGER NOT NULL,
  basis_json     TEXT NOT NULL,
  data_version   INTEGER NOT NULL,
  facts_version  INTEGER NOT NULL DEFAULT 0,
  facts_hash     TEXT NOT NULL DEFAULT '',
  metrics_json   TEXT NOT NULL,
  scope_json     TEXT NOT NULL,
  phase_json     TEXT,
  row_version    INTEGER NOT NULL DEFAULT 0,
  stale_reason   TEXT,
  committed_at   TEXT,
  committed_by   TEXT,
  closed_at      TEXT,
  close_reason   TEXT,
  note           TEXT
);

CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);

CREATE TABLE IF NOT EXISTS allocations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id      TEXT NOT NULL REFERENCES plans(id),
  demand_id    TEXT NOT NULL REFERENCES orders(id),
  wh_id        TEXT NOT NULL REFERENCES warehouses(id),
  sku_id       TEXT NOT NULL REFERENCES skus(id),
  qty          REAL NOT NULL,
  source_type  TEXT NOT NULL, -- local | transfer | unmet
  from_wh      TEXT,
  lane_id      TEXT,
  depart_date  TEXT,
  arrival_date TEXT,
  reserve_date TEXT NOT NULL,
  fixed_cost   REAL NOT NULL DEFAULT 0,
  unit_freight REAL NOT NULL DEFAULT 0,
  unit_handling REAL NOT NULL DEFAULT 0,
  late_days    REAL NOT NULL DEFAULT 0,
  late_penalty REAL NOT NULL DEFAULT 0,
  shortage_unit_cost REAL NOT NULL DEFAULT 0,
  shortage_cost REAL NOT NULL DEFAULT 0,
  total_cost   REAL NOT NULL DEFAULT 0,
  reason_code  TEXT NOT NULL,
  why          TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'planned',
  -- planned | reserved | executed | returned | lapsed
  committed_qty REAL NOT NULL DEFAULT 0,
  executed_qty REAL NOT NULL DEFAULT 0,
  delivered_qty REAL NOT NULL DEFAULT 0,
  returned_qty REAL NOT NULL DEFAULT 0,
  conflict_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_alloc_plan ON allocations(plan_id);
CREATE INDEX IF NOT EXISTS idx_alloc_demand ON allocations(demand_id);
CREATE INDEX IF NOT EXISTS idx_alloc_status ON allocations(status);

-- 正式占用。按照 (仓库, SKU) 的"承诺日期"累计核对，
-- 同一批货不会被两个正式方案同时占用。
CREATE TABLE IF NOT EXISTS reservations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id        TEXT NOT NULL REFERENCES plans(id),
  alloc_id       INTEGER NOT NULL REFERENCES allocations(id),
  demand_id      TEXT,
  kind           TEXT NOT NULL, -- stock | lane | demand
  wh_id          TEXT NOT NULL REFERENCES warehouses(id),
  sku_id         TEXT NOT NULL REFERENCES skus(id),
  lane_id        TEXT,
  date           TEXT NOT NULL,
  qty            REAL NOT NULL,
  executed_qty   REAL NOT NULL DEFAULT 0,
  released_qty   REAL NOT NULL DEFAULT 0,
  state          TEXT NOT NULL DEFAULT 'held', -- held | released | executed | lapsed
  created_at     TEXT NOT NULL,
  released_at    TEXT,
  release_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_res_stock ON reservations(wh_id, sku_id, date);
CREATE INDEX IF NOT EXISTS idx_res_plan ON reservations(plan_id);
CREATE INDEX IF NOT EXISTS idx_res_lane ON reservations(lane_id, date);

CREATE TABLE IF NOT EXISTS plan_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id     TEXT NOT NULL REFERENCES plans(id),
  kind        TEXT NOT NULL,
  actor       TEXT NOT NULL,
  at          TEXT NOT NULL,
  detail_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plan_events ON plan_events(plan_id);

-- 实际动作流水，用于回放与审计
CREATE TABLE IF NOT EXISTS executions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id         TEXT NOT NULL REFERENCES plans(id),
  alloc_id        INTEGER NOT NULL REFERENCES allocations(id),
  action          TEXT NOT NULL, -- execute | return | arrive
  qty             REAL NOT NULL,
  at              TEXT NOT NULL,
  actor           TEXT NOT NULL,
  note            TEXT,
  stock_event_ids TEXT NOT NULL
);

-- 非库存事实的系统事件（订单取消、到货更正、延误、恢复）
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  summary     TEXT NOT NULL,
  detail_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_tasks (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL, -- reallocate | replenish | review
  status      TEXT NOT NULL DEFAULT 'open', -- open | resolved | dismissed
  priority    INTEGER NOT NULL DEFAULT 2,
  demand_id   TEXT REFERENCES orders(id),
  plan_id     TEXT REFERENCES plans(id),
  transfer_id TEXT REFERENCES transfers(id),
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL,
  suggestion_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution  TEXT
);
`;

export const DEFAULT_PLANNERS = ['林薇', '赵启明', '周航'];

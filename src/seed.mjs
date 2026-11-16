// 本地虚构演示数据。
// 核心冲突：武汉仓的 K7 库存同时被"武汉自己的紧急订单"和"上海的低价补货订单"需要，
// 集中求解会把库存留给缺货成本 40 元/件的武汉订单；分阶段分配则按到期日先给上海，
// 因为上海的订单更早到期、单件运费更便宜 —— 结果上海省了钱，武汉却断货。
import { SCHEMA, DEFAULT_PLANNERS } from './schema.mjs';
import { addDays, nowIso } from './dates.mjs';
import { setMeta, bumpDataVersion } from './inventory.mjs';

export const TODAY = '2026-11-16';
export const DEMO_PLANNERS = DEFAULT_PLANNERS;

export function migrate(db) {
  db.exec(SCHEMA);
}

export function isSeeded(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'seeded'").get();
  return row?.value === '1';
}

const TABLES = [
  'recovery_tasks', 'events', 'executions', 'plan_events', 'reservations',
  'allocations', 'plans', 'receipts', 'transfers', 'orders', 'stock_events',
  'safety_stock', 'lanes', 'skus', 'warehouses', 'meta',
];

export function seed(db, { reset = false } = {}) {
  if (reset) {
    db.exec('BEGIN');
    try {
      for (const t of TABLES) db.exec(`DELETE FROM ${t}`);
      db.exec("DELETE FROM sqlite_sequence WHERE name IN ('stock_events','allocations','reservations','plan_events','executions','events')");
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } else if (isSeeded(db)) {
    return false;
  }

  db.exec('BEGIN');
  try {
    seedBase(db);
    setMeta(db, 'seeded', '1');
    setMeta(db, 'today', TODAY);
    setMeta(db, 'data_version', '1');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  bumpDataVersion(db, 0);
  return true;
}

function seedBase(db) {
  const wh = db.prepare('INSERT INTO warehouses(id, name, region) VALUES (?, ?, ?)');
  wh.run('WH-SH', '上海·华东仓', '华东');
  wh.run('WH-WH', '武汉·华中仓', '华中');
  wh.run('WH-CD', '成都·西南仓', '西南');
  wh.run('WH-GZ', '广州·华南仓', '华南');

  const sku = db.prepare('INSERT INTO skus(id, name, unit, local_handling_cost) VALUES (?, ?, ?, ?)');
  sku.run('SKU-K7', '净水滤芯 K7', '箱', 1.6);
  sku.run('SKU-B2', '便携电源 B2', '件', 2.4);

  const lane = db.prepare(
    `INSERT INTO lanes(id, from_wh, to_wh, transit_days, base_cost, per_unit_cost, capacity_per_day, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  lane.run('L-WH-SH', 'WH-WH', 'WH-SH', 2, 120, 6.5, 80, '沪汉干线，隔日达');
  lane.run('L-SH-WH', 'WH-SH', 'WH-WH', 2, 120, 6.5, 80, '沪汉干线，隔日达');
  lane.run('L-WH-CD', 'WH-WH', 'WH-CD', 3, 430, 7.8, 60, '汉蓉支线');
  lane.run('L-CD-WH', 'WH-CD', 'WH-WH', 3, 430, 7.8, 60, '汉蓉支线');
  lane.run('L-SH-CD', 'WH-SH', 'WH-CD', 4, 540, 9.2, 50, '沪蓉干线');
  lane.run('L-CD-SH', 'WH-CD', 'WH-SH', 4, 540, 9.2, 50, '沪蓉干线');
  lane.run('L-WH-GZ', 'WH-WH', 'WH-GZ', 2, 360, 7.1, 60, '穗汉干线');
  lane.run('L-GZ-WH', 'WH-GZ', 'WH-WH', 2, 360, 7.1, 60, '穗汉干线');
  lane.run('L-SH-GZ', 'WH-SH', 'WH-GZ', 3, 480, 8.4, 40, '穗沪干线');
  lane.run('L-GZ-SH', 'WH-GZ', 'WH-SH', 3, 480, 8.4, 40, '穗沪干线');

  const safety = db.prepare('INSERT INTO safety_stock(wh_id, sku_id, qty) VALUES (?, ?, ?)');
  safety.run('WH-SH', 'SKU-K7', 20);
  safety.run('WH-WH', 'SKU-K7', 30);
  safety.run('WH-CD', 'SKU-K7', 20);
  safety.run('WH-GZ', 'SKU-K7', 15);
  safety.run('WH-SH', 'SKU-B2', 10);
  safety.run('WH-WH', 'SKU-B2', 8);
  safety.run('WH-CD', 'SKU-B2', 10);
  safety.run('WH-GZ', 'SKU-B2', 5);

  const order = db.prepare(
    `INSERT INTO orders(id, wh_id, sku_id, qty_open, due_at, created_at, status,
       shortage_cost_per_unit, late_penalty_per_unit_day, note, qty_shipped)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 0)`,
  );
  // 上海：到期最早、缺货成本低，是"分阶段口径下的先到者"
  order.run('SO-2602', 'WH-SH', 'SKU-K7', 70, addDays(TODAY, 3), addDays(TODAY, -3), 12, 2, '上海电商日常补货');
  order.run('SO-2603', 'WH-SH', 'SKU-K7', 30, addDays(TODAY, 5), addDays(TODAY, -2), 15, 3, '上海二级网点补货');
  // 武汉：到期晚、缺货成本高，是"被局部便宜挤掉"的那张单
  order.run('SO-2601', 'WH-WH', 'SKU-K7', 90, addDays(TODAY, 6), addDays(TODAY, -1), 40, 8, '武汉关键客户，断货罚款高');
  // 成都、广州：偏远、运费高，用来展示"调拨不一定划算"
  order.run('SO-2604', 'WH-CD', 'SKU-K7', 50, addDays(TODAY, 4), addDays(TODAY, -2), 20, 4, '成都区域仓补货');
  order.run('SO-2605', 'WH-GZ', 'SKU-K7', 40, addDays(TODAY, 7), addDays(TODAY, -1), 25, 5, '广州经销商订单');
  order.run('SO-2606', 'WH-WH', 'SKU-B2', 25, addDays(TODAY, 4), addDays(TODAY, -2), 45, 8, '武汉重点客户');
  order.run('SO-2607', 'WH-CD', 'SKU-B2', 20, addDays(TODAY, 5), addDays(TODAY, -1), 30, 5, '成都项目备货');

  const ev = db.prepare(
    `INSERT INTO stock_events(wh_id, sku_id, qty_delta, kind, ref, note, occurred_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const at = (day) => `${day}T09:00:00.000Z`;
  const seeded = nowIso();
  const opening = (whId, skuId, qty) =>
    ev.run(whId, skuId, qty, 'opening', 'OPEN-2026-11', '期初盘点', at(addDays(TODAY, -1)), '系统', seeded);

  opening('WH-SH', 'SKU-K7', 80);
  opening('WH-WH', 'SKU-K7', 140);
  opening('WH-CD', 'SKU-K7', 60);
  opening('WH-GZ', 'SKU-K7', 30);
  opening('WH-SH', 'SKU-B2', 36);
  opening('WH-WH', 'SKU-B2', 18);
  opening('WH-CD', 'SKU-B2', 30);

  // 计划中的到货
  const receipt = db.prepare(
    `INSERT INTO receipts(id, wh_id, sku_id, qty, original_qty, eta_at, original_eta_at,
       status, revision, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', 0, ?, ?, ?)`,
  );
  receipt.run('RC-301', 'WH-WH', 'SKU-B2', 40, 40, addDays(TODAY, 2), addDays(TODAY, 2), '工厂直发，数量待核', seeded, seeded);
  receipt.run('RC-302', 'WH-CD', 'SKU-K7', 30, 30, addDays(TODAY, 3), addDays(TODAY, 3), '成都补货批次', seeded, seeded);

  // 已发出的在途（预计到达前不计入在手，但计入规划口径的在途）
  db.prepare(
    `INSERT INTO transfers(id, sku_id, from_wh, to_wh, lane_id, qty, qty_arrived, status,
       departed_at, eta_at, original_eta_at, note)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'in_transit', ?, ?, ?, ?)`,
  ).run('TR-1001', 'SKU-K7', 'WH-SH', 'WH-GZ', 'L-SH-GZ', 15, addDays(TODAY, -1), addDays(TODAY, 2), addDays(TODAY, 2), '提前铺货');

  db.prepare(
    `INSERT INTO events(at, actor, kind, entity_type, entity_id, summary, detail_json)
     VALUES (?, '系统', 'seed', 'meta', 'demo', '已载入本地演示数据', '{}')`,
  ).run(seeded);
}

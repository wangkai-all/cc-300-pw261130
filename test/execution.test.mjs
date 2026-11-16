// 执行 / 部分执行后撤销剩余 / 订单取消 / 延误 / 恢复任务 / 回放。
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, reservationsOf } from './helpers.mjs';
import {
  createPlan, commitPlan, getPlan, executeAllocation, returnAllocation,
  cancelOrder, correctReceipt, delayTransfer, arriveTransfer, arriveReceipt,
  listRecovery, buildRecoveryPlan, dismissRecovery, stockAt, eventLog, previewPlan,
} from '../src/planning.mjs';

function officialPlan(db, objective = 'central', actor = '林薇') {
  const draft = createPlan(db, { name: `方案-${objective}`, objective, scope: {}, actor });
  return commitPlan(db, draft.id, { actor });
}

function allocFor(plan, demandId, source = null) {
  return plan.allocations.find((a) => a.demand_id === demandId && (!source || a.source_type === source));
}

test('部分执行后撤销剩余：库存只扣已执行部分，占用全部释放', () => {
  const { db, today } = freshDb();
  const plan = officialPlan(db);
  const alloc = allocFor(plan, 'SO-2601', 'local');
  assert.ok(alloc, '武汉 SO-2601 应有本地分配');
  const onHandBefore = stockAt(db, alloc.wh_id, alloc.sku_id, today);

  const part = 40;
  executeAllocation(db, alloc.id, { actor: '周航', qty: part, note: '先发一半' });

  let fresh = getPlan(db, plan.id);
  let row = fresh.allocations.find((a) => a.id === alloc.id);
  assert.equal(row.executed_qty, part);
  assert.equal(row.status, 'reserved', '未执行完仍是 reserved');
  assert.equal(stockAt(db, alloc.wh_id, alloc.sku_id, today), onHandBefore - part);
  const order = db.prepare("SELECT * FROM orders WHERE id = 'SO-2601'").get();
  assert.equal(order.qty_shipped, part);
  assert.equal(order.qty_open, 90 - part);
  assert.equal(order.status, 'open');

  const returned = returnAllocation(db, alloc.id, { actor: '周航', reason: '客户只要一半' });
  assert.equal(returned.returned, alloc.committed_qty - part);

  fresh = getPlan(db, plan.id);
  row = fresh.allocations.find((a) => a.id === alloc.id);
  assert.equal(row.executed_qty, part);
  assert.equal(row.returned_qty, alloc.committed_qty - part);
  assert.equal(row.status, 'returned');
  // 已执行部分不回滚
  assert.equal(stockAt(db, alloc.wh_id, alloc.sku_id, today), onHandBefore - part);
  // 该分配行的占用全部结清：已执行 40 + 已释放 50 = 90，没有悬挂的 held
  const own = reservationsOf(db, plan.id).filter((r) => r.alloc_id === alloc.id);
  assert.equal(own.filter((r) => r.state === 'held').length, 0);
  for (const r of own) {
    assert.equal(Number(r.executed_qty) + Number(r.released_qty), Number(r.qty));
  }
  // 其他分配行不受影响，仍在正常占用
  const others = reservationsOf(db, plan.id).filter((r) => r.alloc_id !== alloc.id && r.state === 'held');
  assert.ok(others.length > 0, '撤销一行不应释放其他行的占用');
});

test('只撤销一部分余量：占用按数量释放，剩余仍可继续执行', () => {
  const { db } = freshDb();
  const plan = officialPlan(db);
  const alloc = allocFor(plan, 'SO-2601', 'local');
  const committed = alloc.committed_qty;

  const heldBefore = previewPlan(db, { objective: 'central' }).snapshot.availability
    .find((x) => x.wh_id === 'WH-WH' && x.sku_id === 'SKU-K7').reservedToday;
  returnAllocation(db, alloc.id, { actor: '林薇', qty: 30, reason: '先让出 30 件' });
  let row = getPlan(db, plan.id).allocations.find((a) => a.id === alloc.id);
  assert.equal(row.returned_qty, 30);
  assert.equal(row.status, 'reserved');
  const stockRes = db.prepare(
    "SELECT * FROM reservations WHERE alloc_id = ? AND kind = 'stock'",
  ).get(alloc.id);
  assert.equal(Number(stockRes.released_qty), 30);
  assert.equal(stockRes.state, 'held');
  // 可承诺池只回补 30 件，不是整行
  const heldAfter = previewPlan(db, { objective: 'central' }).snapshot.availability
    .find((x) => x.wh_id === 'WH-WH' && x.sku_id === 'SKU-K7').reservedToday;
  assert.equal(heldBefore - heldAfter, 30);

  // 剩余部分仍可执行
  const rest = committed - 30;
  const out = executeAllocation(db, alloc.id, { actor: '林薇', qty: rest });
  assert.equal(out.executed, rest);
  row = getPlan(db, plan.id).allocations.find((a) => a.id === alloc.id);
  assert.equal(row.executed_qty, rest);
  assert.equal(row.status, 'executed');
  const after = db.prepare("SELECT * FROM reservations WHERE alloc_id = ? AND kind = 'stock'").get(alloc.id);
  assert.equal(after.state, 'executed');
  assert.equal(Number(after.executed_qty) + Number(after.released_qty), committed);
});

test('执行数量超过剩余会被拒绝', () => {
  const { db } = freshDb();
  const plan = officialPlan(db);
  const alloc = allocFor(plan, 'SO-2603', 'local');
  assert.throws(
    () => executeAllocation(db, alloc.id, { actor: '林薇', qty: alloc.committed_qty + 1 }),
    (e) => e.code === 'BAD_QTY',
  );
  assert.throws(
    () => executeAllocation(db, alloc.id, { actor: '林薇', qty: 0 }),
    (e) => e.code === 'BAD_QTY',
  );
});

test('全部执行后方案自动完成，占用转为 executed', () => {
  const { db } = freshDb();
  // 小范围：只做上海 K7，便于逐行执行
  const draft = createPlan(db, {
    name: '上海 K7', objective: 'central', actor: '林薇', scope: { skuIds: ['SKU-K7'], whIds: ['WH-SH'] },
  });
  const plan = commitPlan(db, draft.id, { actor: '林薇' });
  const rows = plan.allocations.filter((a) => a.source_type !== 'unmet');
  for (const a of rows) executeAllocation(db, a.id, { actor: '林薇' });
  const after = getPlan(db, plan.id);
  assert.equal(after.status, 'completed');
  assert.ok(after.events.some((e) => e.kind === 'completed'));
  const held = reservationsOf(db, plan.id).filter((r) => r.state === 'held');
  assert.equal(held.length, 0);
  // 已执行的数量可追溯到库存流水
  const ships = db.prepare(
    "SELECT COUNT(*) AS n FROM stock_events WHERE kind = 'ship' AND ref LIKE ?",
  ).get(`${plan.id}/%`).n;
  assert.ok(ships > 0);
});

test('订单取消释放占用并生成恢复任务', () => {
  const { db } = freshDb();
  const plan = officialPlan(db);
  const before = db.prepare(
    "SELECT COUNT(*) AS n FROM reservations WHERE plan_id = ? AND state = 'held' AND kind <> 'demand'",
  ).get(plan.id).n;
  assert.ok(before > 0);
  cancelOrder(db, 'SO-2601', { actor: '周航', reason: '客户撤单' });
  const held = db.prepare(
    "SELECT COUNT(*) AS n FROM reservations WHERE plan_id = ? AND state = 'held' AND kind <> 'demand' AND demand_id = 'SO-2601'",
  ).get(plan.id).n;
  assert.equal(held, 0);
  const lapsed = db.prepare(
    "SELECT COUNT(*) AS n FROM reservations WHERE plan_id = ? AND demand_id = 'SO-2601' AND state = 'lapsed'",
  ).get(plan.id).n;
  assert.ok(lapsed > 0);
  const tasks = listRecovery(db);
  assert.ok(tasks.some((t) => t.kind === 'reallocate' && t.demand_id === 'SO-2601'));
  // 取消后不能再执行该订单的分配
  const alloc = allocFor(getPlan(db, plan.id), 'SO-2601', 'local');
  assert.throws(
    () => executeAllocation(db, alloc.id, { actor: '周航' }),
    (e) => ['ORDER_CANCELLED', 'ALREADY_RELEASED'].includes(e.code),
  );
});

test('到货更正不会静默改方案：标记过期并生成复核任务', () => {
  const { db } = freshDb();
  const plan = officialPlan(db);
  correctReceipt(db, 'RC-301', { actor: '赵启明', qty: 10, reason: '供应商只发 10 件' });
  const after = getPlan(db, plan.id);
  assert.ok(after.stale_reason, '受影响正式方案应标记依据已变');
  assert.ok(after.events.some((e) => e.kind === 'basis_changed'));
  const tasks = listRecovery(db);
  assert.ok(tasks.some((t) => t.kind === 'review' && t.suggestion.receiptId === 'RC-301'));
  // 占用维持原样，由人工复核决定是否撤销
  assert.ok(reservationsOf(db, plan.id).some((r) => r.state === 'held'));
});

test('在途延误：ETA 推后、逾期罚金重算、生成恢复任务', () => {
  const { db } = freshDb();
  const before = db.prepare("SELECT * FROM transfers WHERE id = 'TR-1001'").get();
  const out = delayTransfer(db, 'TR-1001', { actor: '周航', delayDays: 3, reason: '暴雨封路' });
  assert.equal(out.delay_days, 3);
  assert.ok(out.eta_at > before.eta_at);
  assert.equal(out.original_eta_at, before.original_eta_at);
  const task = listRecovery(db).find((t) => t.transfer_id === 'TR-1001');
  assert.ok(task, '延误应生成恢复任务');
  assert.equal(task.suggestion.delayDays, 3);
});

test('调拨执行 -> 到达 -> 交付：在途、目的仓库存、订单核销都对上', () => {
  const { db, today } = freshDb();
  const plan = officialPlan(db);
  const alloc = allocFor(plan, 'SO-2605', 'transfer');
  assert.ok(alloc, '广州 SO-2605 应有武汉调拨');
  const fromBefore = stockAt(db, alloc.from_wh, alloc.sku_id, today);
  const toBefore = stockAt(db, alloc.wh_id, alloc.sku_id, today);

  executeAllocation(db, alloc.id, { actor: '林薇', note: '调拨发出' });
  const tr = db.prepare('SELECT * FROM transfers WHERE allocation_id = ?').get(alloc.id);
  assert.ok(tr, '应生成在途记录');
  assert.equal(tr.status, 'in_transit');
  assert.equal(tr.qty, alloc.qty);
  assert.equal(stockAt(db, alloc.from_wh, alloc.sku_id, today), fromBefore - alloc.qty);
  assert.equal(stockAt(db, alloc.wh_id, alloc.sku_id, today), toBefore);

  arriveTransfer(db, tr.id, { actor: '周航', at: `${tr.eta_at.slice(0, 10)}T09:00:00.000Z` });
  const arrived = db.prepare('SELECT * FROM transfers WHERE id = ?').get(tr.id);
  assert.equal(arrived.status, 'arrived');
  assert.equal(arrived.qty_arrived, alloc.qty);
  const toAfter = stockAt(db, alloc.wh_id, alloc.sku_id, tr.eta_at);
  assert.equal(toAfter, toBefore + alloc.qty - Math.min(alloc.qty, 40), '到达入账后立即交付给客户');
  const order = db.prepare("SELECT * FROM orders WHERE id = 'SO-2605'").get();
  assert.ok(order.qty_shipped >= alloc.qty);
});

test('延误的调拨到达后，分配行的到达日与逾期罚金同步更新', () => {
  const { db } = freshDb();
  const plan = officialPlan(db);
  const alloc = allocFor(plan, 'SO-2605', 'transfer');
  executeAllocation(db, alloc.id, { actor: '林薇' });
  const tr = db.prepare('SELECT * FROM transfers WHERE allocation_id = ?').get(alloc.id);
  const dueAt = db.prepare("SELECT due_at FROM orders WHERE id = 'SO-2605'").get().due_at;
  // 延误到 11-25，超过 11-23 的到期日，才能验证逾期罚金真的重算
  const daysLate = 7;
  delayTransfer(db, tr.id, { actor: '周航', delayDays: daysLate, reason: '车辆故障' });
  const row = db.prepare('SELECT * FROM allocations WHERE id = ?').get(alloc.id);
  assert.ok(row.arrival_date > tr.eta_at.slice(0, 10));
  const expectedLate = new Date(`${row.arrival_date}T00:00:00.000Z`) > new Date(`${dueAt}T00:00:00.000Z`)
    ? Math.round((new Date(`${row.arrival_date}T00:00:00.000Z`) - new Date(`${dueAt}T00:00:00.000Z`)) / 86400000)
    : 0;
  assert.ok(expectedLate > 0, '这次延误应当造成逾期');
  assert.equal(row.late_days, expectedLate);
  assert.ok(row.late_penalty > 0);
  assert.equal(row.total_cost, row.fixed_cost + row.unit_freight * row.qty + row.unit_handling * row.qty + row.late_penalty + row.shortage_cost);
  // 方案汇总指标同步反映新的逾期罚金，而不是停留在转正式时的数字
  const planAfter = getPlan(db, plan.id);
  const lateSum = planAfter.allocations.reduce((n, a) => n + Number(a.late_penalty), 0);
  assert.equal(planAfter.metrics.cost.late, Math.round(lateSum * 100) / 100);
  assert.equal(planAfter.metrics.cost.total, planAfter.allocations.reduce((n, a) => n + Number(a.total_cost), 0));
});

test('恢复任务可以生成恢复方案，也可以人工关闭', () => {
  const { db } = freshDb();
  const plan = officialPlan(db);
  cancelOrder(db, 'SO-2601', { actor: '周航', reason: '客户撤单' });
  const tasks = listRecovery(db).filter((t) => t.status === 'open');
  assert.ok(tasks.length >= 1);
  const realloc = tasks.find((t) => t.kind === 'reallocate');
  const recoveryPlan = buildRecoveryPlan(db, realloc.id, { actor: '林薇' });
  assert.equal(recoveryPlan.status, 'draft');
  assert.ok(recoveryPlan.name.includes(realloc.id));
  const after = listRecovery(db).find((t) => t.id === realloc.id);
  assert.equal(after.status, 'resolved');
  const other = tasks.find((t) => t.id !== realloc.id);
  if (other) {
    const dismissed = dismissRecovery(db, other.id, { actor: '林薇', resolution: '人工确认无需处理' });
    assert.equal(dismissed.status, 'dismissed');
  }
  // 已处理的任务不能再次处理
  assert.throws(() => buildRecoveryPlan(db, realloc.id, { actor: '林薇' }), (e) => e.code === 'TASK_CLOSED');
  // 方案与占用本身不被恢复流程破坏
  assert.equal(getPlan(db, plan.id).status, 'official');
});

test('执行与撤销都写入回放事件，顺序可追溯', () => {
  const { db } = freshDb();
  const plan = officialPlan(db);
  const alloc = allocFor(plan, 'SO-2602', 'local');
  executeAllocation(db, alloc.id, { actor: '林薇', qty: 10 });
  returnAllocation(db, alloc.id, { actor: '周航', reason: '余量转给武汉' });
  const events = eventLog(db, 50).map((e) => e.kind);
  assert.ok(events.includes('allocation.executed'));
  assert.ok(events.includes('allocation.returned'));
  const executions = db.prepare('SELECT * FROM executions WHERE plan_id = ? ORDER BY id').all(plan.id);
  assert.deepEqual(executions.map((e) => e.action), ['execute', 'return']);
  assert.equal(executions[0].qty, 10);
});

test('到货登记后 receipt 状态为 arrived，不能重复登记', () => {
  const { db } = freshDb();
  arriveReceipt(db, 'RC-302', { actor: '周航' });
  assert.throws(() => arriveReceipt(db, 'RC-302', { actor: '周航' }), (e) => e.code === 'ALREADY_ARRIVED');
});

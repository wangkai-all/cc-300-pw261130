// 占用确认：两名计划员争同一批货、依据过期、乐观并发。
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, reservationsOf } from './helpers.mjs';
import {
  previewPlan, createPlan, commitPlan, refreshPlan, revokePlan, getPlan,
  correctReceipt, arriveReceipt, cancelOrder, PlanError,
} from '../src/planning.mjs';

function makePlan(db, objective, name, actor) {
  return createPlan(db, {
    name, objective, scope: {}, actor,
  });
}

test('草稿保存不改库存、不产生占用', () => {
  const { db } = freshDb();
  const events = db.prepare('SELECT COUNT(*) AS n FROM stock_events').get().n;
  const plan = makePlan(db, 'central', '方案 A', '林薇');
  assert.equal(plan.status, 'draft');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_events').get().n, events);
  assert.ok(plan.allocations.length > 0);
});

test('转正式会写占用：库存 / 线路 / 需求三类槽位', () => {
  const { db } = freshDb();
  const plan = makePlan(db, 'central', '方案 A', '林薇');
  const committed = commitPlan(db, plan.id, { actor: '林薇' });
  assert.equal(committed.status, 'official');
  assert.equal(committed.facts_hash, plan.facts_hash);
  const kinds = new Set(reservationsOf(db, plan.id).map((r) => r.kind));
  assert.deepEqual([...kinds].sort(), ['demand', 'lane', 'stock']);
  const stock = reservationsOf(db, plan.id, 'stock');
  assert.ok(stock.length > 0);
  for (const r of stock) {
    assert.ok(Number(r.qty) > 0);
    assert.equal(r.state, 'held');
    assert.equal(Number(r.executed_qty), 0);
  }
  // 缺货行不占资源
  const unmetIds = new Set(plan.allocations.filter((a) => a.source_type === 'unmet').map((a) => a.id));
  assert.equal(stock.filter((r) => unmetIds.has(r.alloc_id)).length, 0);
});

test('第二名计划员争用同一批货：转正式被拒绝且不写入任何占用', () => {
  const { db } = freshDb();
  // 两人在彼此占用之前各自保存：两张草稿都以为自己能拿到同一批上海 K7
  const a = makePlan(db, 'central', '林薇的方案', '林薇');
  const b = makePlan(db, 'phased', '赵启明的方案', '赵启明');
  commitPlan(db, a.id, { actor: '林薇' });
  let err = null;
  try {
    commitPlan(db, b.id, { actor: '赵启明' });
  } catch (e) {
    err = e;
  }
  assert.ok(err, '第二张方案应被拒绝');
  assert.ok(err instanceof PlanError);
  assert.equal(err.code, 'OVERCOMMIT');
  assert.equal(err.status, 409);
  assert.ok(err.detail.conflicts.length > 0);
  for (const c of err.detail.conflicts) {
    assert.ok(['stock', 'lane', 'demand'].includes(c.kind));
    assert.ok(c.message.length > 10);
    assert.ok(c.requested > 0);
  }
  assert.equal(getPlan(db, b.id).status, 'draft');
  // 被拒绝的方案没有留下任何占用；先转正式的方案占用不被改动
  assert.equal(reservationsOf(db, b.id).length, 0);
  assert.equal(reservationsOf(db, a.id).every((r) => r.state === 'held'), true);
});

test('被拒绝后刷新草稿，只按剩余资源重算，并可转正式', () => {
  const { db } = freshDb();
  // 两名计划员在彼此占用之前各自保存草稿，随后先后转正式
  const a = makePlan(db, 'central', 'A', '林薇');
  const b = makePlan(db, 'phased', 'B', '赵启明');
  commitPlan(db, a.id, { actor: '林薇' });
  assert.throws(() => commitPlan(db, b.id, { actor: '赵启明' }), (e) => e.code === 'OVERCOMMIT');
  const refreshed = refreshPlan(db, b.id, { actor: '赵启明' });
  assert.equal(refreshed.status, 'draft');
  assert.ok(refreshed.row_version > b.row_version);
  // 同一订单不再重复承诺：B 的分配量不能超过 A 承诺后的剩余需求
  const aPromised = new Map();
  for (const r of reservationsOf(db, a.id, 'demand')) {
    aPromised.set(r.demand_id, (aPromised.get(r.demand_id) ?? 0) + Number(r.qty));
  }
  const orderQty = new Map(
    db.prepare('SELECT id, qty_open FROM orders').all().map((o) => [o.id, Number(o.qty_open)]),
  );
  const byDemand = new Map();
  for (const alloc of refreshed.allocations) {
    byDemand.set(alloc.demand_id, (byDemand.get(alloc.demand_id) ?? 0) + alloc.qty);
  }
  for (const [id, qty] of byDemand) {
    const original = (orderQty.get(id) ?? 0) + (aPromised.get(id) ?? 0);
    assert.ok(qty <= original + 1e-6, `${id} 重算后分配 ${qty} 超过原需求 ${original}`);
  }
  const committed = commitPlan(db, b.id, { actor: '赵启明' });
  assert.equal(committed.status, 'official');
});

test('到货更正导致依据过期：转正式被拒绝并记录原因', () => {
  const { db } = freshDb();
  const plan = makePlan(db, 'central', '方案 A', '林薇');
  correctReceipt(db, 'RC-302', { actor: '赵启明', qty: 0, reason: '供应商缺货' });
  let err = null;
  try { commitPlan(db, plan.id, { actor: '林薇' }); } catch (e) { err = e; }
  assert.ok(err, '依据变化后必须拒绝转正式');
  assert.equal(err.code, 'PLAN_STALE');
  assert.equal(err.status, 409);
  assert.ok(err.detail.drift.changed);
  const after = getPlan(db, plan.id);
  assert.equal(after.status, 'draft');
  assert.ok(after.stale_reason, '应记录过期原因');
  assert.ok(after.events.some((e) => e.kind === 'commit_rejected'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n, 0);
});

test('订单取消导致依据过期；刷新后不再为该订单分配', () => {
  const { db } = freshDb();
  const plan = makePlan(db, 'central', '方案 A', '林薇');
  cancelOrder(db, 'SO-2601', { actor: '周航', reason: '客户撤单' });
  assert.throws(() => commitPlan(db, plan.id, { actor: '林薇' }), (e) => e.code === 'PLAN_STALE');
  const refreshed = refreshPlan(db, plan.id, { actor: '林薇' });
  assert.equal(refreshed.allocations.filter((a) => a.demand_id === 'SO-2601').length, 0);
  assert.equal(commitPlan(db, plan.id, { actor: '林薇' }).status, 'official');
});

test('乐观并发：行版本不一致时拒绝确认', () => {
  const { db } = freshDb();
  const plan = makePlan(db, 'central', '方案 A', '林薇');
  assert.throws(
    () => commitPlan(db, plan.id, { actor: '赵启明', expectedRowVersion: plan.row_version + 5 }),
    (e) => e.code === 'STALE_PLAN',
  );
  const ok = commitPlan(db, plan.id, { actor: '林薇', expectedRowVersion: plan.row_version });
  assert.equal(ok.status, 'official');
});

test('正式方案不能再次转正式或刷新；撤销后释放未执行占用', () => {
  const { db } = freshDb();
  const plan = makePlan(db, 'central', '方案 A', '林薇');
  commitPlan(db, plan.id, { actor: '林薇' });
  assert.throws(() => commitPlan(db, plan.id, { actor: '林薇' }), (e) => e.code === 'BAD_STATUS');
  assert.throws(() => refreshPlan(db, plan.id, { actor: '林薇' }), (e) => e.code === 'BAD_STATUS');
  const revoked = revokePlan(db, plan.id, { actor: '林薇', reason: '改走别的方案' });
  assert.equal(revoked.status, 'revoked');
  const held = db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE plan_id = ? AND state = 'held'").get(plan.id).n;
  assert.equal(held, 0);
  // 撤销后资源回到可承诺池：另一张方案可以完整转正式
  const other = makePlan(db, 'central', '方案 B', '赵启明');
  assert.equal(commitPlan(db, other.id, { actor: '赵启明' }).status, 'official');
});

test('到货登记写入库存流水，之后方案可看到更多可用量', () => {
  const { db } = freshDb();
  const before = previewPlan(db, { objective: 'central' });
  arriveReceipt(db, 'RC-301', { actor: '周航', at: '2026-11-16T10:00:00.000Z' });
  const after = previewPlan(db, { objective: 'central' });
  const whB2Before = before.allocations
    .filter((a) => a.demand_id === 'SO-2606' && a.source_type === 'unmet')
    .reduce((n, a) => n + a.qty, 0);
  const whB2After = after.allocations
    .filter((a) => a.demand_id === 'SO-2606' && a.source_type === 'unmet')
    .reduce((n, a) => n + a.qty, 0);
  assert.ok(whB2After <= whB2Before, '到货后武汉 B2 的缺口不应变大');
  const row = db.prepare("SELECT * FROM receipts WHERE id = 'RC-301'").get();
  assert.equal(row.status, 'arrived');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM stock_events WHERE kind = 'receipt' AND ref = 'RC-301'").get().n, 1);
});

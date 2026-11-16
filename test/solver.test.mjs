// 求解口径：集中 vs 分阶段，以及"局部便宜造成别处断货"的取舍。
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, planAlloc, sumQty } from './helpers.mjs';
import { previewPlan } from '../src/planning.mjs';
import { computePlan, comparePlans } from '../src/solver.mjs';

test('试算不写入任何库存流水或占用', () => {
  const { db } = freshDb();
  const before = db.prepare('SELECT COUNT(*) AS n FROM stock_events').get().n;
  const central = previewPlan(db, { objective: 'central' });
  const phased = previewPlan(db, { objective: 'phased' });
  assert.ok(central.allocations.length > 0);
  assert.ok(phased.allocations.length > 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_events').get().n, before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plans').get().n, 0);
});

test('试算结果稳定：同一事实两次试算一致', () => {
  const { db } = freshDb();
  const a = previewPlan(db, { objective: 'central' });
  const b = previewPlan(db, { objective: 'central' });
  assert.equal(a.metrics.cost.total, b.metrics.cost.total);
  assert.equal(a.metrics.shortageQty, b.metrics.shortageQty);
  assert.deepEqual(
    a.allocations.map((x) => [x.demand_id, x.source_type, x.qty]),
    b.allocations.map((x) => [x.demand_id, x.source_type, x.qty]),
  );
});

test('集中求解：每张订单的分配量不超过其未满足量（不缺不超）', () => {
  const { db } = freshDb();
  const result = previewPlan(db, { objective: 'central' });
  const demand = new Map(result.orders.map((o) => [o.id, Number(o.qty_open)]));
  const allocated = new Map();
  for (const a of result.allocations) {
    allocated.set(a.demand_id, (allocated.get(a.demand_id) ?? 0) + Number(a.qty));
  }
  for (const [id, qty] of allocated) {
    assert.ok(qty <= (demand.get(id) ?? 0) + 1e-6, `${id} 分配 ${qty} 超过需求 ${demand.get(id)}`);
  }
  assert.equal(sumQty(result.allocations), result.metrics.demandQty);
});

test('集中求解：今日从同一仓库发出的量不超过今日可承诺库存', () => {
  const { db, today } = freshDb();
  const result = previewPlan(db, { objective: 'central' });
  const cap = new Map(result.snapshot.availability.map((a) => [`${a.wh_id}|${a.sku_id}`, a.free]));
  const used = new Map();
  for (const a of result.allocations) {
    if (a.source_type === 'unmet' || a.depart_date !== result.orders[0]?.__today) continue;
    const from = a.source_type === 'local' ? a.wh_id : a.from_wh;
    const k = `${from}|${a.sku_id}`;
    used.set(k, (used.get(k) ?? 0) + Number(a.qty));
  }
  for (const [k, qty] of used) {
    assert.ok(qty <= (cap.get(k) ?? 0) + 1e-6, `${k} 用了 ${qty}，可承诺 ${cap.get(k)}`);
  }
});

test('两种口径都算缺货成本与调拨时效，且总成本 = 各项之和', () => {
  const { db } = freshDb();
  for (const objective of ['central', 'phased']) {
    const r = previewPlan(db, { objective });
    const c = r.metrics.cost;
    assert.equal(
      c.total,
      Math.round((c.freight + c.handling + c.late + c.shortage) * 100) / 100,
      `${objective} 成本分解不闭合`,
    );
    assert.ok(c.shortage > 0, 'seed 数据应当存在缺货成本');
    for (const a of r.allocations) {
      assert.ok(a.reserve_date, '每条分配都应有承诺/占用日');
      if (a.source_type === 'unmet') {
        assert.equal(a.arrival_date, null, '缺货行没有到货日');
        assert.ok(a.shortage_cost > 0, '缺货行要计入缺货成本');
        continue;
      }
      assert.ok(a.arrival_date, '每条有货的分配都应有到达日（时效）');
      if (a.source_type === 'transfer') {
        assert.ok(a.arrival_date > a.depart_date, '调拨的到达日必须晚于发运日');
      }
    }
  }
});

test('集中口径总成本不高于分阶段，且分阶段把缺口转移到高缺货成本订单', () => {
  const { db } = freshDb();
  const central = previewPlan(db, { objective: 'central' });
  const phased = previewPlan(db, { objective: 'phased' });
  assert.ok(
    central.metrics.cost.total <= phased.metrics.cost.total,
    `集中 ${central.metrics.cost.total} 应 <= 分阶段 ${phased.metrics.cost.total}`,
  );
  // 分阶段运费更低，"局部便宜"确实存在
  assert.ok(phased.metrics.cost.freight < central.metrics.cost.freight);

  const cmp = comparePlans(central, phased, { orders: central.orders });
  assert.ok(cmp.rows.length > 0);
  assert.ok(cmp.narrative.length >= 2, '对比需要给出取舍说明');

  // 武汉 SO-2601（缺货成本 40/件）在分阶段里被挤掉，缺口更大
  const wh = cmp.rows.find((r) => r.demandId === 'SO-2601');
  assert.ok(wh, '对比应包含 SO-2601');
  assert.ok(wh.shortageB > wh.shortageA, '分阶段应让武汉订单缺口更大');
  assert.ok(wh.shortageB > 0);
  assert.ok(wh.delta > 0, '分阶段下该订单成本更高');
  assert.ok(cmp.narrative.some((line) => line.includes('缺货')), '说明里要点出缺货代价');
});

test('缺货成本高的订单在集中口径下优先拿到本地库存', () => {
  const { db } = freshDb();
  const central = previewPlan(db, { objective: 'central' });
  const phased = previewPlan(db, { objective: 'phased' });
  const centralWhLocal = sumQty(planAlloc(central, 'SO-2601', { source: 'local' }));
  const phasedWhLocal = sumQty(planAlloc(phased, 'SO-2601', { source: 'local' }));
  assert.ok(centralWhLocal > phasedWhLocal, '集中应给武汉关键单更多本地库存');
  assert.equal(centralWhLocal, 90);
});

test('无订单时试算报错，允许空方案时返回空结构', () => {
  const { db } = freshDb();
  db.exec("UPDATE orders SET status = 'cancelled'");
  assert.throws(() => previewPlan(db, { objective: 'central' }), /没有未满足的订单/);
  const empty = previewPlan(db, { objective: 'central', allowEmpty: true });
  assert.equal(empty.allocations.length, 0);
  assert.equal(empty.metrics.demandQty, 0);
});

test('求解器可以脱离数据库单独调用', () => {
  const input = {
    today: '2026-01-05',
    orders: [
      { id: 'O-1', wh_id: 'A', sku_id: 'S', qty_open: 10, due_at: '2026-01-06', shortage_cost_per_unit: 100, late_penalty_per_unit_day: 1 },
      { id: 'O-2', wh_id: 'B', sku_id: 'S', qty_open: 10, due_at: '2026-01-08', shortage_cost_per_unit: 5, late_penalty_per_unit_day: 1 },
    ],
    availability: ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'].flatMap((day) => [
      { wh_id: 'A', sku_id: 'S', day, qty: 10 },
      { wh_id: 'B', sku_id: 'S', day, qty: 0 },
    ]),
    lanes: [
      { id: 'L-A-B', from_wh: 'A', to_wh: 'B', transit_days: 1, base_cost: 10, per_unit_cost: 1, capacity_per_day: 100 },
    ],
    skus: [{ id: 'S', name: 'S', unit: 'ea', local_handling_cost: 0 }],
  };
  const central = computePlan(input, { objective: 'central' });
  assert.equal(central.metrics.shortageQty, 10);
  const a1 = central.allocations.filter((a) => a.demand_id === 'O-1');
  assert.equal(sumQty(a1), 10, '高缺货成本订单应拿满 A 仓库存');
  const o2 = central.allocations.filter((a) => a.demand_id === 'O-2');
  assert.equal(sumQty(o2.filter((a) => a.source_type === 'unmet')), 10);
});

var test = require('node:test');
var assert = require('node:assert/strict');

var pricing = require('../lib/pricing');
var orders = require('../lib/orders');
var invoice = require('../lib/invoice');
var reports = require('../lib/reports');

function billedOrder(items, coupon) {
  var db = { nextOrderId: 1001, orders: [], products: [], customers: [] };
  var totals = pricing.computeTotals(items, coupon || '');
  var order = orders.add(db, {
    date: '2026-01-02',
    items: items,
    coupon: coupon || '',
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total
  });
  return { db: db, totals: totals, order: order };
}

test('18% item without coupon has matching billed and invoice figures', function () {
  var sale = billedOrder([{ id: 1, name: 'Tea', hsn: '0902', price: 100, qty: 2 }]);

  assert.deepEqual(invoice.computeInvoiceFigures(sale.order), {
    subtotal: 200,
    discount: 0,
    tax: 36,
    cgst: 18,
    sgst: 18,
    total: 236,
    rows: [{ name: 'Tea', sku: '-', hsn: '0902', qty: 2, price: 100, gstPercent: 18, line: 200, lineTax: 36 }]
  });
  assert.equal(sale.order.total, 236);
  assert.equal(reports.getGstReconciliation(sale.db).rows[0].matched, true);
  assert.doesNotMatch(invoice.render(sale.order), /Accountant Reconciliation Notice:/);
});

test('invoice and GST reconciliation match the billed HSN and coupon totals', function () {
  var sale = billedOrder([{ id: 2, name: 'Rice', hsn: '1006', price: 1000, qty: 1 }], 'WELCOME');
  var figures = invoice.computeInvoiceFigures(sale.order);
  var html = invoice.render(sale.order);

  assert.deepEqual({ discount: figures.discount, tax: figures.tax, total: figures.total },
    { discount: 50, tax: 47.5, total: 997.5 });
  assert.deepEqual({ gstPercent: figures.rows[0].gstPercent, lineTax: figures.rows[0].lineTax },
    { gstPercent: 5, lineTax: 47.5 });
  assert.match(html, /<td class="r">5%<\/td>/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹997\.50/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice:/);
  assert.equal(reports.getGstReconciliation(sale.db).rows[0].matched, true);
});

test('mixed GST slabs use the capped coupon on each invoice line', function () {
  var sale = billedOrder([
    { id: 1, name: 'Oil', hsn: '1508', price: 1000, qty: 1 },
    { id: 2, name: 'Ghee', hsn: '0405', price: 500, qty: 1 },
    { id: 3, name: 'Tea', hsn: '0902', price: 500, qty: 1 }
  ], 'SAVE10');
  var figures = invoice.computeInvoiceFigures(sale.order);

  assert.deepEqual({ discount: figures.discount, tax: figures.tax, total: figures.total },
    { discount: 150, tax: 185, total: 2035 });
  assert.deepEqual(figures.rows.map(function (row) {
    return { gstPercent: row.gstPercent, lineTax: row.lineTax };
  }), [
    { gstPercent: 5, lineTax: 46.25 },
    { gstPercent: 12, lineTax: 55.5 },
    { gstPercent: 18, lineTax: 83.25 }
  ]);
  assert.equal(reports.getGstReconciliation(sale.db).mismatchCount, 0);
});

test('invoice uses the billed HSN 5% slab', function () {
  var sale = billedOrder([{ id: 2, name: 'Rice', hsn: '1006', price: 1000, qty: 1 }]);
  var figures = invoice.computeInvoiceFigures(sale.order);
  var html = invoice.render(sale.order);

  assert.deepEqual({ tax: sale.order.tax, total: sale.order.total }, { tax: 50, total: 1050 });
  assert.deepEqual({ tax: figures.tax, cgst: figures.cgst, sgst: figures.sgst, total: figures.total },
    { tax: 50, cgst: 25, sgst: 25, total: 1050 });
  assert.equal(figures.rows[0].gstPercent, 5);
  assert.match(html, /<td class="r">5%<\/td>/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹1050\.00/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice:/);
  assert.deepEqual(reports.getGstReconciliation(sale.db).rows[0], {
    orderId: 1001, date: '2026-01-02', customer: 'Walk-in', coupon: '',
    ledgerSubtotal: 1000, ledgerDiscount: 0, ledgerTax: 50, ledgerTotal: 1050,
    invoiceDiscount: 0, invoiceTax: 50, invoiceTotal: 1050, delta: 0, matched: true
  });
});

test('invoice applies a percent coupon before GST', function () {
  var sale = billedOrder([{ id: 2, name: 'Rice', hsn: '1006', price: 1000, qty: 1 }], 'WELCOME');
  var figures = invoice.computeInvoiceFigures(sale.order);

  assert.deepEqual({ discount: sale.order.discount, tax: sale.order.tax, total: sale.order.total },
    { discount: 50, tax: 47.5, total: 997.5 });
  assert.deepEqual({ discount: figures.discount, tax: figures.tax, total: figures.total },
    { discount: 50, tax: 47.5, total: 997.5 });
  assert.equal(reports.getGstReconciliation(sale.db).rows[0].delta, 0);
});

test('invoice respects the percent coupon maximum discount', function () {
  var sale = billedOrder([{ id: 1, name: 'Tea', hsn: '0902', price: 2000, qty: 1 }], 'SAVE10');
  var figures = invoice.computeInvoiceFigures(sale.order);

  assert.deepEqual({ discount: sale.order.discount, tax: sale.order.tax, total: sale.order.total },
    { discount: 150, tax: 333, total: 2183 });
  assert.deepEqual({ discount: figures.discount, tax: figures.tax, total: figures.total },
    { discount: 150, tax: 333, total: 2183 });
  assert.equal(reports.getGstReconciliation(sale.db).rows[0].delta, 0);
  assert.doesNotMatch(invoice.render(sale.order), /Accountant Reconciliation Notice:/);
});

test('invoice ignores a flat coupon below its minimum order', function () {
  var sale = billedOrder([{ id: 1, name: 'Tea', hsn: '0902', price: 200, qty: 1 }], 'FLAT50');
  var figures = invoice.computeInvoiceFigures(sale.order);

  assert.deepEqual({ discount: sale.order.discount, tax: sale.order.tax, total: sale.order.total },
    { discount: 0, tax: 36, total: 236 });
  assert.deepEqual({ discount: figures.discount, tax: figures.tax, total: figures.total },
    { discount: 0, tax: 36, total: 236 });
});

test('invoice ignores an inactive coupon present on an order', function () {
  var sale = billedOrder([{ id: 1, name: 'Tea', hsn: '0902', price: 1000, qty: 1 }], 'DIWALI20');
  var figures = invoice.computeInvoiceFigures(sale.order);

  assert.deepEqual({ discount: sale.order.discount, tax: sale.order.tax, total: sale.order.total },
    { discount: 0, tax: 180, total: 1180 });
  assert.deepEqual({ discount: figures.discount, tax: figures.tax, total: figures.total },
    { discount: 0, tax: 180, total: 1180 });
});

test('invoice preserves a billed coupon after the coupon expires', function () {
  var sale = billedOrder([{ id: 1, name: 'Tea', hsn: '0902', price: 1000, qty: 1 }]);
  sale.order.coupon = 'DIWALI20';
  sale.order.discount = 200;
  sale.order.tax = 144;
  sale.order.total = 944;

  var figures = invoice.computeInvoiceFigures(sale.order);
  assert.deepEqual({ discount: figures.discount, tax: figures.tax, total: figures.total, lineTax: figures.rows[0].lineTax },
    { discount: 200, tax: 144, total: 944, lineTax: 144 });
  assert.equal(reports.getGstReconciliation(sale.db).rows[0].matched, true);
  assert.doesNotMatch(invoice.render(sale.order), /Accountant Reconciliation Notice:/);
});

test('reconciliation counts a GST mismatch when totals agree', function () {
  var sale = billedOrder([{ id: 2, name: 'Rice', hsn: '1006', price: 1000, qty: 1 }]);
  sale.order.tax = 180;
  var recon = reports.getGstReconciliation(sale.db);

  assert.deepEqual({ totalChecked: recon.totalChecked, mismatchCount: recon.mismatchCount, totalDelta: recon.totalDelta },
    { totalChecked: 1, mismatchCount: 1, totalDelta: 0 });
  assert.deepEqual({ delta: recon.rows[0].delta, matched: recon.rows[0].matched },
    { delta: 0, matched: false });
  assert.doesNotMatch(invoice.render(sale.order), /Accountant Reconciliation Notice:/);
});

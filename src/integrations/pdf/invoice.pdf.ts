import PDFDocument from 'pdfkit';
import { maskPhone } from '../../utils';

/*
 * GST tax invoice / bill of supply as a real PDF. A4 for printing and email, "thermal" for 80 mm
 * receipt printers. The built-in Helvetica has no ₹ glyph, so amounts are written "Rs.".
 */

const rs = (paise: number) =>
  `Rs. ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;

const MODE_LABEL: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', wallet: 'Wallet' };
const STATUS_STAMP: Record<string, string> = {
  cancelled: 'CANCELLED',
  rejected: 'REJECTED',
  awaiting_approval: 'AWAITING APPROVAL',
  refunded: 'REFUNDED',
  partly_refunded: 'PARTLY REFUNDED',
};

function addressLine(a?: { line1?: string; line2?: string; city?: string; state?: string; pincode?: string }) {
  if (!a) return '';
  return [a.line1, a.line2, a.city, a.state && a.pincode ? `${a.state} ${a.pincode}` : a.state || a.pincode].filter(Boolean).join(', ');
}

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

export async function renderInvoicePdf(bill: any, business: any, branch: any, format: 'a4' | 'thermal' = 'a4'): Promise<Buffer> {
  return format === 'thermal' ? renderThermal(bill, business, branch) : renderA4(bill, business, branch);
}

async function renderA4(bill: any, business: any, branch: any): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Invoice ${bill.invoiceNo}`, Author: business?.name || 'Glox' } });
  const left = 40;
  const right = 555;
  const width = right - left;

  // Header: business, branch, GSTIN
  doc.font('Helvetica-Bold').fontSize(16).text(business?.name || 'Salon', left, 40);
  doc.font('Helvetica').fontSize(9).fillColor('#444');
  doc.text(`${branch?.name || ''} — ${addressLine(branch?.address)}`, { width: 330 });
  if (branch?.phone) doc.text(`Phone: ${branch.phone}`);
  if (bill.gstApplied && business?.gst?.gstin) doc.text(`GSTIN: ${business.gst.gstin}`);

  doc.font('Helvetica-Bold').fontSize(13).fillColor('#000').text(bill.gstApplied ? 'TAX INVOICE' : 'BILL OF SUPPLY', 370, 40, { width: 185, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor('#444');
  doc.text(`Invoice No: ${bill.invoiceNo}`, 370, doc.y + 2, { width: 185, align: 'right' });
  doc.text(`Date: ${bill.businessDate}`, 370, doc.y, { width: 185, align: 'right' });
  if (bill.gstApplied) doc.text(`SAC: ${bill.lines.find((l: any) => l.kind === 'service')?.hsnSac || '9983'}`, 370, doc.y, { width: 185, align: 'right' });

  // Customer block
  let y = Math.max(doc.y, 120) + 10;
  doc.moveTo(left, y).lineTo(right, y).strokeColor('#ccc').stroke();
  y += 8;
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(10).text('Bill to', left, y);
  doc.font('Helvetica').fontSize(9).text(bill.customerSnap?.name || 'Customer', left, doc.y + 1);
  if (bill.customerSnap?.phone) doc.text(maskPhone(bill.customerSnap.phone));
  doc.text(`Billed by: ${bill.billedByName || '—'}`, 370, y, { width: 185, align: 'right' });

  // Line items
  y = doc.y + 18;
  const cols = [
    { h: '#', w: 22, a: 'left' },
    { h: 'Item', w: 168, a: 'left' },
    { h: 'HSN/SAC', w: 52, a: 'left' },
    { h: 'Qty', w: 30, a: 'right' },
    { h: 'Rate', w: 66, a: 'right' },
    { h: 'Disc.', w: 55, a: 'right' },
    { h: bill.gstApplied ? 'GST' : '', w: 36, a: 'right' },
    { h: 'Amount', w: width - 429, a: 'right' },
  ] as const;
  const row = (cells: string[], bold = false) => {
    let x = left;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    const h = Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: cols[i].w - 4 })));
    cells.forEach((c, i) => {
      doc.text(c, x + 2, y, { width: cols[i].w - 4, align: cols[i].a });
      x += cols[i].w;
    });
    y += h + 6;
  };
  doc.rect(left, y - 4, width, 18).fill('#f3f3f3').fillColor('#000');
  row(cols.map((c) => c.h), true);
  bill.lines.forEach((l: any, i: number) => {
    const staff = (l.staff || []).map((st: any) => st.name).filter(Boolean).join(', ');
    row([
      String(i + 1),
      staff ? `${l.name}\n${staff}` : l.name,
      l.hsnSac || '',
      String(l.qty),
      rs(l.unitPricePaise),
      l.discountPaise ? rs(l.discountPaise) : '—',
      bill.gstApplied ? (l.gstBps ? pct(l.gstBps) : '—') : '',
      rs(l.totalPaise),
    ]);
  });
  doc.moveTo(left, y).lineTo(right, y).strokeColor('#ccc').stroke();

  // Totals
  y += 8;
  const t = bill.totals;
  const totalRow = (label: string, value: string, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9);
    doc.text(label, 330, y, { width: 125, align: 'right' });
    doc.text(value, 455, y, { width: 100, align: 'right' });
    y += bold ? 18 : 14;
  };
  totalRow('Gross', rs(t.grossPaise));
  if (t.discountPaise) totalRow('Discount', `- ${rs(t.discountPaise)}`);
  totalRow('Taxable value', rs(t.taxablePaise));
  if (bill.gstApplied) {
    const half = Math.round((business?.gst?.rateBps || 1800) / 2);
    totalRow(`CGST ${pct(half)}`, rs(t.cgstPaise));
    totalRow(`SGST ${pct(half)}`, rs(t.sgstPaise));
  }
  if (t.roundOffPaise) totalRow('Round off', rs(t.roundOffPaise));
  totalRow('Total', rs(t.totalPaise), true);
  if (t.totalTipsPaise) totalRow('Tips (not taxable)', rs(t.totalTipsPaise));

  // Payments, dues, refunds
  y += 4;
  doc.font('Helvetica-Bold').fontSize(9).text('Payments', left, y);
  y = doc.y + 2;
  doc.font('Helvetica').fontSize(9);
  for (const p of bill.payments || []) {
    doc.text(`${MODE_LABEL[p.mode] || p.mode}${p.ref ? ` (${p.ref})` : ''}: ${rs(p.amountPaise)}`, left, y);
    y = doc.y;
  }
  if (t.duePaise) doc.font('Helvetica-Bold').text(`Balance due: ${rs(t.duePaise)}`, left, y + 2);
  for (const r of bill.refunds || []) {
    doc.font('Helvetica').text(`Refund ${r.businessDate} (${MODE_LABEL[r.mode] || r.mode}): ${rs(r.amountPaise)}`, left, doc.y + 2);
  }

  // Status stamp for cancelled / unapproved / refunded bills
  const stamp = STATUS_STAMP[bill.status];
  if (stamp) {
    doc.save().rotate(-30, { origin: [300, 420] }).font('Helvetica-Bold').fontSize(54).fillColor('#d33', 0.18).text(stamp, 60, 400, { width: 480, align: 'center' }).restore();
  }

  doc.fillColor('#666').font('Helvetica').fontSize(8).text('Thank you for visiting. This is a computer-generated invoice.', left, 790, { width, align: 'center' });
  return collect(doc);
}

async function renderThermal(bill: any, business: any, branch: any): Promise<Buffer> {
  // 80 mm paper ≈ 226 pt wide; height grows with the number of lines
  const height = 360 + bill.lines.length * 30 + (bill.payments?.length || 0) * 12;
  const doc = new PDFDocument({ size: [226, height], margins: { top: 10, left: 10, right: 10, bottom: 10 } });
  const w = 206;
  const center = (text: string, size = 8, bold = false) =>
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).text(text, 10, doc.y, { width: w, align: 'center' });
  const pair = (l: string, r: string, bold = false) => {
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 9 : 7.5);
    doc.text(l, 10, y, { width: 130 });
    doc.text(r, 140, y, { width: 76, align: 'right' });
  };
  const rule = () => doc.moveTo(10, doc.y + 2).lineTo(216, doc.y + 2).dash(1, { space: 2 }).stroke().undash().moveDown(0.4);

  center(business?.name || 'Salon', 11, true);
  center(`${branch?.name || ''}, ${branch?.address?.city || ''}`);
  if (bill.gstApplied && business?.gst?.gstin) center(`GSTIN ${business.gst.gstin}`);
  center(bill.gstApplied ? 'TAX INVOICE' : 'BILL OF SUPPLY', 8, true);
  rule();
  pair(bill.invoiceNo, bill.businessDate);
  pair(bill.customerSnap?.name || 'Customer', bill.customerSnap?.phone ? maskPhone(bill.customerSnap.phone) : '');
  rule();
  for (const l of bill.lines) {
    pair(`${l.name} × ${l.qty}`, rs(l.totalPaise));
    if (l.discountPaise) pair('  discount', `- ${rs(l.discountPaise)}`);
  }
  rule();
  const t = bill.totals;
  pair('Taxable', rs(t.taxablePaise));
  if (bill.gstApplied) {
    pair('CGST', rs(t.cgstPaise));
    pair('SGST', rs(t.sgstPaise));
  }
  if (t.roundOffPaise) pair('Round off', rs(t.roundOffPaise));
  pair('TOTAL', rs(t.totalPaise), true);
  if (t.totalTipsPaise) pair('Tips', rs(t.totalTipsPaise));
  for (const p of bill.payments || []) pair(MODE_LABEL[p.mode] || p.mode, rs(p.amountPaise));
  if (t.duePaise) pair('Balance due', rs(t.duePaise), true);
  if (STATUS_STAMP[bill.status]) {
    rule();
    center(STATUS_STAMP[bill.status], 10, true);
  }
  rule();
  center(`Billed by ${bill.billedByName || '—'}. Thank you!`, 7);
  return collect(doc);
}

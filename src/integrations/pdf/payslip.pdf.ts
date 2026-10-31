import PDFDocument from 'pdfkit';

/*
 * Monthly payslip PDF (A4). Built-in Helvetica has no ₹ glyph, so amounts are written "Rs.".
 */

const rs = (paise: number) =>
  `Rs. ${((paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

const DESIGNATION: Record<string, string> = {
  stylist: 'Stylist',
  senior_stylist: 'Senior Stylist',
  beautician: 'Beautician',
  receptionist: 'Receptionist',
  manager: 'Manager',
  helper: 'Helper',
  other: 'Staff',
};

export interface PayslipPdfData {
  business?: { name?: string; address?: any };
  branch?: { name?: string; address?: any };
  staff: { name: string; designation?: string; joiningDate?: string; bankRef?: { bank?: string; last4?: string }; phone?: string };
  month: string;
  daysInMonth: number;
  runStatus: string;
  line: any;
}

export function renderPayslipPdf(data: PayslipPdfData): Promise<Buffer> {
  const { business, branch, staff, line } = data;
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Payslip ${data.month} ${staff.name}`, Author: business?.name || 'Glox' } });
  const left = 50;
  const width = 495;

  doc.font('Helvetica-Bold').fontSize(16).text(business?.name || 'Salon', left, 50);
  doc.font('Helvetica').fontSize(9).fillColor('#555');
  const addr = branch?.address || business?.address;
  if (branch?.name) doc.text(`${branch.name}${addr ? ` — ${[addr.line1, addr.city, addr.state].filter(Boolean).join(', ')}` : ''}`);
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#000').text(`Payslip — ${monthLabel(data.month)}`, left, 50, { width, align: 'right' });

  // Employee block
  let y = 110;
  doc.moveTo(left, y).lineTo(left + width, y).strokeColor('#ccc').stroke();
  y += 10;
  const kv = (k: string, v: string, x: number) => {
    doc.font('Helvetica').fontSize(9).fillColor('#666').text(k, x, y, { width: 110 });
    doc.font('Helvetica-Bold').fillColor('#000').text(v || '—', x + 110, y, { width: 130 });
  };
  kv('Employee', staff.name, left);
  kv('Paid days', `${line.paidDays} of ${data.daysInMonth}`, left + 255);
  y += 16;
  kv('Designation', DESIGNATION[staff.designation || ''] || staff.designation || '', left);
  kv('Joined', staff.joiningDate || '', left + 255);
  y += 16;
  kv('Bank', staff.bankRef?.last4 ? `${staff.bankRef.bank || ''} ••••${staff.bankRef.last4}` : '', left);
  kv('Paid', line.paid?.date ? `${line.paid.date} (${line.paid.mode})` : 'Not yet', left + 255);

  // Earnings | Deductions
  y += 32;
  const colW = width / 2 - 10;
  const table = (title: string, rows: [string, number][], x: number) => {
    let ty = y;
    doc.rect(x, ty, colW, 20).fill('#f3f3f3').fillColor('#000');
    doc.font('Helvetica-Bold').fontSize(10).text(title, x + 8, ty + 6);
    ty += 26;
    for (const [label, amount] of rows) {
      doc.font('Helvetica').fontSize(9.5).text(label, x + 8, ty, { width: colW - 110 });
      doc.text(rs(amount), x + colW - 108, ty, { width: 100, align: 'right' });
      ty += 16;
    }
    return ty;
  };
  const earnings: [string, number][] = [
    ['Salary', line.salaryPaise],
    ['Commission', line.commissionPaise],
    ['Overtime', line.overtimePaise],
    ['Tips', line.tipsPaise],
    ['Incentives / bonus', line.incentivesPaise || 0],
  ];
  const deductions: [string, number][] = [
    ['Advance recovery', line.advancePaise],
    ['Provident Fund (PF)', line.pfPaise],
    ['ESI', line.esiPaise],
    ['Professional Tax', line.ptPaise],
    ['Other deductions', line.otherDeductionPaise || 0],
  ];
  const endA = table('Earnings', earnings, left);
  const endB = table('Deductions', deductions, left + colW + 20);
  y = Math.max(endA, endB) + 4;
  const gross = earnings.reduce((a, [, v]) => a + (v || 0), 0);
  const ded = deductions.reduce((a, [, v]) => a + (v || 0), 0);
  doc.font('Helvetica-Bold').fontSize(10);
  doc.text('Gross earnings', left + 8, y);
  doc.text(rs(gross), left + colW - 108, y, { width: 100, align: 'right' });
  doc.text('Total deductions', left + colW + 28, y);
  doc.text(rs(ded), left + width - 108, y, { width: 100, align: 'right' });

  y += 30;
  doc.rect(left, y, width, 34).fill('#eef6ee').fillColor('#000');
  doc.font('Helvetica-Bold').fontSize(13).text('Net pay', left + 12, y + 10);
  doc.text(rs(line.netPaise), left, y + 10, { width: width - 12, align: 'right' });

  const adjustments = line.adjustments || [];
  if (adjustments.length) {
    y += 50;
    doc.font('Helvetica-Bold').fontSize(9).text('Adjustments', left, y);
    y = doc.y + 2;
    for (const a of adjustments) {
      doc.font('Helvetica').fontSize(8.5).fillColor('#444').text(`${a.field.replace(/Paise$/, '')}: ${a.deltaPaise > 0 ? '+' : ''}${rs(a.deltaPaise)} — ${a.reason}`, left, y);
      y = doc.y + 1;
    }
  }

  if (data.runStatus !== 'locked' && data.runStatus !== 'paid') {
    doc.save().rotate(-30, { origin: [300, 420] }).font('Helvetica-Bold').fontSize(60).fillColor('#d33', 0.15).text('PROVISIONAL', 60, 400, { width: 480, align: 'center' }).restore();
  }
  doc.fillColor('#777').font('Helvetica').fontSize(8).text('This is a computer-generated payslip and does not need a signature.', left, 780, { width, align: 'center' });

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

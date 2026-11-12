import PDFDocument from 'pdfkit';

/*
 * Report PDF (A4 landscape): title, period, summary figures and the report's rows as tables.
 * Wide reports are split into several tables (the first column is repeated on each), so every
 * column is printed. Built-in Helvetica has no ₹ glyph, so amounts are written "Rs.".
 */

export interface ReportPdfData {
  title: string;
  businessName?: string;
  from: string;
  to: string;
  summary?: Record<string, unknown> | null;
  /** Named tables (e.g. one per sheet); each is a list of flat rows */
  tables: { name: string; rows: Record<string, unknown>[] }[];
}

const MAX_COLS = 9;
const PAGE_MARGIN = 36;

/** "netPaise" -> "Net (Rs.)", "billedBy" -> "Billed By". */
export function columnLabel(key: string): string {
  const money = key.endsWith('Paise');
  const base = (money ? key.slice(0, -5) : key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
  return money ? `${base} (Rs.)` : base;
}

function cell(key: string, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (key.endsWith('Paise') && typeof value === 'number') {
    return (value / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') return '';
  return String(value);
}

export function renderReportPdf(data: ReportPdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: PAGE_MARGIN });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - PAGE_MARGIN * 2;
    const bottom = doc.page.height - PAGE_MARGIN;

    doc.font('Helvetica-Bold').fontSize(16).text(data.title);
    doc.font('Helvetica').fontSize(10).fillColor('#444')
      .text(`${data.businessName ? `${data.businessName} · ` : ''}${data.from}${data.to !== data.from ? ` to ${data.to}` : ''}`);
    doc.fillColor('#000').moveDown(0.8);

    // Summary figures, two per line
    const summary = Object.entries(data.summary || {}).filter(([, v]) => typeof v !== 'object' || v === null);
    if (summary.length) {
      doc.font('Helvetica-Bold').fontSize(11).text('Summary');
      doc.font('Helvetica').fontSize(9);
      for (let i = 0; i < summary.length; i += 2) {
        const pair = summary.slice(i, i + 2).map(([k, v]) => `${columnLabel(k)}: ${cell(k, v)}`);
        doc.text(pair.join('        '));
      }
      doc.moveDown(0.8);
    }

    for (const table of data.tables) {
      const rows = table.rows || [];
      if (doc.y > bottom - 60) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(11).text(table.name);
      doc.moveDown(0.3);
      if (!rows.length) {
        doc.font('Helvetica').fontSize(9).text('No data for this period');
        doc.moveDown(0.8);
        continue;
      }
      const keys = Object.keys(rows[0]).filter((k) => typeof rows[0][k] !== 'object' || rows[0][k] === null);
      // Split wide tables into column groups, repeating the first column for orientation
      const groups: string[][] = [];
      const rest = keys.slice(1);
      for (let i = 0; i < Math.max(rest.length, 1); i += MAX_COLS - 1) groups.push([keys[0], ...rest.slice(i, i + MAX_COLS - 1)].filter(Boolean));

      for (const cols of groups) {
        const colW = width / cols.length;
        const drawHeader = () => {
          doc.font('Helvetica-Bold').fontSize(8);
          const y = doc.y;
          cols.forEach((k, i) => doc.text(columnLabel(k), PAGE_MARGIN + i * colW, y, { width: colW - 4, align: i === 0 ? 'left' : 'right' }));
          doc.moveTo(PAGE_MARGIN, doc.y + 2).lineTo(PAGE_MARGIN + width, doc.y + 2).strokeColor('#999').stroke();
          doc.moveDown(0.4);
        };
        if (doc.y > bottom - 40) doc.addPage();
        drawHeader();
        doc.font('Helvetica').fontSize(8);
        for (const row of rows) {
          if (doc.y > bottom - 14) {
            doc.addPage();
            drawHeader();
            doc.font('Helvetica').fontSize(8);
          }
          const y = doc.y;
          let maxY = y;
          cols.forEach((k, i) => {
            doc.text(cell(k, row[k]), PAGE_MARGIN + i * colW, y, { width: colW - 4, align: i === 0 ? 'left' : 'right' });
            maxY = Math.max(maxY, doc.y);
          });
          doc.y = maxY + 2;
        }
        doc.x = PAGE_MARGIN;
        doc.moveDown(0.8);
      }
    }
    doc.end();
  });
}

import { logger } from '../../utils';
import { s3Adapter } from '../s3/s3.adapter';

export class PdfService {
  /**
   * Generates Bill/Invoice PDF.
   * Format: 'a4' | 'thermal'
   */
  async generateInvoicePdf(bill: any, business?: any, branch?: any, format: 'a4' | 'thermal' = 'a4'): Promise<Buffer> {
    logger.debug({ invoiceNo: bill.invoiceNo, format }, 'Generating invoice PDF');
    const title = bill.gstApplied ? 'TAX INVOICE' : 'BILL OF SUPPLY';
    const lines = [
      `============================================================`,
      `                      ${business?.name || 'Glox Salon'}                      `,
      `                   ${branch?.name || 'Main'} Branch                    `,
      `============================================================`,
      `                        ${title}                            `,
      `Invoice No: ${bill.invoiceNo}    Date: ${bill.businessDate}`,
      `Customer: ${bill.customerSnap?.name || 'Walk-in'}  (${bill.customerSnap?.phone || ''})`,
      `Billed By: ${bill.billedByName || 'Reception'}`,
      `------------------------------------------------------------`,
      `TOTAL AMOUNT:      INR ${((bill.totals?.totalPaise || bill.totals?.finalPaise || 0) / 100).toFixed(2)}`,
      `============================================================`,
      `                  Thank you for your visit!                 `,
      `============================================================`,
    ]
      .filter(Boolean)
      .join('\n');

    return Buffer.from(lines, 'utf-8');
  }

  /**
   * Generates Payslip PDF.
   */
  async generatePayslipPdf(data: any): Promise<Buffer> {
    const staffName = data.staffName || 'Staff';
    const month = data.month || 'Month';
    const content = [
      `============================================================`,
      `                  PAYSLIP FOR ${month}                  `,
      `============================================================`,
      `Employee Name:  ${staffName}`,
      `Paid Days:      ${data.paidDays || 0}`,
      `------------------------------------------------------------`,
      `EARNINGS:`,
      `  Basic Salary:      INR ${((data.salaryPaise || 0) / 100).toFixed(2)}`,
      `  Commission:        INR ${((data.commissionPaise || 0) / 100).toFixed(2)}`,
      `  Overtime:          INR ${((data.overtimePaise || 0) / 100).toFixed(2)}`,
      `  Tips:              INR ${((data.tipsPaise || 0) / 100).toFixed(2)}`,
      `  Incentives:        INR ${((data.incentivesPaise || 0) / 100).toFixed(2)}`,
      `DEDUCTIONS:`,
      `  Advance Recovery:  INR ${((data.advancePaise || 0) / 100).toFixed(2)}`,
      `  PF:                INR ${((data.pfPaise || 0) / 100).toFixed(2)}`,
      `  ESI:               INR ${((data.esiPaise || 0) / 100).toFixed(2)}`,
      `  PT:                INR ${((data.ptPaise || 0) / 100).toFixed(2)}`,
      `  Other Deductions:  INR ${((data.otherDeductionPaise || 0) / 100).toFixed(2)}`,
      `------------------------------------------------------------`,
      `NET PAYABLE:         INR ${((data.netPaise || 0) / 100).toFixed(2)}`,
      `============================================================`,
    ].join('\n');

    return Buffer.from(content, 'utf-8');
  }

  /**
   * Generates Day-End Report PDF.
   */
  async generateDayEndPdf(data: any): Promise<Buffer> {
    const content = [
      `============================================================`,
      `               DAY-END REPORT: ${data.branchName || 'Branch'}               `,
      `                     Date: ${data.businessDate}          `,
      `============================================================`,
      `Expected Cash:     INR ${((data.expectedCashPaise || 0) / 100).toFixed(2)}`,
      `Counted Cash:      INR ${((data.countedCashPaise || 0) / 100).toFixed(2)}`,
      `Difference Cash:   INR ${((data.diffCashPaise || 0) / 100).toFixed(2)}`,
      `Expected UPI:      INR ${((data.upiPaise || 0) / 100).toFixed(2)}`,
      `Expected Card:     INR ${((data.cardPaise || 0) / 100).toFixed(2)}`,
      `============================================================`,
    ]
      .filter(Boolean)
      .join('\n');

    return Buffer.from(content, 'utf-8');
  }
}

export const pdfService = new PdfService();

export async function generateInvoicePdf(bill: any, business?: any, branch?: any, format: 'a4' | 'thermal' = 'a4'): Promise<Buffer> {
  return pdfService.generateInvoicePdf(bill, business, branch, format);
}

export async function generatePayslipPdf(data: any): Promise<Buffer> {
  return pdfService.generatePayslipPdf(data);
}

export async function generateDayEndPdf(data: any): Promise<Buffer> {
  return pdfService.generateDayEndPdf(data);
}

export async function uploadPdf(key: string, buffer: Buffer): Promise<void> {
  await s3Adapter.putObject(key, buffer, 'application/pdf');
}

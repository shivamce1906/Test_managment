import { Types } from 'mongoose';
import {
  ImportJob,
  Customer,
  Service,
  Product,
  Staff,
  Plan,
  Category,
  Branch,
  WalletLedger,
  withTransaction,
} from '../models';
import { AppError, ErrorCode, getBusinessDate, normalizePhone, rupeesToPaise } from '../utils';
import { RequestContext, toObjectId } from './context';
import { logAction } from './audit.service';
import { s3Adapter } from '../integrations';
import ExcelJS from 'exceljs';

const STAFF_DESIGNATIONS = new Set([
  'stylist',
  'senior_stylist',
  'beautician',
  'receptionist',
  'manager',
  'helper',
  'other',
]);

const PLAN_TYPES = new Set(['membership', 'package', 'wallet_offer', 'voucher']);
const PRODUCT_TYPES = new Set(['retail', 'consumable', 'both']);
const GENDERS = new Set(['men', 'women', 'unisex']);

function cellStr(val: any): string {
  if (val === undefined || val === null) return '';
  if (typeof val === 'object' && val.text) return String(val.text).trim();
  return String(val).trim();
}

function cellNum(val: any): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : NaN;
}

function extractSheetRows(sheet: ExcelJS.Worksheet): { rowNumber: number; values: any[] }[] {
  const rows: { rowNumber: number; values: any[] }[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // Header row
    const values = Array.isArray(row.values) ? [...row.values] : [];
    const hasContent = values.slice(1).some((v) => v !== undefined && v !== null && String(v).trim() !== '');
    if (hasContent) {
      rows.push({ rowNumber, values });
    }
  });
  return rows;
}

export async function createImportJob(
  ctx: RequestContext,
  businessId: string | Types.ObjectId,
  type: 'customers' | 'services' | 'products' | 'staff' | 'plans' | 'wallet',
  fileKey: string
) {
  if (ctx.role !== 'super_admin') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'Only Super Admin can initiate data migration imports');
  }

  const job = await ImportJob.create({
    businessId,
    type,
    fileKey,
    status: 'validating',
    errors: [],
    createdBy: ctx.userId,
  });

  // Download and validate Excel file
  try {
    const fileBuffer = await s3Adapter.getObject(fileKey);
    if (!fileBuffer || fileBuffer.length === 0) {
      throw new Error(`Import file not found in storage: ${fileKey}`);
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer as any);
    const sheet = workbook.worksheets[0];
    if (!sheet) {
      throw new Error('Excel workbook contains no worksheets');
    }

    const rows = extractSheetRows(sheet);
    const errors: { row: number; message: string }[] = [];
    let validRows = 0;

    for (const { rowNumber, values } of rows) {
      try {
        if (type === 'customers') {
          const phone = cellStr(values[2]);
          if (!phone) {
            errors.push({ row: rowNumber, message: 'Phone number is required' });
            continue;
          }
          normalizePhone(phone);
          validRows++;
        } else if (type === 'services') {
          const name = cellStr(values[1]);
          const price = cellNum(values[2]);
          if (!name) {
            errors.push({ row: rowNumber, message: 'Service name is required' });
            continue;
          }
          if (values[2] !== undefined && values[2] !== null && (Number.isNaN(price) || price < 0)) {
            errors.push({ row: rowNumber, message: 'Invalid service price' });
            continue;
          }
          validRows++;
        } else if (type === 'products') {
          const name = cellStr(values[1]);
          const price = values[2] !== undefined && values[2] !== null ? cellNum(values[2]) : 0;
          if (!name) {
            errors.push({ row: rowNumber, message: 'Product name is required' });
            continue;
          }
          if (Number.isNaN(price) || price < 0) {
            errors.push({ row: rowNumber, message: 'Invalid product price' });
            continue;
          }
          validRows++;
        } else if (type === 'staff') {
          const name = cellStr(values[1]);
          const phone = cellStr(values[2]);
          if (!name) {
            errors.push({ row: rowNumber, message: 'Staff name is required' });
            continue;
          }
          if (!phone) {
            errors.push({ row: rowNumber, message: 'Staff phone number is required' });
            continue;
          }
          normalizePhone(phone);
          validRows++;
        } else if (type === 'plans') {
          const name = cellStr(values[1]);
          const price = cellNum(values[2]);
          const planType = cellStr(values[3]).toLowerCase() || 'membership';
          if (!name) {
            errors.push({ row: rowNumber, message: 'Plan name is required' });
            continue;
          }
          if (Number.isNaN(price) || price < 0) {
            errors.push({ row: rowNumber, message: 'Valid non-negative plan price is required' });
            continue;
          }
          if (!PLAN_TYPES.has(planType)) {
            errors.push({ row: rowNumber, message: `Invalid plan type: ${planType}` });
            continue;
          }
          validRows++;
        } else if (type === 'wallet') {
          const phone = cellStr(values[1]);
          const balance = cellNum(values[2]);
          if (!phone) {
            errors.push({ row: rowNumber, message: 'Customer phone number is required' });
            continue;
          }
          normalizePhone(phone);
          if (Number.isNaN(balance) || balance <= 0) {
            errors.push({ row: rowNumber, message: 'Wallet balance must be a positive number' });
            continue;
          }
          validRows++;
        } else {
          errors.push({ row: rowNumber, message: `Unsupported import type: ${type}` });
        }
      } catch (rowErr: any) {
        errors.push({ row: rowNumber, message: rowErr.message || 'Invalid row data' });
      }
    }

    (job as any).errors = errors;
    job.status = errors.length > 50 || (validRows === 0 && rows.length > 0) ? 'failed' : 'ready';
    job.summary = {
      totalRows: rows.length,
      validRows,
      errorCount: errors.length,
    };
    await job.save();
  } catch (err: any) {
    job.status = 'failed';
    (job as any).errors = [{ row: 0, message: err.message || 'Failed to read Excel workbook' }];
    await job.save();
  }

  return job;
}

export async function confirmImportJob(
  ctx: RequestContext,
  jobId: string | Types.ObjectId
) {
  if (ctx.role !== 'super_admin') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'Only Super Admin can confirm data migration imports');
  }

  const job = await ImportJob.findById(jobId);
  if (!job) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Import job not found');
  }

  if (job.status !== 'ready') {
    throw new AppError(400, ErrorCode.BAD_REQUEST, `Import job is in ${job.status} status and cannot be imported`);
  }

  job.status = 'importing';
  await job.save();

  const fileBuffer = await s3Adapter.getObject(job.fileKey);
  if (!fileBuffer || fileBuffer.length === 0) {
    job.status = 'failed';
    (job as any).errors = [...((job as any).errors || []), { row: 0, message: `File not found: ${job.fileKey}` }];
    await job.save();
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Import file not found in storage');
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer as any);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    job.status = 'failed';
    await job.save();
    throw new AppError(400, ErrorCode.BAD_REQUEST, 'Workbook has no worksheets');
  }

  const rows = extractSheetRows(sheet);
  let importedCount = 0;
  let skippedCount = 0;
  const runtimeErrors: { row: number; message: string }[] = [...((job as any).errors || [])];

  try {
    if (job.type === 'customers') {
      for (const { rowNumber, values } of rows) {
        try {
          const name = cellStr(values[1]) || 'Customer';
          const phoneRaw = cellStr(values[2]);
          if (!phoneRaw) continue;
          const phone = normalizePhone(phoneRaw);
          const email = cellStr(values[3]).toLowerCase() || undefined;

          // Existing customers are never changed by an import (their details may be newer
          // than the spreadsheet); they are only counted as skipped
          const existing = await Customer.findOne({ businessId: job.businessId, phone }).select('_id');
          if (existing) {
            skippedCount++;
            continue;
          }
          // create() runs the model validators (an upsert would silently skip them)
          await Customer.create({
            businessId: job.businessId,
            name,
            phone,
            ...(email ? { email } : {}),
            source: 'import',
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          });
          importedCount++;
        } catch (err: any) {
          runtimeErrors.push({ row: rowNumber, message: err.message || 'Customer import failed' });
        }
      }
    } else if (job.type === 'services') {
      let defaultCategory = await Category.findOne({ businessId: job.businessId });
      if (!defaultCategory) {
        defaultCategory = await Category.create({
          businessId: job.businessId,
          name: 'General',
          gender: 'unisex',
          order: 1,
          active: true,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        });
      }

      for (const { rowNumber, values } of rows) {
        try {
          const name = cellStr(values[1]);
          if (!name) continue;
          const priceNum = values[2] !== undefined && values[2] !== null ? cellNum(values[2]) : 500;
          if (Number.isNaN(priceNum) || priceNum < 0) {
            throw new Error('Invalid service price');
          }
          const durationRaw = cellNum(values[3]);
          const durationMin = !Number.isNaN(durationRaw) && durationRaw >= 5 ? Math.round(durationRaw) : 30;
          const genderRaw = cellStr(values[4]).toLowerCase();
          const gender = GENDERS.has(genderRaw) ? (genderRaw as 'men' | 'women' | 'unisex') : 'unisex';

          await Service.create({
            businessId: job.businessId,
            categoryId: defaultCategory._id,
            name,
            gender,
            durationMin,
            basePricePaise: rupeesToPaise(priceNum),
            active: true,
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          });
          importedCount++;
        } catch (err: any) {
          runtimeErrors.push({ row: rowNumber, message: err.message || 'Service import failed' });
        }
      }
    } else if (job.type === 'products') {
      for (const { rowNumber, values } of rows) {
        try {
          const name = cellStr(values[1]);
          if (!name) continue;
          const priceNum = values[2] !== undefined && values[2] !== null ? cellNum(values[2]) : 0;
          if (Number.isNaN(priceNum) || priceNum < 0) {
            throw new Error('Invalid product price');
          }
          const rawType = cellStr(values[3]).toLowerCase();
          const productType = PRODUCT_TYPES.has(rawType) ? (rawType as 'retail' | 'consumable' | 'both') : 'retail';
          const purchaseUnit = cellStr(values[4]) || 'pcs';
          const useUnit = cellStr(values[5]) || purchaseUnit;
          const uppRaw = cellNum(values[6]);
          const unitsPerPurchase = !Number.isNaN(uppRaw) && uppRaw > 0 ? Math.round(uppRaw) : 1;
          const sellingRaw = values[7] !== undefined && values[7] !== null ? cellNum(values[7]) : priceNum;
          const pricePaise = rupeesToPaise(priceNum);

          await Product.create({
            businessId: job.businessId,
            name,
            type: productType,
            purchaseUnit,
            useUnit,
            unitsPerPurchase,
            purchasePricePaise: pricePaise,
            sellingPricePaise: !Number.isNaN(sellingRaw) && sellingRaw >= 0 ? rupeesToPaise(sellingRaw) : pricePaise,
            active: true,
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          });
          importedCount++;
        } catch (err: any) {
          runtimeErrors.push({ row: rowNumber, message: err.message || 'Product import failed' });
        }
      }
    } else if (job.type === 'staff') {
      const branches = await Branch.find({ businessId: job.businessId, status: 'active' });
      if (branches.length === 0) {
        throw new Error('Business has no active branches for staff import');
      }
      const defaultBranch = branches[0];
      const branchByName = new Map(branches.map((b) => [b.name.toLowerCase(), b._id]));
      const todayIst = getBusinessDate();

      for (const { rowNumber, values } of rows) {
        try {
          const name = cellStr(values[1]);
          const phoneRaw = cellStr(values[2]);
          if (!name || !phoneRaw) continue;
          const phone = normalizePhone(phoneRaw);

          const rawDesig = cellStr(values[3]).toLowerCase();
          const designation = STAFF_DESIGNATIONS.has(rawDesig)
            ? (rawDesig as any)
            : 'stylist';
          const salaryNum = values[4] !== undefined && values[4] !== null ? cellNum(values[4]) : 0;
          const salaryPaise = !Number.isNaN(salaryNum) && salaryNum > 0 ? rupeesToPaise(salaryNum) : 0;
          const branchRef = cellStr(values[5]).toLowerCase();
          const branchId = (branchRef && branchByName.get(branchRef)) || defaultBranch._id;
          const joiningDate = cellStr(values[6]) || todayIst;

          await Staff.create({
            businessId: job.businessId,
            branchId,
            name,
            phone,
            designation,
            joiningDate,
            salary: {
              type: salaryPaise > 0 ? 'monthly' : 'none',
              amountPaise: salaryPaise,
            },
            statutory: { pf: false, esi: false, pt: false },
            status: 'active',
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          });
          importedCount++;
        } catch (err: any) {
          runtimeErrors.push({ row: rowNumber, message: err.message || 'Staff import failed' });
        }
      }
    } else if (job.type === 'plans') {
      for (const { rowNumber, values } of rows) {
        try {
          const name = cellStr(values[1]);
          const priceNum = cellNum(values[2]);
          if (!name || Number.isNaN(priceNum) || priceNum < 0) continue;

          const rawType = cellStr(values[3]).toLowerCase() || 'membership';
          const planType = PLAN_TYPES.has(rawType) ? (rawType as any) : 'membership';
          const validityRaw = cellNum(values[4]);
          const validityDays = !Number.isNaN(validityRaw) && validityRaw > 0 ? Math.round(validityRaw) : 365;
          const extraNum = values[5] !== undefined && values[5] !== null ? cellNum(values[5]) : NaN;
          const pricePaise = rupeesToPaise(priceNum);

          const doc: any = {
            businessId: job.businessId,
            type: planType,
            name,
            pricePaise,
            validityDays,
            branchScope: [],
            active: true,
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          };
          if (planType === 'membership') {
            doc.membership = {
              serviceDiscountBps: !Number.isNaN(extraNum) && extraNum >= 0 ? Math.round(extraNum) : 1000,
              productDiscountBps: 0,
            };
          } else if (planType === 'wallet_offer') {
            doc.walletOffer = {
              creditPaise: !Number.isNaN(extraNum) && extraNum > 0 ? rupeesToPaise(extraNum) : pricePaise,
            };
          } else if (planType === 'voucher') {
            doc.voucher = {
              valuePaise: !Number.isNaN(extraNum) && extraNum > 0 ? rupeesToPaise(extraNum) : pricePaise,
            };
          }

          await Plan.create(doc);
          importedCount++;
        } catch (err: any) {
          runtimeErrors.push({ row: rowNumber, message: err.message || 'Plan import failed' });
        }
      }
    } else if (job.type === 'wallet') {
      for (const { rowNumber, values } of rows) {
        try {
          const phoneRaw = cellStr(values[1]);
          const balanceNum = cellNum(values[2]);
          if (!phoneRaw || Number.isNaN(balanceNum) || balanceNum <= 0) continue;
          const phone = normalizePhone(phoneRaw);
          const amountPaise = rupeesToPaise(balanceNum);

          await withTransaction(async (session) => {
            const customer = await Customer.findOneAndUpdate(
              { businessId: job.businessId, phone },
              { $inc: { walletBalancePaise: amountPaise } },
              { new: true, session }
            );
            if (!customer) {
              throw new Error(`Customer not found for phone ${phone}`);
            }

            await WalletLedger.create(
              [
                {
                  businessId: job.businessId,
                  customerId: customer._id,
                  type: 'imported',
                  amountPaise,
                  balanceAfterPaise: customer.walletBalancePaise,
                  reason: `Migration import job ${job._id}`,
                  createdBy: toObjectId(ctx.userId),
                  updatedBy: toObjectId(ctx.userId),
                },
              ],
              { session }
            );
          });
          importedCount++;
        } catch (err: any) {
          runtimeErrors.push({ row: rowNumber, message: err.message || 'Wallet import failed' });
        }
      }
    }
  } catch (err: any) {
    runtimeErrors.push({ row: 0, message: err.message || 'Import execution error' });
  }

  (job as any).errors = runtimeErrors;
  job.status = importedCount === 0 && skippedCount === 0 && runtimeErrors.length > 0 ? 'failed' : 'done';
  job.confirmedBy = toObjectId(ctx.userId);
  job.summary = {
    ...(job.summary || {}),
    totalRows: rows.length,
    importedCount,
    skippedCount,
    errorCount: runtimeErrors.length,
  };
  await job.save();

  await logAction({
    businessId: job.businessId,
    actorId: ctx.userId,
    actorRole: 'super_admin',
    action: 'migration.imported',
    targetType: 'importJob',
    targetId: job._id,
    meta: { type: job.type, importedCount, skippedCount, errorCount: runtimeErrors.length },
  });

  return job;
}

export async function getImportJobs(
  ctx: RequestContext,
  businessId: string | Types.ObjectId
) {
  if (ctx.role !== 'super_admin') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'Only Super Admin can view import jobs');
  }

  return ImportJob.find({ businessId }).sort({ createdAt: -1 });
}

import { Types } from 'mongoose';
import {
  ImportJob,
  Customer,
  Service,
  Product,
  Staff,
  Category,
  Branch,
  WalletLedger,
  withTransaction,
} from '../models';
import { AppError, ErrorCode, normalizePhone, rupeesToPaise } from '../utils';
import { RequestContext, toObjectId } from './context';
import { logAction } from './audit.service';
import { s3Adapter } from '../integrations';
import ExcelJS from 'exceljs';

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
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer as any);
    const sheet = workbook.worksheets[0];

    const errors: { row: number; message: string }[] = [];
    let validRows = 0;

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Header

      const rowValues: any = row.values;
      if (type === 'customers') {
        const name = rowValues[1];
        const phone = rowValues[2]?.toString();
        if (!phone || phone.length < 10) {
          errors.push({ row: rowNumber, message: 'Invalid or missing phone number' });
        } else {
          validRows++;
        }
      } else if (type === 'services') {
        const name = rowValues[1];
        const basePrice = rowValues[2];
        if (!name) {
          errors.push({ row: rowNumber, message: 'Service name is required' });
        } else {
          validRows++;
        }
      } else if (type === 'products') {
        const name = rowValues[1];
        if (!name) {
          errors.push({ row: rowNumber, message: 'Product name is required' });
        } else {
          validRows++;
        }
      } else {
        validRows++;
      }
    });

    (job as any).errors = errors;
    job.status = errors.length > 50 ? 'failed' : 'ready';
    job.summary = {
      totalRows: sheet.rowCount - 1,
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
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer as any);
  const sheet = workbook.worksheets[0];

  let importedCount = 0;

  if (job.type === 'customers') {
    sheet.eachRow(async (row, rowNumber) => {
      if (rowNumber === 1) return;
      const values: any = row.values;
      const name = values[1]?.toString() || 'Customer';
      const phoneRaw = values[2]?.toString();
      if (!phoneRaw) return;

      const phone = normalizePhone(phoneRaw);
      await Customer.findOneAndUpdate(
        { businessId: job.businessId, phone },
        {
          businessId: job.businessId,
          name,
          phone,
          gender: 'other',
          consent: { marketing: true, transactional: true },
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        },
        { upsert: true }
      );
      importedCount++;
    });
  } else if (job.type === 'services') {
    let category = await Category.findOne({ businessId: job.businessId });
    if (!category) {
      category = await Category.create({
        businessId: job.businessId,
        name: 'General',
        order: 1,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });
    }

    sheet.eachRow(async (row, rowNumber) => {
      if (rowNumber === 1) return;
      const values: any = row.values;
      const name = values[1]?.toString();
      const price = Number(values[2]) || 500;
      if (!name) return;

      await Service.create({
        businessId: job.businessId,
        categoryId: category._id,
        name,
        gender: 'unisex',
        durationMin: 30,
        basePricePaise: rupeesToPaise(price),
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });
      importedCount++;
    });
  } else if (job.type === 'products') {
    sheet.eachRow(async (row, rowNumber) => {
      if (rowNumber === 1) return;
      const values: any = row.values;
      const name = values[1]?.toString();
      const price = Number(values[2]) || 500;
      if (!name) return;

      await Product.create({
        businessId: job.businessId,
        name,
        pool: 'retail',
        retailPricePaise: rupeesToPaise(price),
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });
      importedCount++;
    });
  }

  job.status = 'done';
  job.confirmedBy = toObjectId(ctx.userId);
  job.summary = {
    ...job.summary,
    importedCount,
  };
  await job.save();

  await logAction({
    businessId: job.businessId,
    actorId: ctx.userId,
    actorRole: 'super_admin',
    action: 'migration.imported',
    targetType: 'importJob',
    targetId: job._id,
    meta: { type: job.type, importedCount },
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

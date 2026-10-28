import { z } from 'zod';
import { addressSchema, objectIdSchema } from './common.schema';

export const createBusinessSchema = z.object({
  business: z.object({
    name: z.string().min(1, 'Business name is required'),
    logoUrl: z.string().optional(),
    address: addressSchema,
    gst: z.object({
      enabled: z.boolean().default(false),
      gstin: z.string().optional(),
      pan: z.string().optional(),
      rateBps: z.number().int().nonnegative().default(1800),
      sac: z.string().default('9983'),
      pricesInclusive: z.boolean().default(false),
    }),
    fyStartMonth: z.number().int().min(1).max(12).default(4),
    discountLimits: z.object({
      managerBps: z.number().int().nonnegative().default(2000),
      branchBps: z.number().int().nonnegative().default(1000),
      ownerAlertBps: z.number().int().nonnegative().default(2500),
    }),
    dayEndReportTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:mm').default('23:00'),
    ownerWhatsappPhone: z.string().min(10, 'Valid WhatsApp phone is required'),
  }),
  owner: z.object({
    name: z.string().min(1, 'Owner name is required'),
    email: z.string().trim().toLowerCase().email(),
    phone: z.string().optional(),
    password: z.string().min(8, 'Password must be at least 8 characters'),
  }),
  headBranch: z.object({
    name: z.string().min(1, 'Branch name is required'),
    code: z.string().min(1, 'Branch code is required').toUpperCase(),
    invoicePrefix: z.string().min(1, 'Invoice prefix is required').toUpperCase(),
    address: addressSchema,
    phone: z.string().min(10),
    loginEmail: z.string().trim().toLowerCase().email(),
    loginPassword: z.string().min(8),
  }),
});

export const updateBusinessSettingsSchema = z.object({
  name: z.string().min(1).optional(),
  logoUrl: z.string().optional(),
  address: addressSchema.optional(),
  gst: z.object({
    enabled: z.boolean(),
    gstin: z.string().optional(),
    pan: z.string().optional(),
    rateBps: z.number().int().nonnegative().optional(),
    sac: z.string().optional(),
    pricesInclusive: z.boolean().optional(),
  }).optional(),
  fyStartMonth: z.number().int().min(1).max(12).optional(),
  discountLimits: z.object({
    managerBps: z.number().int().nonnegative().optional(),
    branchBps: z.number().int().nonnegative().optional(),
    ownerAlertBps: z.number().int().nonnegative().optional(),
  }).optional(),
  dayEndReportTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  loyalty: z.object({
    enabled: z.boolean(),
    earnPer100: z.number().nonnegative(),
    redeemValuePaise: z.number().int().nonnegative(),
    minRedeem: z.number().int().nonnegative(),
    expiryDays: z.number().int().positive(),
  }).optional(),
  payroll: z.object({
    pf: z.object({
      enabled: z.boolean(),
      employeePct: z.number().nonnegative().optional(),
      wageCeilingPaise: z.number().int().nonnegative().optional(),
    }).optional(),
    esi: z.object({
      enabled: z.boolean(),
      employeePct: z.number().nonnegative().optional(),
      wageCeilingPaise: z.number().int().nonnegative().optional(),
    }).optional(),
    pt: z.object({
      enabled: z.boolean(),
      slabs: z.array(z.object({
        uptoPaise: z.number().int().positive(),
        amountPaise: z.number().int().nonnegative(),
      })).optional(),
    }).optional(),
  }).optional(),
  automationGuards: z.object({
    quietStart: z.string().optional(),
    quietEnd: z.string().optional(),
    maxMarketingPerDay: z.number().int().nonnegative().optional(),
  }).optional(),
  ownerWhatsappPhone: z.string().optional(),
});

export const createBranchSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1).toUpperCase(),
  invoicePrefix: z.string().min(1).toUpperCase(),
  address: addressSchema,
  phone: z.string().min(10),
  loginEmail: z.string().trim().toLowerCase().email(),
  loginPassword: z.string().min(8),
  stations: z.number().int().positive().optional(),
  pettyCashFloatPaise: z.number().int().nonnegative().default(0),
});

export const updateBranchSchema = z.object({
  hours: z.array(z.object({
    day: z.number().int().min(0).max(6),
    open: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    close: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    closed: z.boolean(),
  })).optional(),
  holidays: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    name: z.string(),
  })).optional(),
  stations: z.number().int().positive().optional(),
  googleReviewUrl: z.string().url().optional().or(z.literal('')),
  pettyCashFloatPaise: z.number().int().nonnegative().optional(),
});

export const updateBusinessSchema = updateBusinessSettingsSchema;

export const branchRequestSchema = z.object({
  type: z.enum(['add', 'delete']),
  branchId: objectIdSchema.optional(),
  payload: z.object({
    name: z.string().min(1),
    address: addressSchema,
  }).optional(),
  reason: z.string().min(1, 'Reason is required'),
});
export const createBranchRequestSchema = branchRequestSchema;

export const approveBranchRequestSchema = z.object({
  // for 'add' requests, superadmin can provide code, invoicePrefix, loginEmail, loginPassword
  code: z.string().optional(),
  invoicePrefix: z.string().optional(),
  phone: z.string().optional(),
  loginEmail: z.string().optional(),
  loginPassword: z.string().optional(),
});

export const rejectBranchRequestSchema = z.object({
  reason: z.string().min(1, 'Rejection reason is required'),
});

export const createManagerSchema = z.object({
  name: z.string().min(1),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().optional(),
  password: z.string().min(8),
  branchIds: z.array(objectIdSchema).min(1, 'Assign at least one branch'),
  flags: z.object({
    manageStaff: z.boolean().optional(),
    approvePO: z.boolean().optional(),
    viewPayroll: z.boolean().optional(),
    editBranchPrices: z.boolean().optional(),
    maxDiscountBps: z.number().int().nonnegative().optional(),
  }).optional(),
  staffId: objectIdSchema.optional(),
});

export const updateManagerSchema = z.object({
  branchIds: z.array(objectIdSchema).optional(),
  flags: z.object({
    manageStaff: z.boolean().optional(),
    approvePO: z.boolean().optional(),
    viewPayroll: z.boolean().optional(),
    editBranchPrices: z.boolean().optional(),
    maxDiscountBps: z.number().int().nonnegative().optional(),
  }).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  staffId: objectIdSchema.optional(),
});

export const updateBranchLoginFlagsSchema = z.object({
  markAttendance: z.boolean(),
});

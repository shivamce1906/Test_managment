# Glox Salon Management System — Backend SRS v1.0

Oct 26, 2026 · @Jagdish Kumawat

## 1. Overview and stack

One Node.js REST API serves the single web app for all roles; it owns every business rule, every database write and all WhatsApp traffic. Business rules (BR-xx) and requirement IDs (FR-xx) refer to the main SRS (Glox Salon Management System — SRS v1.0); screens refer to the Frontend SRS (Glox Salon Management System — Frontend SRS v1.0).

**Stack**

| Concern | Choice |
| --- | --- |
| Runtime | Node.js 20 LTS, TypeScript strict |
| HTTP | Express 4, helmet, cors, compression, express-rate-limit (Redis store) |
| Database | MongoDB Atlas (replica set, M30+ in production), Mongoose 8 |
| Validation | Zod schemas in shared package `@glox/schemas`, used by API and frontend |
| Auth | JWT (jose), bcrypt, refresh tokens in Redis |
| Queues and cache | Redis 7, BullMQ |
| Files | AWS S3 with presigned URLs |
| PDF | Puppeteer (headless Chrome) in the worker process, HTML templates |
| Excel | exceljs for exports and import parsing |
| Logging | pino (JSON), request ID per request |
| Errors | Sentry Node SDK |
| Tests | Jest, Supertest, mongodb-memory-server (replica set mode) |
| Hosting | AWS ap-south-1: API and worker as containers (ECS Fargate) behind an ALB; Atlas in Mumbai; ElastiCache Redis |

No Socket.IO, no push, no SMS or email providers.

**Project structure (monorepo)**

```
apps/
  api/            Express app: routes, controllers
  worker/         BullMQ processors and schedulers
packages/
  schemas/        Zod request/response schemas (shared with web)
  core/           domain services: billing, payroll, stock, dayend, ...
  db/             Mongoose models, plugins, indexes, migrations
  integrations/   aisensy, s3, pdf
  utils/          money, dates (IST), errors, logger
```

**Layering:** route → validate (Zod) → auth and permission middleware → controller (thin) → domain service (all rules, transactions) → Mongoose models. Controllers never touch models directly; workers call the same domain services.

**Conventions:** money as integer paise (`number`, validated as safe integer ≥ 0 unless signed); quantities as integer use units; `businessDate` as `YYYY-MM-DD` IST string; timestamps UTC `Date`.

## 2. Authentication and authorisation

All users authenticate with email and password through one endpoint; Super Admins live in `platformAdmins`, salon users in `users`, and an email is unique across both collections.

**Login (`POST /auth/login`)**

1. Normalise email (trim, lower-case). Rate limit: 5 attempts per minute per IP, 5 failures per account → lock 15 minutes (`lockedUntil`).
2. Look up `platformAdmins`, then `users`. Compare bcrypt hash (cost 12). Generic error on any mismatch.
3. Reject if user, branch (for branch logins) or business is inactive or suspended.
4. Issue access token (JWT HS256, 15 min) with claims `sub`, `kind` (`platform` or `tenant`), `role`, `businessId`, `sv` (session version).
5. Issue refresh token: random 256-bit, stored hashed in Redis under `rt:<userId>:<tokenId>` with TTL by role: Super Admin 12 h, owner and manager 30 days, branch 7 days. Sent as httpOnly, Secure, SameSite=Strict cookie on path `/auth`.

**Refresh (`POST /auth/refresh`):** validates and rotates the token (old one deleted; reuse of a deleted token revokes all of that user's tokens). **Logout:** deletes the current refresh token.

**Session revocation:** each user has `sessionVersion`. Setting a password, deactivating, or changing role or branches increments it and deletes all `rt:<userId>:*` keys. Access tokens carrying an older `sv` are rejected with `SESSION_REVOKED` (checked against a Redis-cached value).

**Password changes (no self-service):**

| Endpoint | Caller | Target |
| --- | --- | --- |
| `POST /business/users/:id/password` | Owner | Manager or branch login of own business |
| `POST /admin/users/:id/password` | Super Admin | Any owner, manager or branch login |

New password: 8–64 characters, at least one letter and one number. Writes audit `user.password_set`.

**Middleware chain (tenant routes)**

| Order | Middleware | Behaviour |
| --- | --- | --- |
| 1 | `requestId` | Adds `x-request-id`, binds logger |
| 2 | `authenticate` | Verifies JWT, checks `sv`, loads user context from Redis (fallback DB): role, businessId, branchIds, permissionFlags |
| 3 | `requireKind('tenant')` | Platform tokens cannot call tenant routes except through `/admin` |
| 4 | `requireRole(...)` | Route-declared roles |
| 5 | `requireBranch(param)` | For manager and branch: `branchId` must be in user's branches; owner: must belong to business |
| 6 | `requirePermission(flag)` | Manager flags (manageStaff, approvePO, viewPayroll, editBranchPrices) and branch flag (markAttendance) |
| 7 | `validate(schema)` | Zod on params, query, body; unknown keys rejected |

**Tenant isolation plugin (`tenantScope`):** applied to every tenant model. It requires `businessId` on every find, update, delete, aggregate (first stage `$match`) and count; missing scope throws `TENANT_SCOPE_MISSING` (500, alerts Sentry). Services receive a `ctx` object (`businessId`, `userId`, `role`, `branchIds`, `billedBy?`) and pass it to every query helper.

**Phone masking:** a response serializer masks `phone`, `altPhone`, `email` on customers and leads for manager and branch roles, except on `GET /customers/:id?reveal=1` called from booking or billing, which writes audit `customer.phone_reveal`. Exports are owner-only.

## 3. Data model: platform, people, catalogue

Collections are written as TypeScript shapes of the Mongoose schemas; every tenant document also carries the base fields below. `ObjectId` refs point to the named collection. Indexes follow each group.

```ts
// Base fields on every tenant document (Mongoose plugin: baseFields + tenantScope)
interface Base {
  _id: ObjectId;
  businessId: ObjectId;          // -> businesses, required, indexed
  createdAt: Date; updatedAt: Date;
  createdBy?: ObjectId; updatedBy?: ObjectId;  // -> users | platformAdmins
  deletedAt?: Date;              // soft delete; never set on bills, ledgers, audit
  __v: number;                   // optimisticConcurrency: true (409 on mismatch)
}
```

```ts
interface PlatformAdmin {            // no businessId
  _id: ObjectId; name: string; email: string; passwordHash: string;
  status: 'active' | 'inactive'; sessionVersion: number;
  failedLogins: number; lockedUntil?: Date; lastLoginAt?: Date;
}

interface Business {                 // _id is the businessId
  name: string; logoUrl?: string; address: Address;
  gst: { enabled: boolean; gstin?: string; pan?: string; ratePct: number /*bps: 1800*/; pricesInclusive: boolean; sac: string /*9983*/ };
  fyStartMonth: number;              // 4 = April
  discountLimits: { managerPct: number; branchPct: number; ownerAlertPct: number }; // basis points
  dayEndReportTime: string;          // 'HH:mm', default '23:00'
  loyalty: { enabled: boolean; earnPer100: number; redeemValuePaise: number; minRedeem: number; expiryDays: number };
  payroll: { pf: { enabled: boolean; employeePct: number; wageCeilingPaise: number }; esi: { enabled: boolean; employeePct: number; wageCeilingPaise: number }; pt: { enabled: boolean; slabs: { uptoPaise: number; amountPaise: number }[] } };
  automationGuards: { quietStart: string; quietEnd: string; maxMarketingPerDay: number };
  whatsapp?: { numberId: ObjectId };  // default number -> waNumbers
  status: 'active' | 'suspended';
}

interface Branch extends Base {
  name: string; code: string;        // unique per business, e.g. 'SRT1'
  invoicePrefix: string; address: Address; phone: string;
  hours: { day: 0|1|2|3|4|5|6; open?: string; close?: string; closed: boolean }[];
  holidays: { date: string; name: string }[];
  stations: number;
  waNumberId?: ObjectId;              // overrides business number
  googleReviewUrl?: string;
  pettyCashFloatPaise: number;
  status: 'active' | 'deactivation_requested' | 'deactivated';
}

interface BranchRequest extends Base {
  type: 'add' | 'delete'; branchId?: ObjectId; payload?: { name: string; address: Address };
  reason: string; status: 'pending' | 'approved' | 'rejected';
  handledBy?: ObjectId; handledAt?: Date; rejectReason?: string;
}

interface User extends Base {
  role: 'owner' | 'manager' | 'branch';
  name: string; email: string; phone?: string; passwordHash: string;
  branchIds: ObjectId[];             // owner: [] (all); branch: exactly one
  flags: { manageStaff?: boolean; approvePO?: boolean; viewPayroll?: boolean; editBranchPrices?: boolean; maxDiscountBps?: number; markAttendance?: boolean };
  staffId?: ObjectId;                // manager linked to payroll record
  status: 'active' | 'inactive'; sessionVersion: number;
  failedLogins: number; lockedUntil?: Date; lastLoginAt?: Date;
}

interface Staff extends Base {
  branchId: ObjectId; name: string; phone: string;
  designation: 'stylist' | 'senior_stylist' | 'beautician' | 'receptionist' | 'manager' | 'helper' | 'other';
  joiningDate: string; exitDate?: string; exitReason?: string;
  serviceIds: ObjectId[];
  salary: { type: 'monthly' | 'none'; amountPaise: number };
  commission: { service?: Rule; productPct?: number; overtimePerHourPaise?: number };
  statutory: { pf: boolean; esi: boolean; pt: boolean };
  bankRef?: { bank: string; last4: string };
  documents: { kind: string; s3Key: string }[];
  emergencyContact?: { name: string; phone: string };
  status: 'active' | 'exited';
}
type Rule = { type: 'pct' | 'fixed' | 'slab'; value?: number; slabs?: { uptoPaise: number; bps: number }[] };

interface Customer extends Base {
  name: string; phone: string /* +91XXXXXXXXXX */; altPhone?: string; email?: string;
  gender?: 'male' | 'female' | 'other'; dob?: string; anniversary?: string; address?: Address;
  source: 'walk_in' | 'phone' | 'whatsapp' | 'referral'; referredBy?: ObjectId;
  tags: string[]; waOptIn: boolean; doNotMessage: boolean; notes?: string;
  serviceNotes: { date: string; staffId?: ObjectId; text: string; colourFormula?: string }[]; // capped 200
  stats: { firstVisit?: string; lastVisit?: string; visits: number; spendPaise: number; noShows: number; favServiceId?: ObjectId; favStaffId?: ObjectId };
  walletBalancePaise: number;        // cache of walletLedger
  loyaltyPoints: number;             // cache of loyaltyLedger
  duePaise: number;                  // cache of open dues
  mergedInto?: ObjectId;
}

interface Category extends Base { name: string; parentId?: ObjectId; gender: 'men'|'women'|'unisex'; order: number; active: boolean }

interface Service extends Base {
  categoryId: ObjectId; name: string; gender: 'men'|'women'|'unisex';
  basePricePaise: number; durationMin: number;
  branchPrices: { branchId: ObjectId; pricePaise?: number; active: boolean }[];
  consumables: { productId: ObjectId; qty: number }[];   // use units
  rebookDays?: number; eligibleStaffIds: ObjectId[];      // [] = all
  commission?: Rule; active: boolean;
}

interface Product extends Base {
  name: string; brand?: string; category?: string; type: 'retail' | 'consumable' | 'both';
  sku?: string; purchaseUnit: string; useUnit: string; unitsPerPurchase: number;
  mrpPaise?: number; sellingPricePaise?: number; purchasePricePaise: number; // per purchase unit
  hsn?: string; gstBps?: number;
  reorderLevels: { branchId: ObjectId; qty: number }[]; active: boolean;
}

interface Vendor extends Base { name: string; contact?: string; phone?: string; gstin?: string; address?: Address; terms?: string }
```

**Indexes**

| Collection | Index | Purpose |
| --- | --- | --- |
| platformAdmins | `{email:1}` unique | Login |
| users | `{email:1}` unique; `{businessId:1, role:1}` | Login; user lists |
| branches | `{businessId:1, code:1}` unique | Branch code |
| staff | `{businessId:1, branchId:1, status:1}` | Branch staff lists |
| customers | `{businessId:1, phone:1}` unique; `{businessId:1, 'stats.lastVisit':1}`; `{businessId:1, dob:1}`; text index on name | Lookup, win-back, birthdays, search |
| services | `{businessId:1, categoryId:1}` | Catalogue |
| products | `{businessId:1, type:1}` | Stock lists |

## 4. Data model: appointments, bills, prepaid, day-end

All percentages are stored as basis points (1% = 100 bps). Bill lines embed snapshots so an invoice never changes when a service, product or staff record changes later.

```ts
interface Appointment extends Base {
  branchId: ObjectId; customerId: ObjectId; businessDate: string;
  lines: { _id: ObjectId; serviceId: ObjectId; serviceName: string; staffId: ObjectId; start: Date; end: Date }[];
  start: Date; end: Date;              // min/max of lines, for range queries
  status: 'booked'|'confirmed'|'arrived'|'in_service'|'completed'|'billed'|'cancelled'|'no_show';
  statusLog: { status: string; at: Date; by: ObjectId; reason?: string }[];
  source: 'walk_in'|'phone'|'whatsapp'; notes?: string; billId?: ObjectId;
}

interface StaffBlock extends Base { branchId: ObjectId; staffId: ObjectId; start: Date; end: Date; reason: string }

interface Bill extends Base {
  branchId: ObjectId; invoiceNo: string; fy: string /* '2026-27' */; businessDate: string;
  customerId: ObjectId; customerSnap: { name: string; phone: string; gstin?: string };
  billedByStaffId?: ObjectId; billedByName: string;   // required when created by branch login
  appointmentId?: ObjectId; gstApplied: boolean; pricesInclusive: boolean;
  lines: BillLine[];
  billDiscount?: { type: 'amount'|'pct'; value: number };
  redemptions: { kind: 'package'|'membership'|'loyalty'|'voucher'; refId: ObjectId; lineId?: ObjectId; points?: number; amountPaise: number }[];
  totals: { grossPaise: number; discountPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; roundOffPaise: number; totalPaise: number; paidPaise: number; duePaise: number };
  payments: { mode: 'cash'|'upi'|'card'|'wallet'; amountPaise: number; ref?: string; at: Date }[];
  tips: { staffId: ObjectId; staffName: string; amountPaise: number; payout: 'cash_today'|'payroll' }[];
  status: 'awaiting_approval'|'rejected'|'paid'|'partly_paid'|'cancelled'|'refunded'|'partly_refunded';
  approval?: { reasons: ('discount_over_limit'|'partly_paid')[]; requestedAt: Date; decidedBy?: ObjectId; decidedAt?: Date; rejectReason?: string };
  version: number;                     // 1, 2, ... (edits)
  cancel?: { by: ObjectId; at: Date; reason: string };
  refunds: { amountPaise: number; mode: string; reason: string; by: ObjectId; at: Date }[];
  idempotencyKey: string;
}
interface BillLine {
  _id: ObjectId; kind: 'service'|'product'|'membership'|'package'|'wallet_topup'|'voucher';
  refId: ObjectId; name: string; hsnSac?: string; qty: number;
  unitPricePaise: number; lineDiscount?: { type: 'amount'|'pct'; value: number };
  discountPaise: number; taxablePaise: number; gstBps: number; cgstPaise: number; sgstPaise: number; totalPaise: number;
  staff: { staffId: ObjectId; name: string; splitBps: number; commissionPaise: number }[]; // services: split sums to 10000
  consumablesUsed?: { productId: ObjectId; qty: number; costPaise: number }[];
}

interface BillVersion extends Base { billId: ObjectId; version: number; snapshot: object; editedBy: ObjectId; reason: string }

interface Due extends Base { branchId: ObjectId; customerId: ObjectId; billId: ObjectId; amountPaise: number; settledPaise: number; status: 'open'|'settled'; settlements: { billId?: ObjectId; receiptNo?: string; amountPaise: number; mode: string; at: Date }[] }

interface Plan extends Base {
  type: 'membership'|'package'|'wallet_offer'|'voucher'; name: string; pricePaise: number; validityDays: number;
  membership?: { serviceDiscountBps: number; productDiscountBps: number };
  package?: { items: { serviceId: ObjectId; sessions: number }[] };
  walletOffer?: { creditPaise: number };
  voucher?: { valuePaise: number };
  branchScope: ObjectId[];             // [] = all branches
  active: boolean;
}

interface CustomerPlan extends Base {
  customerId: ObjectId; planId: ObjectId; planSnap: object; soldBillId: ObjectId; soldBranchId: ObjectId;
  validFrom: string; validTill: string;
  sessions?: { serviceId: ObjectId; total: number; used: number; perSessionValuePaise: number }[];
  voucherCode?: string;               // unique per business
  status: 'active'|'frozen'|'expired'|'used_up'|'transferred'|'cancelled';
  log: { action: 'extend'|'freeze'|'unfreeze'|'transfer'|'redeem'|'reverse'; at: Date; by: ObjectId; detail?: object }[];
}

interface WalletLedger extends Base {   // append-only
  customerId: ObjectId; branchId?: ObjectId;
  type: 'topup'|'bonus'|'redeem'|'refund'|'reverse'|'expiry'|'adjust'|'imported';
  amountPaise: number;                 // signed
  billId?: ObjectId; reason?: string; balanceAfterPaise: number;
}
interface LoyaltyLedger extends Base { customerId: ObjectId; type: 'earn'|'redeem'|'reverse'|'expiry'|'adjust'|'imported'; points: number; billId?: ObjectId; balanceAfter: number }

interface Expense extends Base { branchId: ObjectId; businessDate: string; category: string; amountPaise: number; mode: 'cash'|'upi'|'card'|'bank'; paidFrom: 'petty_cash'|'bank'; note?: string; receiptKey?: string; recurringId?: ObjectId }
interface RecurringExpense extends Base { branchId: ObjectId; category: string; amountPaise: number; dayOfMonth: number; active: boolean }
interface PettyCashEntry extends Base { branchId: ObjectId; businessDate: string; type: 'float'|'topup'|'expense'|'deposit'; amountPaise: number; refId?: ObjectId }

interface DayClosure extends Base {
  branchId: ObjectId; businessDate: string;
  expected: { cashPaise: number; upiPaise: number; cardPaise: number };
  counted?: { cashPaise: number; denominations: Record<string, number>; upiPaise: number; cardPaise: number };
  diff?: { cashPaise: number; upiPaise: number; cardPaise: number }; diffReason?: string;
  status: 'open'|'submitted'|'approved';
  submittedBy?: ObjectId; approvedBy?: ObjectId; approvedAt?: Date;
  reopenLog: { by: ObjectId; at: Date; reason: string }[];
  report?: { sentAt?: Date; pdfKey?: string; closedAtSend: boolean };
}

interface Counter { _id: string /* `${businessId}:${branchId}:invoice:${fy}` */; seq: number }
```

**Indexes**

| Collection | Index | Purpose |
| --- | --- | --- |
| appointments | `{businessId:1, branchId:1, businessDate:1}`; `{businessId:1, 'lines.staffId':1, start:1, end:1}`; `{businessId:1, customerId:1, start:-1}` | Calendar, clash check, history |
| staffBlocks | `{businessId:1, staffId:1, start:1}` | Clash check |
| bills | `{businessId:1, invoiceNo:1}` unique; `{businessId:1, branchId:1, businessDate:-1}`; `{businessId:1, customerId:1, businessDate:-1}`; `{businessId:1, status:1, branchId:1}`; `{businessId:1, idempotencyKey:1}` unique | Numbering, lists, profile, approvals, retries |
| dues | `{businessId:1, customerId:1, status:1}` | Collect dues |
| customerPlans | `{businessId:1, customerId:1, status:1}`; `{businessId:1, validTill:1, status:1}`; `{businessId:1, voucherCode:1}` unique sparse | Redemption, expiry, vouchers |
| walletLedger, loyaltyLedger | `{businessId:1, customerId:1, createdAt:-1}` | Ledger view |
| expenses | `{businessId:1, branchId:1, businessDate:-1}` | Lists, day-end |
| dayClosures | `{businessId:1, branchId:1, businessDate:1}` unique | One closure per day |

## 5. Data model: stock, payroll, growth, system

Ledgers here are append-only like the wallet: stock balances and change cursors are caches that can always be rebuilt.

```ts
interface StockMovement extends Base {  // append-only
  branchId: ObjectId; productId: ObjectId; pool: 'retail'|'consumable';
  type: 'purchase'|'sale'|'service_use'|'transfer_out'|'transfer_in'|'adjust'|'internal_use'|'cancel_reverse'|'audit'|'imported';
  qty: number;                          // signed, use units
  unitCostPaise: number; refType?: string; refId?: ObjectId; reason?: string;
  batch?: string; expiry?: string; businessDate: string;
}
interface StockBalance extends Base { branchId: ObjectId; productId: ObjectId; pool: 'retail'|'consumable'; qty: number; lastMovementAt: Date }

interface PurchaseOrder extends Base {
  branchId: ObjectId; vendorId: ObjectId; poNo: string;
  items: { productId: ObjectId; qtyPurchaseUnits: number; ratePaise: number; receivedPurchaseUnits: number }[];
  totalPaise: number; status: 'draft'|'pending_approval'|'approved'|'partly_received'|'received'|'rejected'|'cancelled';
  approvals: { action: string; by: ObjectId; at: Date; reason?: string }[];
  receipts: { at: Date; by: ObjectId; items: { productId: ObjectId; qty: number; batch?: string; expiry?: string }[] }[];
  vendorBill?: { number: string; amountPaise: number; paymentStatus: 'unpaid'|'partly_paid'|'paid'; paidPaise: number };
}
interface Transfer extends Base {
  transferNo: string; fromBranchId: ObjectId; toBranchId: ObjectId;
  items: { productId: ObjectId; pool: 'retail'|'consumable'; qty: number; receivedQty?: number; mismatchReason?: string }[];
  status: 'requested'|'approved'|'dispatched'|'received'|'rejected'|'cancelled';
  log: { action: string; by: ObjectId; at: Date; reason?: string }[];
}
interface StockAudit extends Base { branchId: ObjectId; pool: 'retail'|'consumable'; status: 'counting'|'submitted'|'approved'; lines: { productId: ObjectId; systemQty: number; countedQty?: number }[] }

interface Roster extends Base { branchId: ObjectId; staffId: ObjectId; weekly: { day: number; start?: string; end?: string; off: boolean }[]; overrides: { date: string; start?: string; end?: string; off: boolean }[] }
interface Attendance extends Base {
  branchId: ObjectId; staffId: ObjectId; businessDate: string;
  status: 'present'|'late'|'half_day'|'absent'|'leave'|'week_off'|'holiday';
  inAt?: Date; outAt?: Date; overtimeMin: number; note?: string; markedBy: ObjectId;
  edits: { by: ObjectId; at: Date; reason: string; before: object }[];
}
interface Leave extends Base { branchId: ObjectId; staffId: ObjectId; from: string; to: string; type: 'paid'|'unpaid'; status: 'approved'|'rejected'; reason?: string }
interface Advance extends Base { staffId: ObjectId; branchId: ObjectId; amountPaise: number; date: string; recoveryPerMonthPaise: number; recoveredPaise: number; status: 'open'|'closed' }
interface PayrollRun extends Base {
  branchId: ObjectId; month: string /* '2026-10' */;
  status: 'draft'|'reviewed'|'locked'|'paid';
  lines: { staffId: ObjectId; staffName: string; paidDays: number; salaryPaise: number; commissionPaise: number; overtimePaise: number; tipsPaise: number; incentivesPaise: number; advancePaise: number; pfPaise: number; esiPaise: number; ptPaise: number; otherDeductionPaise: number; netPaise: number;
           adjustments: { field: string; deltaPaise: number; reason: string; by: ObjectId; at: Date }[]; paid?: { mode: string; date: string } }[];
  totals: { netPaise: number }; lockedBy?: ObjectId; lockedAt?: Date;
}
interface Payslip extends Base { runId: ObjectId; staffId: ObjectId; month: string; pdfKey: string; sentAt?: Date }

interface Lead extends Base {
  branchId: ObjectId; name?: string; phone: string; source: 'whatsapp'|'walk_in'|'phone';
  serviceIds: ObjectId[]; budgetPaise?: number; stage: 'new'|'contacted'|'interested'|'booked'|'lost';
  lostReason?: string; assignedTo?: ObjectId; followUpDate?: string; notes?: string;
  conversationId?: ObjectId; customerId?: ObjectId;
}

interface WaNumber extends Base { phone: string; aisensy: { apiKeyEnc: string; projectId: string; webhookSecretEnc: string }; branchIds: ObjectId[]; status: 'active'|'error'; lastCheckAt?: Date; lowBalance: boolean }
interface WaTemplate extends Base { numberId: ObjectId; name: string; language: string; category: 'marketing'|'utility'|'authentication'; body: string; variables: string[]; status: 'approved'|'pending'|'rejected'; syncedAt: Date }
interface WaConversation extends Base { numberId: ObjectId; branchId: ObjectId; phone: string; customerId?: ObjectId; leadId?: ObjectId; lastMessageAt: Date; lastInboundAt?: Date; unread: number; assignedTo?: ObjectId }
interface WaMessage extends Base {
  conversationId: ObjectId; direction: 'in'|'out'; providerMessageId?: string;
  kind: 'text'|'template'|'media'; text?: string; templateId?: ObjectId; variables?: string[]; mediaKey?: string;
  status: 'queued'|'sent'|'delivered'|'read'|'failed'; error?: string; costPaise?: number;
  origin: 'inbox'|'campaign'|'automation'|'transactional'; originId?: ObjectId; sentBy?: ObjectId;
}
interface Campaign extends Base { name: string; numberId: ObjectId; templateId: ObjectId; audience: { kind: 'segment'|'upload'|'selection'; segment?: object; customerIds?: ObjectId[]; uploadKey?: string }; variableMap: object; scheduledAt?: Date; status: 'draft'|'scheduled'|'sending'|'paused'|'completed'|'cancelled'; stats: { total: number; excluded: number; sent: number; delivered: number; read: number; failed: number; costPaise: number } }
interface Automation extends Base { key: 'booking_confirmation'|'reminder_24h'|'reminder_2h'|'rebooking'|'birthday'|'anniversary'|'winback'|'feedback'|'review_push'|'membership_expiry'|'package_last_session'; enabled: boolean; templateId?: ObjectId; settings: object }
interface AutomationSend { _id: string /* `${key}:${refId}:${period}` dedupe key */; businessId: ObjectId; messageId: ObjectId; at: Date }
interface Feedback extends Base { branchId: ObjectId; billId: ObjectId; customerId: ObjectId; staffIds: ObjectId[]; rating: 1|2|3|4|5; comment?: string; reviewLinkSent: boolean }

interface AuditLog {                    // append-only, no Base soft delete
  _id: ObjectId; businessId?: ObjectId; branchId?: ObjectId;
  actor: { kind: 'platform'|'tenant'|'system'; id?: ObjectId; role?: string; name: string }; billedByName?: string;
  action: string /* e.g. 'bill.cancel' */; entity: string; entityId?: ObjectId;
  before?: object; after?: object; reason?: string; ip?: string; userAgent?: string; at: Date;
}
interface Notification { _id: ObjectId; businessId: ObjectId; userId: ObjectId; type: string; title: string; body: string; link?: string; readAt?: Date; createdAt: Date }
interface DailySummary { _id: string /* `${branchId}:${date}` */; businessId: ObjectId; branchId: ObjectId; businessDate: string;
  sales: { grossPaise: number; discountPaise: number; netPaise: number; taxPaise: number; servicesPaise: number; productsPaise: number; plansPaise: number };
  collections: Record<'cash'|'upi'|'card'|'wallet', number>; refundsPaise: number; tipsPaise: number;
  counts: { bills: number; cancelled: number; customers: number; newCustomers: number; appointments: number; noShows: number };
  byService: Record<string, { count: number; netPaise: number }>; byStaff: Record<string, { netPaise: number; commissionPaise: number }>; byBilledBy: Record<string, { bills: number; netPaise: number }>;
  updatedAt: Date }
interface ChangeCursor { _id: string /* scope, e.g. 'appointments:<branchId>:<date>' */; businessId: ObjectId; rev: number; updatedAt: Date }
interface ImportJob { _id: ObjectId; businessId: ObjectId; type: string; fileKey: string; status: 'validating'|'ready'|'importing'|'done'|'failed'; errors: { row: number; message: string }[]; summary?: object; createdBy: ObjectId; confirmedBy?: ObjectId }
```

**Indexes**

| Collection | Index | Purpose |
| --- | --- | --- |
| stockMovements | `{businessId:1, branchId:1, productId:1, createdAt:-1}` | Ledger |
| stockBalances | `{businessId:1, branchId:1, productId:1, pool:1}` unique | Balance |
| purchaseOrders, transfers | `{businessId:1, status:1, createdAt:-1}` | Lists |
| attendance | `{businessId:1, staffId:1, businessDate:1}` unique; `{businessId:1, branchId:1, businessDate:1}` | Daily sheet |
| payrollRuns | `{businessId:1, branchId:1, month:1}` unique | One run per branch-month |
| leads | `{businessId:1, branchId:1, stage:1}`; `{businessId:1, followUpDate:1}` | Board, reminders |
| waConversations | `{businessId:1, numberId:1, phone:1}` unique; `{businessId:1, branchId:1, lastMessageAt:-1}` | Inbox |
| waMessages | `{conversationId:1, createdAt:-1}`; `{providerMessageId:1}` unique sparse | Thread, webhook dedupe |
| auditLogs | `{businessId:1, at:-1}`; `{businessId:1, entity:1, entityId:1}` | Search; TTL none (archived after 3 years) |
| notifications | `{userId:1, createdAt:-1}`; TTL on `createdAt` 90 days | Bell |
| dailySummaries | `{businessId:1, businessDate:1}` | Reports |
| changeCursors | `_id` only | Polling |

## 6. API endpoints: platform, setup, front desk

All paths are under `/api/v1`. Roles: **SA** Super Admin, **O** owner, **M** manager (assigned branches, flags), **B** branch login. Success responses are `{ data, meta? }`; errors are `{ error: { code, message, fields? } }` (section 11). Lists accept `page`, `limit` (max 100), `sort`, `q`.

**Auth**

| Method | Path | Roles | Request → Response |
| --- | --- | --- | --- |
| POST | `/auth/login` | public | `{email, password}` → `{accessToken, user}` + refresh cookie |
| POST | `/auth/refresh` | cookie | — → `{accessToken}` + rotated cookie |
| POST | `/auth/logout` | any | — → 204 |
| GET | `/auth/me` | any | → `{user, role, business, branches[], flags}` |

**Super Admin (`/admin`)**

| Method | Path | Request → Response |
| --- | --- | --- |
| GET | `/admin/stats` | → platform KPIs |
| GET, POST | `/admin/businesses` | list; create `{business, owner:{name,email,phone,password}, headBranch:{...,loginEmail,loginPassword}}` → business with ids (one transaction) |
| GET, PATCH | `/admin/businesses/:id` | detail; update profile, GST, status (`suspended` revokes all sessions) |
| POST | `/admin/businesses/:id/branches` | `{name, code, address, phone, invoicePrefix, loginEmail, loginPassword}` → branch + branch user |
| POST | `/admin/branches/:id/deactivate` | `{reason}` → branch read-only, branch user inactive |
| GET | `/admin/branch-requests` | `?status=` |
| POST | `/admin/branch-requests/:id/approve` \| `/reject` | approve add → creates branch (same body as above); delete → deactivates; reject `{reason}` |
| GET | `/admin/businesses/:id/users` | owner, managers, branch logins |
| POST | `/admin/users/:id/password` | `{password}` → 204, sessions revoked |
| POST | `/admin/users/:id/status` | `{status}` |
| PUT | `/admin/businesses/:id/whatsapp` | `{phone, apiKey, projectId, branchIds?}` → number (keys encrypted) |
| POST | `/admin/wa-numbers/:id/test` \| `/sync-templates` | → status, template count |
| POST | `/admin/businesses/:id/imports` | multipart `{type, file}` → ImportJob (validating) |
| GET | `/admin/imports/:id` | → status, errors, summary |
| POST | `/admin/imports/:id/confirm` | → importing |
| GET | `/admin/jobs/failed` ; POST `/admin/jobs/:id/retry` | failed job list; retry |
| GET | `/admin/businesses/:id/audit-logs` | audit search |

**Business, branches, users**

| Method | Path | Roles | Request → Response |
| --- | --- | --- | --- |
| GET, PATCH | `/business/settings` | O (GET: O, M, B limited fields) | settings object (section 3 Business) |
| GET | `/branches` | O, M, B | branches visible to the user |
| PATCH | `/branches/:branchId` | O, M | `{hours, holidays, stations, googleReviewUrl, pettyCashFloatPaise}` |
| POST | `/business/branch-requests` | O | `{type, branchId?, payload?, reason}` |
| GET | `/business/branch-requests` | O | list with status |
| GET, POST | `/business/managers` | O | create `{name, email, phone, password, branchIds, flags, staffId?}` |
| PATCH | `/business/managers/:id` | O | branches, flags, status (revokes sessions on branch/role change) |
| GET | `/business/branch-logins` | O, M | branch users with status, last login |
| PATCH | `/business/branch-logins/:id/flags` | O, M (own branch) | `{markAttendance}` |
| POST | `/business/users/:id/password` | O | `{password}` → 204 (manager or branch user only) |

**Catalogue**

| Method | Path | Roles | Request → Response |
| --- | --- | --- | --- |
| GET, POST | `/categories` | read all; write O | `{name, parentId?, gender, order}` |
| PATCH | `/categories/:id` ; POST `/categories/reorder` | O | — |
| GET | `/services` | O, M, B | `?branchId&categoryId&active` → services with `effectivePricePaise` for branch |
| POST, PATCH | `/services`, `/services/:id` | O | full service body; manager may PATCH only `branchPrices` for assigned branches with `editBranchPrices` |
| POST | `/services/bulk-price/preview` \| `/apply` | O | `{categoryId, branchId?, changeBps}` → rows old/new |

**Appointments**

| Method | Path | Roles | Request → Response |
| --- | --- | --- | --- |
| GET | `/branches/:branchId/appointments` | O, M, B | `?from&to&staffId&status` → appointments + staff columns + blocks + roster for the range |
| POST | `/branches/:branchId/appointments` | O, M, B | `{customerId \| newCustomer:{name,phone}, lines:[{serviceId, staffId?, start}], source, notes, notify}` → 201 or 409 `SLOT_CLASH` with details |
| POST | `/branches/:branchId/appointments/walk-in` | O, M, B | `{customerId \| newCustomer, serviceIds}` → appointment starting now |
| PATCH | `/appointments/:id` | O, M, B | lines, notes (re-checks clashes; `__v` required) |
| POST | `/appointments/:id/status` | O, M, B | `{status, reason?}` → 422 `INVALID_TRANSITION` if not allowed |
| GET | `/branches/:branchId/availability` | O, M, B | `?serviceId&date` → free slots per eligible staff |
| POST, DELETE | `/branches/:branchId/staff-blocks` | O, M, B | `{staffId, start, end, reason}` |

**Customers**

| Method | Path | Roles | Request → Response |
| --- | --- | --- | --- |
| GET | `/customers` | O, M, B | `?q&tags&segment&lastVisitFrom&lastVisitTo&branchId` → masked for M, B |
| GET | `/customers/:id` | O, M, B | `?reveal=1` returns full phone (audited) |
| POST, PATCH | `/customers`, `/customers/:id` | O, M, B | profile fields; 409 `DUPLICATE_PHONE` with existing id |
| GET | `/customers/:id/history` | O, M, B | `?type=bills\|appointments\|plans\|wallet\|loyalty\|feedback\|whatsapp` |
| POST | `/customers/:id/notes` | O, M, B | `{text, colourFormula?, staffId?}` |
| POST | `/customers/:id/merge` | O, M | `{duplicateId}` → moves bills, plans, ledgers, conversations (transaction) |
| GET | `/customers/export` | O | → xlsx stream (audited) |
| GET | `/segments/:key/count` | O | → audience size for campaigns |

## 7. API endpoints: money, people, stock, growth, system

**Bills and dues**

| Method | Path | Roles | Request → Response |
| --- | --- | --- | --- |
| POST | `/branches/:branchId/bills/preview` | O, M, B | bill draft → computed totals, GST, redemptions, approval reasons (no write) |
| POST | `/branches/:branchId/bills` | O, M, B | header `Idempotency-Key`; `{customerId, billedByStaffId, appointmentId?, lines[], billDiscount?, redemptions[], tips[], payments[], collectDues?:[{dueId, amountPaise}]}` → bill (`paid`, `partly_paid` never directly: `awaiting_approval` when due > 0 or discount over limit) |
| GET | `/branches/:branchId/bills` | O, M, B | `?from&to&status&mode&billedBy&staffId&customerId` |
| GET | `/bills/:id` | O, M, B | bill + versions list + audit |
| GET | `/approvals` | O, M | `?branchId` → awaiting\_approval bills |
| POST | `/bills/:id/approve` \| `/reject` | O, M | reject `{reason}` |
| PUT | `/bills/:id` | O, M | full bill body + `{reason, __v}` → new version (owner only if day closed) |
| POST | `/bills/:id/cancel` | O, M | `{reason}` → reversals (section 8) |
| POST | `/bills/:id/refund` | O, M | `{amountPaise, mode, reason}` |
| GET | `/bills/:id/pdf` | O, M, B | `?format=a4\|thermal` → presigned URL |
| POST | `/bills/:id/send` | O, M, B | → WhatsApp queued |
| GET | `/customers/:id/dues` ; POST `/branches/:branchId/due-receipts` | O, M, B | `{customerId, payments[]}` → receipt settling dues oldest first |

**Plans, wallet, loyalty**

| Method | Path | Roles | Request → Response |
| --- | --- | --- | --- |
| GET, POST, PATCH | `/plans`, `/plans/:id` | write O; read all | plan body; sold plans: only `active` editable |
| GET | `/customers/:id/plans` | O, M, B | active and past |
| POST | `/customer-plans/:id/extend` \| `/freeze` \| `/unfreeze` \| `/transfer` | O, M | `{days}` / — / — / `{toCustomerId}` |
| GET | `/customers/:id/wallet` | O, M, B | balance + ledger |
| POST | `/customers/:id/wallet/adjust` | O | `{amountPaise (signed), reason}` |
| GET | `/customers/:id/loyalty` | O, M, B | balance + ledger |
| GET | `/vouchers/:code` | O, M, B | → validity, value |

**Staff, attendance, roster, payroll**

| Method | Path | Roles | Request → Response |
| --- | --- | --- | --- |
| GET, POST, PATCH | `/staff`, `/staff/:id` | O; M with `manageStaff` (assigned branches) | staff body |
| GET | `/branches/:branchId/billed-by` | O, M, B | active receptionists |
| GET, PUT | `/staff/:id/roster` | O, M | weekly + overrides |
| GET | `/branches/:branchId/attendance` | O, M, B (`markAttendance`) | `?date` or `?month` |
| PUT | `/branches/:branchId/attendance/:date` | O, M, B (`markAttendance`) | `{entries:[{staffId, status?, inAt?, outAt?, note?}], reason?}` (reason required for past dates) |
| GET, POST | `/branches/:branchId/leaves` ; PATCH `/leaves/:id` | O, M | leave body |
| GET, POST | `/branches/:branchId/advances` | O, M | advance body |
| POST | `/branches/:branchId/payroll-runs` | O, M (`viewPayroll`) | `{month}` → job; run in draft |
| GET | `/payroll-runs/:id` | O, M (`viewPayroll`) | run with lines and calculation detail |
| POST | `/payroll-runs/:id/adjust` | O, M | `{staffId, field, deltaPaise, reason}` |
| POST | `/payroll-runs/:id/review` \| `/lock` \| `/mark-paid` | review O, M; lock O; mark-paid O | mark-paid `{staffIds?, mode, date}` |
| POST | `/payroll-runs/:id/payslips` \| `/payslips/send` | O | generate PDFs; send on WhatsApp |

**Inventory**

| Method | Path | Roles | Request → Response |
| --- | --- | --- | --- |
| GET, POST, PATCH | `/products`, `/products/:id` | write O | product body |
| GET | `/branches/:branchId/stock` | O, M, B | `?pool&status` → balances with status |
| GET | `/branches/:branchId/stock/movements` | O, M, B | `?productId&type&from&to` |
| POST | `/branches/:branchId/stock/adjust` | O, M, B | `{productId, pool, qty (signed), reason, type: adjust\|internal_use}` |
| GET, POST, PATCH | `/vendors` | O, M | vendor body |
| GET, POST | `/purchase-orders` ; GET, PATCH `/purchase-orders/:id` | O, M, B | PO body (draft) |
| POST | `/purchase-orders/:id/submit` \| `/approve` \| `/reject` \| `/receive` \| `/cancel` \| `/vendor-bill` | submit O, M, B; approve/reject O, M (`approvePO`); receive O, M, B | receive `{items:[{productId, qty, batch?, expiry?}]}` |
| GET, POST | `/transfers` ; POST `/transfers/:id/approve` \| `/reject` \| `/dispatch` \| `/receive` \| `/cancel` | O, M, B per state | receive `{items:[{productId, receivedQty, mismatchReason?}]}` |
| POST | `/branches/:branchId/stock-audits` ; PUT `/stock-audits/:id/counts` ; POST `/stock-audits/:id/submit` \| `/approve` | O, M, B; approve O, M | counts body |

**Leads and WhatsApp**

| Method | Path | Roles | Request → Response |
| --- | --- | --- | --- |
| GET, POST, PATCH | `/leads`, `/leads/:id` | O, M, B | lead body; stage change `lost` needs `lostReason` |
| POST | `/leads/:id/convert` | O, M, B | → customer id |
| GET | `/whatsapp/conversations` | O, M, B | `?branchId&unread&assignedTo&leadOnly` |
| GET | `/whatsapp/conversations/:id/messages` | O, M, B | `?before` (cursor), marks read |
| POST | `/whatsapp/conversations/:id/messages` | O, M, B | `{text}` (only inside 24 h, else 422 `WINDOW_CLOSED`) or `{templateId, variables}` |
| PATCH | `/whatsapp/conversations/:id` | O, M, B | `{assignedTo}` |
| GET | `/whatsapp/templates` | O, M, B | approved templates for the number |
| GET, POST, PATCH | `/whatsapp/campaigns`, `/:id` ; POST `/:id/schedule` \| `/pause` \| `/resume` \| `/cancel` ; POST `/whatsapp/campaigns/estimate` | O | campaign body; estimate → audience, excluded, cost |
| GET, PATCH | `/whatsapp/automations`, `/:key` | O (M read) | `{enabled, templateId, settings}` |
| POST | `/webhooks/aisensy/:numberId` | AiSensy (signed) | inbound messages and status callbacks (section 9) |

**Expenses, day-end, reports, audit, system**

| Method | Path | Roles | Request → Response |
| --- | --- | --- | --- |
| GET, POST, PATCH | `/branches/:branchId/expenses` | O, M, B | expense body; receipt via presigned upload |
| GET, POST | `/branches/:branchId/recurring-expenses` | O, M | — |
| GET, POST | `/branches/:branchId/petty-cash` | read all; top-up O, M | `{type: topup\|deposit, amountPaise}` |
| GET | `/branches/:branchId/closures/:date` | O, M, B | expected values, counted, status |
| POST | `/branches/:branchId/closures/:date/submit` | O, M, B | `{denominations, upiPaise, cardPaise, diffReason?}` |
| POST | `/branches/:branchId/closures/:date/approve` \| `/reopen` | approve O, M; reopen O | reopen `{reason}` |
| GET | `/dashboard` | O, M | `?branchId\|all&range` |
| GET | `/reports/:name` | O, M (B: `my-day` only) | `?from&to&branchId&groupBy` → `{summary, rows}`; `&format=xlsx\|pdf` (O; M with permission) |
| GET | `/audit-logs` | O, M (assigned branches) | `?from&to&branchId&userId&action&entity&entityId` |
| GET | `/notifications` ; POST `/notifications/read` | all | `{ids? \| all:true}` |
| GET | `/changes` | all | `?scopes=a,b&since=<cursor>` → `{changed: string[], cursor}` (section 9) |
| POST | `/uploads/presign` | all | `{kind, contentType}` → `{url, key}` (max 5 MB images, 10 MB files) |

## 8. Core flows and transactions

Every flow below runs inside one MongoDB transaction (`session.withTransaction`, majority write concern, retried on transient errors); either all writes land or none do. Side effects outside the database (WhatsApp, PDF, notifications) are enqueued only after commit.

**Bill save (`POST /bills`)**

1. Check `Idempotency-Key`: if a bill exists with that key, return it (200).
2. Load business settings, branch, customer, services/products with branch prices, active customer plans; reject if branch inactive or `dayClosures` for the business date is approved (409 `DAY_CLOSED`).
3. Validate: billed-by required for branch role; staff splits sum to 10000 bps; redemptions valid (session left, plan active, in branch scope, wallet balance, loyalty minimum).
4. Compute with the pure function `billing.compute(draft, settings)` per BR-01 to BR-03: line discounts, membership discount, bill discount spread, package zeroing, loyalty, GST (only if `gst.enabled`), CGST/SGST split, round-off, commission per staff.
5. Decide status: `awaiting_approval` if `duePaise > 0` or any discount exceeds the creator's limit (owner never needs approval); else `paid`.
6. In the transaction: `$inc` counter → invoice number; insert bill; if `paid`, apply effects (step 7); else hold effects until approval. Write audit `bill.create`; bump change cursors `bills:<branch>`, `appointments:<branch>:<date>` (if linked).
7. **Effects** (on `paid`, or on approval): consume package sessions; post wallet `redeem` and `topup`/`bonus` for wallet lines; loyalty `earn`/`redeem`; create customer plans for sold memberships, packages, vouchers; stock movements `sale` (retail) and `service_use` (consumables per BR-07) and update balances; create `Due` if due > 0; settle collected dues; set appointment `billed`; update customer stats and caches; upsert daily summary.
8. After commit: enqueue PDF, WhatsApp bill (if requested), notifications (approval needed → managers and owner; discount over owner alert → owner WhatsApp alert).

**Approve / reject:** approve runs step 7 effects and sets `paid` or `partly_paid`; reject sets `rejected` with reason and writes no effects (the invoice number stays used and shows as Rejected in reports).

**Edit (`PUT /bills/:id`):** reverse the current version's effects (as in cancel), store `BillVersion`, recompute, re-apply effects, increment `version`, audit `bill.edit` with before/after and reason. Invoice number unchanged.

**Cancel:** reverse every effect with compensating entries, never deletes: package `sessions.used −`, wallet `reverse`, loyalty `reverse`, sold customer plans set `cancelled` (blocked if already redeemed — 422 `PLAN_IN_USE`), stock `cancel_reverse`, due voided, commission and tips excluded from payroll by status, summary updated. Status `cancelled`; audit `bill.cancel`; owner WhatsApp alert.

**Refund:** records refund entry; status `refunded` or `partly_refunded`; reduces the day's collection in summaries; cash refunds reduce expected cash.

**Day-end submit and approve:** submit computes expected per BR-06 from bills, dues, refunds, expenses, petty cash and cash tips for the branch date, stores counted and differences (reason required if any non-zero). Approve sets `approved`, after which bill create/edit/cancel for that date returns 409 `DAY_CLOSED` except owner edits. Reopen (owner) appends to `reopenLog` and sets `submitted`.

**Payroll lock:** recompute all lines from source data, compare with draft; if any source changed since draft, return 409 `PAYROLL_STALE` with a prompt to refresh. On lock: mark advances recovered, freeze run, enqueue payslips.

**Transfer receive:** `transfer_out` posted at dispatch from the sender; `transfer_in` posted at receipt for received quantities; mismatches stored on the line and audited.

**Clash check (appointments):** for each line, query appointments (status not cancelled/no-show) and staff blocks where `staffId` matches and `start < lineEnd && end > lineStart`; also check roster, approved leave, branch hours and holidays. Runs inside the same transaction as the insert to prevent double booking.

## 9. Polling change-check and AiSensy integration

**Change-check.** Without sockets, the frontend polls (5–15 s on a few screens), so the poll must be cheap: one Redis lookup, no MongoDB query.

- Each write that affects a polled screen bumps a scope counter in Redis: `INCR chg:<businessId>:<scope>` (and mirrors it to `changeCursors` every minute for recovery).
- Scopes: `wa-conversation:<id>`, `wa-inbox:<branchId>`, `bills:<branchId>`, `appointments:<branchId>:<date>`, `notifications:<userId>`.
- `GET /changes?scopes=s1,s2&since=<cursor>`: the cursor is a compact encoding of the last seen counter per scope. The API reads the counters with one `MGET`, returns `{changed: [scopes that moved], cursor}`, and responds with HTTP 204 when nothing changed.
- Authorisation is checked on scopes (branch and user ownership) using the cached user context; responses are not cached by proxies (`Cache-Control: no-store`).
- Target: p95 under 20 ms; rate limit 30 requests per minute per user for this endpoint.

**AiSensy integration** (adapter in `packages/integrations/aisensy`)

| Concern | Rule |
| --- | --- |
| Credentials | Per `WaNumber`: API key and webhook secret encrypted with AWS KMS data key (AES-256-GCM); decrypted only in the worker |
| Outbound | All sends go through the `whatsapp-send` queue: template messages with variables, session text inside 24 h, media (bill PDF via presigned URL). Rate limit per number (configurable, default 20 messages per second). |
| 24-hour window | `lastInboundAt` on the conversation; session text rejected with `WINDOW_CLOSED` if older than 24 h |
| Inbound webhook | `POST /webhooks/aisensy/:numberId`: verify signature or shared secret; store raw payload in `webhookEvents` (TTL 7 days); enqueue `whatsapp-webhook`; respond 200 within 1 s |
| Processing | Dedupe by provider message ID; find or create conversation (number + phone); match customer by phone; if none, create lead (source WhatsApp); increment unread; bump `wa-inbox` and `wa-conversation` scopes; parse feedback replies (1–5) when a feedback request is pending |
| Status callbacks | Update message status and campaign stats; store cost estimate by category |
| Errors | Retry 3 times (30 s, 2 min, 10 min); low balance error → pause campaigns and automations for that number, set `lowBalance`, notify owner in-app and via dashboard alert |
| Template sync | On demand and nightly; templates not approved are hidden from pickers |
| Opt-out | Inbound "STOP" sets `waOptIn=false` and `doNotMessage=true` on the customer |

## 10. Background jobs

The worker app runs BullMQ processors; every job is idempotent (keyed by a natural job ID) so retries never double-send or double-post.

| Queue | Job ID / dedupe key | Schedule | Work | Retries |
| --- | --- | --- | --- | --- |
| whatsapp-send | message `_id` | On enqueue | Send via AiSensy, update status | 3, backoff |
| whatsapp-webhook | provider message ID | On webhook | Section 9 processing | 5 |
| automation-scan | `scan:<businessId>:<15-min slot>` | Every 15 min | Find due reminders, rebooking, birthdays, anniversaries, win-back, expiries, feedback; insert `AutomationSend` dedupe key; enqueue sends respecting quiet hours and daily cap | 3 |
| day-end-report | `dayend:<businessId>:<date>` | Per business at `dayEndReportTime` IST | Build report per branch (closed or not), PDF to S3, WhatsApp to owner's phone | 3 |
| daily-summary | `sum:<branchId>:<date>` | After bill effects; nightly 02:00 full rebuild of yesterday | Recompute summary from bills | 3 |
| ledger-check | `ledger:<date>` | Nightly 03:00 | Rebuild wallet, loyalty, stock balances; alert on mismatch | 1 |
| plan-expiry | `expiry:<date>` | Nightly 00:30 | Expire plans, vouchers, loyalty points; post expiry ledger | 3 |
| recurring-expense | `rexp:<id>:<month>` | Daily 06:00 | Create due recurring expenses | 3 |
| stock-alerts | `stock:<branchId>:<date>` | After movements; nightly expiry scan | Notifications for low, negative, near expiry | 3 |
| pdf-generate | `pdf:<type>:<id>:<version>` | On request | Puppeteer render to S3 | 3 |
| payroll-draft | `payroll:<runId>` | On request | BR-05 per staff | 1 |
| campaign-send | `campaign:<id>` | At schedule | Resolve audience, exclude opt-outs, batch to whatsapp-send | 3 |
| import | `import:<jobId>` | On upload / confirm | Validate, then insert in batches of 500 in transactions | 1 |
| template-sync | `tpl:<numberId>:<date>` | Nightly 01:00 | Sync AiSensy templates | 3 |

Failed jobs are kept 7 days and listed at `/admin/jobs/failed`. More than 1% failures in an hour raises a Sentry alert.

## 11. Error codes

Every error response is `{ error: { code, message, fields?, details? } }`; the frontend keys behaviour off `code`, never the message.

| HTTP | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Zod failure; `fields` maps path → message |
| 401 | `UNAUTHENTICATED` | Missing or expired access token |
| 401 | `INVALID_CREDENTIALS` | Login email or password wrong |
| 401 | `SESSION_REVOKED` | Password changed, user deactivated, roles changed |
| 403 | `ACCOUNT_LOCKED` | 5 failed logins; `details.until` |
| 403 | `ACCOUNT_INACTIVE` | User, branch or business inactive or suspended |
| 403 | `FORBIDDEN` | Role, branch or flag check failed |
| 404 | `NOT_FOUND` | Missing or outside tenant (never reveals existence) |
| 409 | `VERSION_CONFLICT` | `__v` mismatch on edit |
| 409 | `DUPLICATE_PHONE` | Customer phone exists; `details.customerId` |
| 409 | `DUPLICATE_EMAIL` | Login email exists |
| 409 | `SLOT_CLASH` | Appointment overlap; `details.conflicts[]` |
| 409 | `DAY_CLOSED` | Branch date approved; owner-only edits |
| 409 | `PAYROLL_STALE` | Source data changed since draft |
| 422 | `INVALID_TRANSITION` | Status change not allowed (main SRS section 7) |
| 422 | `DISCOUNT_LIMIT` | Returned by preview only, with the limit |
| 422 | `INSUFFICIENT_WALLET` / `NO_SESSIONS_LEFT` / `PLAN_INACTIVE` / `PLAN_OUT_OF_SCOPE` | Redemption invalid |
| 422 | `PLAN_IN_USE` | Cancel blocked: sold plan already redeemed |
| 422 | `SPLIT_INVALID` | Staff splits do not total 100% |
| 422 | `WINDOW_CLOSED` | WhatsApp session text outside 24 h |
| 422 | `WA_NOT_CONFIGURED` / `WA_LOW_BALANCE` | WhatsApp unavailable |
| 422 | `BRANCH_INACTIVE` | Write to a deactivated branch |
| 429 | `RATE_LIMITED` | Rate limit hit; `Retry-After` header |
| 500 | `INTERNAL` | Unexpected; message generic, `requestId` for support |

## 12. Security, configuration, operations and testing

**Security**

- HTTPS only behind the ALB; HSTS; helmet defaults; CORS allow-list of app domains with credentials.
- Cookies: refresh token httpOnly, Secure, SameSite=Strict, path `/auth`; CSRF risk limited because all state-changing calls need the bearer access token.
- Rate limits (Redis): login 5/min/IP; API 300/min/user; `/changes` 30/min/user; webhooks 600/min/number.
- Input: Zod on every route; Mongo operators stripped from user input (`express-mongo-sanitize`); max JSON body 1 MB.
- Secrets in AWS Secrets Manager; AiSensy keys and bank references encrypted with KMS; never logged.
- Uploads only via presigned S3 URLs with content-type and size limits; files private, served by presigned GET (15 min).
- Automated isolation tests (below) are a release gate.

**Configuration (environment)**

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | Atlas connection (replica set) |
| `REDIS_URL` | Redis for cache, rate limits, queues, change counters |
| `JWT_SECRET`, `JWT_ACCESS_TTL` | Access token signing, default 15 min |
| `REFRESH_TTL_SUPERADMIN`, `_OWNER`, `_MANAGER`, `_BRANCH` | 12 h, 30 d, 30 d, 7 d |
| `KMS_KEY_ID` | Encryption of AiSensy keys |
| `S3_BUCKET`, `AWS_REGION` | Files, ap-south-1 |
| `AISENSY_BASE_URL`, `WEBHOOK_BASE_URL` | Provider and callback base |
| `SENTRY_DSN`, `LOG_LEVEL` | Observability |
| `APP_ORIGINS` | CORS allow-list |

**Operations**

- Environments: local (Docker Compose with Mongo replica set and Redis), staging, production; identical images.
- CI: lint, type-check, unit and integration tests, build; deploy to staging on merge; production on tag with zero-downtime rolling update.
- Database changes through versioned migration scripts in `packages/db/migrations` (index builds in background).
- Logs: pino JSON with `requestId`, `businessId`, `userId`, route, latency; no customer phone numbers or tokens in logs.
- Health: `GET /health` (process) and `/ready` (Mongo, Redis reachable).
- Backups: Atlas continuous backup, 7-day point-in-time restore, 30-day snapshots; quarterly restore drill.

**Testing**

| Level | Scope | Gate |
| --- | --- | --- |
| Unit | `billing.compute`, commission, payroll, day-end expected, consumable conversion, status machines, cursor encoding | 70%+ coverage on `packages/core` |
| Integration | Every endpoint: success, validation, each role, wrong branch, other business; transactions roll back on injected failure | All pass |
| Isolation suite | Generated test per route: user of business A requests records of business B → 404; manager of branch A → branch B → 403 | Release blocker |
| Concurrency | 50 parallel bill saves on one branch → unique, gap-free invoice numbers; parallel bookings on one slot → exactly one succeeds | All pass |
| Load (k6) | Peak mix: polling, calendar, bill save; targets in main SRS NFR-01 to NFR-03 | Before launch |
| Contract | Zod schemas shared with frontend; type-check of web against `@glox/schemas` | CI |

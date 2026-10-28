# Glox Salon Management System — Database Design v1.0

Oct 26, 2026 · @Jagdish Kumawat

## 1. Overview and conventions

The database is one MongoDB Atlas cluster with 53 collections, shared by every salon business; each salon's data is separated by a `businessId` field on every document. This document is the single source of truth for the data model; the Backend SRS (Glox Salon Management System — Backend SRS v1.0) links here.

**How to read the field tables:** every collection table lists Field, Type, Required (✓ = required), Ref or values (the collection it points to, or allowed values) and Meaning. Fields inside an embedded object are written with a dot, e.g. `gst.enabled`. Embedded arrays get their own sub-table.

**Naming**

| Rule | Example |
| --- | --- |
| Collections: plural camelCase | `customerPlans`, `stockMovements` |
| Fields: camelCase | `businessDate`, `lastVisit` |
| References: target name + `Id` / `Ids` | `customerId`, `branchIds` |
| Money: integer paise, suffix `Paise` | `totalPaise: 118000` = ₹1,180.00 |
| Percentages: basis points, suffix `Bps` | `gstBps: 1800` = 18% |
| Business dates: IST string `YYYY-MM-DD` | `businessDate: '2026-10-26'` |
| Timestamps: UTC `Date` | `createdAt` |
| Quantities: integer use units | `qty: 30` = 30 ml |
| Enums: lower snake\_case strings | `'awaiting_approval'` |

**Base fields.** Every tenant collection (all except `platformAdmins`, `businesses`, `counters`, `auditLogs`, `notifications`, `dailySummaries`, `changeCursors`, `automationSends`, `webhookEvents`, `importJobs`, emailRegistry) carries these; they are not repeated in the tables below.

| Field | Type | Req | Meaning |
| --- | --- | --- | --- |
| `_id` | ObjectId | ✓ | MongoDB default id |
| `businessId` | ObjectId → businesses | ✓ | Owning salon business; every query filters on it |
| `createdAt`, `updatedAt` | Date | ✓ | Set automatically |
| `createdBy`, `updatedBy` | ObjectId → users / platformAdmins |  | Who made the change |
| `deletedAt` | Date |  | Soft delete; never used on bills, ledgers, movements |
| `__v` | Number | ✓ | Version for optimistic concurrency (edit conflicts return 409) |

**Design rules**

- **Embed** what is always read and written together and stays small: bill lines, payments, tips; branch hours and holidays; business settings.
- **Reference** what grows without limit or is queried on its own: ledgers, movements, attendance, messages, audit.
- **Snapshot** names and prices into bills, appointments and payroll lines, so history never changes when the source record changes.
- **Ledgers are append-only** (`walletLedger`, `loyaltyLedger`, `stockMovements`, `auditLogs`). Balances on `customers` and `stockBalances` are caches rebuilt nightly from the ledgers.
- **Nothing financial is hard-deleted.** Masters are deactivated (`active: false` or `status`) once they have history.
- **Transactions** wrap every write that touches more than one collection (bill save, cancel, approval, transfer, day closure, payroll lock).

**Concurrency rules** (added after the dry-run test, see Database Design — Dry-Run Test Report v1.0)

- **Balances are debited with a conditional update** inside the transaction, never by reading then writing: `customers.updateOne({_id, walletBalancePaise: {$gte: amt}}, {$inc: {walletBalancePaise: -amt}})`; zero documents matched means insufficient balance. The same pattern applies to loyalty points and package sessions (`used < total` in the filter).
- **Bookings take a slot lock:** the booking transaction increments `counters` key `<businessId>:<staffId>:slotlock:<businessDate>` for every staff member on it, so two bookings for the same staff and day conflict and the second retries and re-checks clashes.
- **Summaries use `$inc`** inside the bill transaction; the nightly job rebuilds them from source.
- **Locked periods are frozen:** bills and attendance in a branch-month with a locked payroll run cannot be edited or cancelled; bills on an approved day are owner-only.

## 2. Relationship overview

The business is the root of everything, and the bill is the hub: it reads the catalogue, people and prepaid plans, and its save writes to stock, payroll, day-end, WhatsApp and the system collections.

&#91;embedded content: collection groups and how they connect · 53 collections in 10 groups\]

Arrows point from the collection that supplies data to the one that uses it. Saving a bill posts stock movements (left), commission and tips for payroll (right), collections for day-end, and an audit entry and daily summary (System). Every link is listed with its cardinality and delete rule in section 13.

## 3. Platform and access

These six collections define who exists and what they can reach: Glox admins, each salon business, its branches and its logins.

### platformAdmins — Glox Super Admin accounts (no businessId)

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `name` | String | ✓ |  | Admin's name |
| `email` | String | ✓ | unique; also reserved in emailRegistry | Login ID |
| `passwordHash` | String | ✓ | bcrypt | Never returned by the API |
| `status` | String | ✓ | active, inactive | Inactive cannot log in |
| `sessionVersion` | Number | ✓ | default 0 | Incremented to sign out everywhere |
| `failedLogins`, `lockedUntil` | Number, Date |  |  | Lockout after 5 failures |
| `lastLoginAt` | Date |  |  |  |

### businesses — one salon brand (tenant root; its `_id` is the businessId)

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `name` | String | ✓ |  | Business name on invoices |
| `logoUrl` | String |  | S3 key |  |
| `address` | Object | ✓ | line1, line2, city, state, pincode | Registered address |
| `gst.enabled` | Boolean | ✓ | default false | Tax invoice vs plain bill |
| `gst.gstin`, `gst.pan` | String | if enabled | 15 / 10 chars | Common GSTIN for all branches |
| `gst.rateBps` | Number | ✓ | default 1800 | Service GST rate |
| `gst.sac` | String | ✓ | default 9983 | Service SAC code |
| `gst.pricesInclusive` | Boolean | ✓ | default false | Prices include GST or not |
| `fyStartMonth` | Number | ✓ | default 4 | Financial year starts April |
| `discountLimits.managerBps`, `.branchBps`, `.ownerAlertBps` | Number | ✓ |  | Approval and alert thresholds |
| `dayEndReportTime` | String | ✓ | default '23:00' | WhatsApp report time |
| `loyalty` | Object | ✓ | enabled, earnPer100, redeemValuePaise, minRedeem, expiryDays | Loyalty settings |
| `payroll.pf`, `.esi`, `.pt` | Object | ✓ | enabled + rates / slabs | Statutory deductions, all optional |
| `automationGuards` | Object | ✓ | quietStart, quietEnd, maxMarketingPerDay | WhatsApp guards |
| `ownerWhatsappPhone` | String | ✓ | +91… | Where day-end and alerts go |
| `defaultWaNumberId` | ObjectId |  | → waNumbers | Business WhatsApp number. Also headBranchId (→ branches, required): the head branch, used to route WhatsApp chats from customers with no known branch |
| `status` | String | ✓ | active, suspended | Suspended = no logins |
| `createdAt`, `updatedAt` | Date | ✓ |  |  |

### branches — one outlet of a business

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `name` | String | ✓ |  | e.g. Vesu |
| `code` | String | ✓ | unique per business | e.g. SRT1 |
| `invoicePrefix` | String | ✓ |  | Start of invoice numbers; unique per business |
| `address`, `phone` | Object, String | ✓ |  | Printed on invoices |
| `hours[]` | Array | ✓ | day 0–6, open, close, closed | Weekly opening hours (embedded) |
| `holidays[]` | Array |  | date, name | Closed dates (embedded) |
| `stations` | Number |  |  | Chairs or stations |
| `waNumberId` | ObjectId |  | → waNumbers | Own WhatsApp number, overrides business |
| `googleReviewUrl` | String |  |  | For review push |
| `pettyCashFloatPaise` | Number | ✓ | default 0 | Opening cash float |
| `status` | String | ✓ | active, deactivation\_requested, deactivated | Deactivated = read-only |

### branchRequests — owner requests to add or delete a branch

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `type` | String | ✓ | add, delete |  |
| `branchId` | ObjectId | for delete | → branches | Branch to delete |
| `payload` | Object | for add | name, address | Proposed branch |
| `reason` | String | ✓ |  | Owner's reason |
| `status` | String | ✓ | pending, approved, rejected |  |
| `handledBy`, `handledAt`, `rejectReason` | ObjectId, Date, String |  | → platformAdmins | Super Admin decision |

### users — salon logins (owner, manager, branch)

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `role` | String | ✓ | owner, manager, branch | Fixed roles |
| `name` | String | ✓ |  | For branch logins: branch name |
| `email` | String | ✓ | unique; also reserved in emailRegistry | Login ID, set by Super Admin or owner |
| `phone` | String |  |  |  |
| `passwordHash` | String | ✓ | bcrypt |  |
| `branchIds` | ObjectId\[\] | ✓ | → branches | Owner: \[\] means all; branch login: exactly one. Branch logins also store branchLoginFor (branchId, unique sparse). One owner per business (partial unique index on businessId where role = owner) |
| `flags.manageStaff`, `.approvePO`, `.viewPayroll`, `.editBranchPrices` | Boolean |  | managers | Set by owner |
| `flags.maxDiscountBps` | Number |  | managers | Overrides business default |
| `flags.markAttendance` | Boolean |  | branch logins | Set by owner or manager |
| `staffId` | ObjectId |  | → staff | Manager's payroll record |
| `status` | String | ✓ | active, inactive |  |
| `sessionVersion`, `failedLogins`, `lockedUntil`, `lastLoginAt` |  |  |  | Session control |

### counters — atomic number sequences (no businessId field; key contains it)

| Field | Type | Req | Meaning |
| --- | --- | --- | --- |
| `_id` | String | ✓ | `<businessId>:<branchId>:<kind>:<fy>`, kind = invoice, po, transfer, receipt; slot locks use \`\<businessId>:\<staffId>:slotlock:\<businessDate>\` |
| `seq` | Number | ✓ | Last number issued; `$inc` inside the transaction |

### emailRegistry — reserves every login email across both login collections (no businessId)

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `_id` | String | ✓ | lower-cased email | Unique by definition |
| `kind` | String | ✓ | platform, tenant | Which collection owns it |
| `accountId` | ObjectId | ✓ | → platformAdmins / users | The login |

Inserted in the same transaction as the login it reserves; a duplicate email fails on `_id`.

## 4. Catalogue

The catalogue is defined once per business; branches only override price and availability inside the service document.

### categories

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `name` | String | ✓ |  | e.g. Hair, Colour |
| `parentId` | ObjectId |  | → categories | Set for second-level categories |
| `gender` | String | ✓ | men, women, unisex |  |
| `order` | Number | ✓ |  | Display order |
| `active` | Boolean | ✓ | default true |  |

### services

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `categoryId` | ObjectId | ✓ | → categories |  |
| `name` | String | ✓ |  |  |
| `gender` | String | ✓ | men, women, unisex |  |
| `basePricePaise` | Number | ✓ |  | Default price in every branch |
| `durationMin` | Number | ✓ | 5–480 | Calendar slot length |
| `branchPrices[]` | Array |  | sub-table | Per-branch override |
| `consumables[]` | Array |  | sub-table | Auto-deducted products |
| `rebookDays` | Number |  | 1–365 | Triggers rebooking nudge |
| `commission` | Object |  | type: pct / fixed / slab, value, slabs | Overrides staff default |
| `active` | Boolean | ✓ |  |  |

`services.branchPrices[]` (embedded)

| Field | Type | Req | Ref | Meaning |
| --- | --- | --- | --- | --- |
| `branchId` | ObjectId | ✓ | → branches |  |
| `pricePaise` | Number |  |  | Blank = base price |
| `active` | Boolean | ✓ |  | Offered in this branch |

`services.consumables[]` (embedded)

| Field | Type | Req | Ref | Meaning |
| --- | --- | --- | --- | --- |
| `productId` | ObjectId | ✓ | → products (consumable or both) |  |
| `qty` | Number | ✓ |  | Quantity in the product's use unit per service |

### products

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `name`, `brand`, `category` | String | name ✓ |  |  |
| `type` | String | ✓ | retail, consumable, both | Which stock pool(s) it lives in |
| `sku` | String |  |  | Barcode or SKU |
| `purchaseUnit`, `useUnit` | String | ✓ | e.g. bottle, ml |  |
| `unitsPerPurchase` | Number | ✓ | e.g. 1000 | Use units in one purchase unit |
| `mrpPaise`, `sellingPricePaise` | Number | retail |  | Sale price per piece |
| `purchasePricePaise` | Number | ✓ |  | Cost per purchase unit |
| `hsn`, `gstBps` | String, Number |  |  | Product tax |
| `reorderLevels[]` | Array |  | branchId, qty | Low-stock threshold per branch (embedded) |
| `active` | Boolean | ✓ |  |  |

### vendors

| Field | Type | Req | Meaning |
| --- | --- | --- | --- |
| `name` | String | ✓ | Supplier |
| `contact`, `phone`, `gstin`, `address`, `terms` |  |  | Contact and payment terms |

## 5. People

Staff are employees (no login); customers are the salon's clients and belong to the business, not to one branch.

### staff

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `branchId` | ObjectId | ✓ | → branches | Home branch |
| `name`, `phone` | String | ✓ |  |  |
| `designation` | String | ✓ | stylist, senior\_stylist, beautician, receptionist, manager, helper, other | Receptionists feed "Billed by" |
| `joiningDate`, `exitDate`, `exitReason` | String | joining ✓ |  |  |
| `serviceIds` | ObjectId\[\] |  | → services | Services this person performs; the only source of service eligibility (empty = performs all services) |
| `salary.type`, `salary.amountPaise` | String, Number | ✓ | monthly, none |  |
| `commission.service` | Object |  | pct / fixed / slab | Default service commission |
| `commission.productBps` | Number |  |  | Product sales commission |
| `commission.overtimePerHourPaise` | Number |  |  | Overtime rate |
| `statutory.pf`, `.esi`, `.pt` | Boolean | ✓ | default false | Applies only if on for the business |
| `bankRef` | Object |  | bank, last4 | Payout reference only |
| `documents[]` | Array |  | kind, s3Key | ID uploads |
| `emergencyContact` | Object |  | name, phone |  |
| `status` | String | ✓ | active, exited |  |

### customers

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `name` | String | ✓ |  |  |
| `phone` | String | ✓ | +91XXXXXXXXXX, unique per business | Identity of the customer. Merged or deleted records get merged:\<id> or deleted:\<id> so the unique index stays free |
| `altPhone`s\[\], `email` | String |  |  |  |
| `gender`, `dob`, `anniversary` | String |  |  | Birthday and anniversary automations |
| `address` | Object |  |  |  |
| `source` | String | ✓ | walk\_in, phone, whatsapp, referral |  |
| `referredBy` | ObjectId |  | → customers |  |
| `tags` | String\[\] |  |  | VIP, Bride… |
| `waOptIn`, `doNotMessage` | Boolean | ✓ |  | WhatsApp consent |
| `notes` | String |  |  |  |
| `serviceNotes[]` | Array |  | date, staffId, text, colourFormula | Per-visit notes (embedded, capped at 200) |
| `stats.firstVisit`, `.lastVisit` | String |  | business dates | Cached from bills |
| `stats.visits`, `.spendPaise`, `.noShows` | Number | ✓ |  | Cached counters |
| `stats.favServiceId`, `.favStaffId` | ObjectId |  | → services, staff |  |
| `walletBalancePaise` | Number | ✓ |  | Cache of walletLedger |
| `loyaltyPoints` | Number | ✓ |  | Cache of loyaltyLedger |
| `duePaise` | Number | ✓ |  | Cache of open dues |
| `mergedInto` | ObjectId |  | → customers | Set when merged away |

## 6. Front desk and billing

The bill is the centre of the database: it links a customer, a branch, staff and an optional appointment, and its save drives stock, wallet, plans, commission and reports.

### appointments

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `branchId` | ObjectId | ✓ | → branches |  |
| `customerId` | ObjectId | ✓ | → customers |  |
| `businessDate` | String | ✓ |  | Day of the appointment (IST) |
| `lines[]` | Array | ✓ | sub-table | One per service |
| `start`, `end` | Date | ✓ |  | Earliest start and latest end of lines |
| `status` | String | ✓ | booked, confirmed, arrived, in\_service, completed, billed, cancelled, no\_show |  |
| `statusLog[]` | Array | ✓ | status, at, by, reason | History of changes |
| `source` | String | ✓ | walk\_in, phone, whatsapp |  |
| `notes` | String |  |  |  |
| `billId` | ObjectId |  | → bills | Set when billed |

`appointments.lines[]`

| Field | Type | Req | Ref | Meaning |
| --- | --- | --- | --- | --- |
| `_id` | ObjectId | ✓ |  | Line id |
| `serviceId` | ObjectId | ✓ | → services |  |
| `serviceName` | String | ✓ | snapshot |  |
| `staffId` | ObjectId | ✓ | → staff |  |
| `start`, `end` | Date | ✓ |  |  |

### staffBlocks — blocked time on the calendar

| Field | Type | Req | Ref | Meaning |
| --- | --- | --- | --- | --- |
| `branchId`, `staffId` | ObjectId | ✓ | → branches, staff |  |
| `start`, `end` | Date | ✓ |  |  |
| `reason` | String | ✓ |  | Lunch, training… |

### bills

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `branchId` | ObjectId | ✓ | → branches |  |
| `invoiceNo` | String | ✓ | unique per business | e.g. SRT1/2026-27/000123 |
| `fy` | String | ✓ | '2026-27' | Financial year |
| `businessDate` | String | ✓ |  | Billing day (IST) |
| `customerId` | ObjectId | ✓ | → customers |  |
| `customerSnap` | Object | ✓ | name, phone, gstin | Snapshot for the invoice |
| `billedByStaffId` | ObjectId | branch login | → staff (receptionist) | "Billed by" |
| `billedByName` | String | ✓ | snapshot |  |
| `appointmentId` | ObjectId |  | → appointments |  |
| `gstApplied`, `pricesInclusive` | Boolean | ✓ |  | Copied from settings at save |
| `lines[]` | Array | ✓ | sub-table | Items sold |
| `billDiscount` | Object |  | type: amount / pct, value | Whole-bill discount |
| `redemptions[]` | Array |  | sub-table | Packages, membership, loyalty, voucher used |
| `totals` | Object | ✓ | grossPaise, discountPaise, taxablePaise, cgstPaise, sgstPaise, roundOffPaise, totalPaise, paidPaise, duePaise | Computed by the server |
| `payments[]` | Array |  | sub-table | How it was paid |
| `tips[]` | Array |  | sub-table | Tips per staff |
| `status` | String | ✓ | awaiting\_approval, rejected, paid, partly\_paid, cancelled, refunded, partly\_refunded |  |
| `approval` | Object |  | reasons\[\], requestedAt, decidedBy, decidedAt, rejectReason | Why and who approved |
| `version` | Number | ✓ | default 1 | Increments on each edit |
| `cancel` | Object |  | by, at, reason |  |
| `refunds[]` | Array |  | amountPaise, mode, reason, by, at, businessDate |  |
| `idempotencyKey` | String | ✓ | unique per business | Stops double saves |

`bills.lines[]`

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `_id` | ObjectId | ✓ |  | Line id |
| `kind` | String | ✓ | service, product, membership, package, wallet\_topup, voucher |  |
| `refId` | ObjectId | ✓ | → services / products / plans | Item sold |
| `name`, `hsnSac` | String | ✓ | snapshot |  |
| `qty` | Number | ✓ |  |  |
| `unitPricePaise` | Number | ✓ | snapshot (branch price) |  |
| `lineDiscount` | Object |  | type, value |  |
| `discountPaise`, `taxablePaise`, `gstBps`, `cgstPaise`, `sgstPaise`, `totalPaise` | Number | ✓ |  | Line maths |
| `staff[]` | Array | services ✓ | staffId → staff, name, splitBps, commissionPaise | Who did it and their commission |
| `consumablesUsed[]` | Array |  | productId → products, qty, costPaise | Stock deducted for this line |

`bills.payments[]`: `mode` (cash, upi, card, wallet) ✓, `amountPaise` ✓, `businessDate ✓ (day the money was received), tenderedPaise (cash handed over), ref, at ✓. Payments must equal totals.totalPaise + all tips − totals.duePaise`.

`bills.tips[]`: `staffId` → staff ✓, `staffName` ✓, `amountPaise` ✓, `payout` (cash\_today = staff take the tip from the till that day; payroll = added to the payroll run) ✓. The customer pays tips inside payments\[\].

`bills.redemptions[]`: `kind` (package, membership, loyalty, voucher) ✓, `refId` → customerPlans ✓ (loyalty: customer), `lineId`, `points`, `amountPaise` ✓.

### billVersions — snapshot of each previous version of an edited bill

| Field | Type | Req | Ref | Meaning |
| --- | --- | --- | --- | --- |
| `billId` | ObjectId | ✓ | → bills |  |
| `version` | Number | ✓ |  | Version that was replaced |
| `snapshot` | Object | ✓ |  | Full bill as it was |
| `editedBy`, `reason` | ObjectId, String | ✓ | → users |  |

### dues — unpaid balance of a partly paid bill

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `branchId`, `customerId`, `billId` | ObjectId | ✓ | → branches, customers, bills |  |
| `amountPaise`, `settledPaise` | Number | ✓ |  |  |
| `status` | String | ✓ | open, settled, void | Void when the bill is cancelled |
| `settlements[]` | Array |  | billId or receiptId (→ dueReceipts), amountPaise, at | Collections against it |

### dueReceipts — payment of old dues outside a new bill

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `branchId`, `customerId` | ObjectId | ✓ | → branches, customers |  |
| `receiptNo` | String | ✓ | from counters, unique per business | Printable receipt number |
| `businessDate` | String | ✓ |  | Day the money was received |
| `payments[]` | Array | ✓ | mode, amountPaise, tenderedPaise |  |
| `allocations[]` | Array | ✓ | dueId → dues, amountPaise | Oldest dues first |
| `status` | String | ✓ | active, cancelled |  |

### feedback — customer rating after a visit

| Field | Type | Req | Ref | Meaning |
| --- | --- | --- | --- | --- |
| `branchId`, `billId`, `customerId` | ObjectId | ✓ | → branches, bills, customers |  |
| `staffIds` | ObjectId\[\] |  | → staff | Staff on the bill |
| `rating` | Number | ✓ | 1–5 |  |
| `comment` | String |  |  |  |
| `reviewLinkSent` | Boolean | ✓ |  | Google review push sent |

## 7. Prepaid: plans, wallet, loyalty

A `plan` is the product the owner defines; a `customerPlan` is one customer's purchased copy of it; wallet and loyalty balances live only in their ledgers.

### plans — membership, package, wallet offer or voucher definitions

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `type` | String | ✓ | membership, package, wallet\_offer, voucher |  |
| `name` | String | ✓ |  |  |
| `pricePaise` | Number | ✓ |  | Selling price |
| `validityDays` | Number | ✓ |  | From date of sale |
| `membership.serviceDiscountBps`, `.productDiscountBps` | Number | membership |  | Discount while active |
| `package.items[]` | Array | package | serviceId → services, sessions | Services included |
| `walletOffer.creditPaise` | Number | wallet\_offer |  | Credit given (e.g. pay 10,000, get 12,000) |
| `voucher.valuePaise` | Number | voucher |  | Gift voucher value |
| `branchScope` | ObjectId\[\] |  | → branches | Empty = all branches |
| `active` | Boolean | ✓ |  | Sold plans cannot be edited, only deactivated |

### customerPlans — a plan sold to a customer

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `customerId` | ObjectId | ✓ | → customers | Owner of the plan |
| `planId` | ObjectId | ✓ | → plans |  |
| `planSnap` | Object | ✓ |  | Plan as sold |
| `soldBillId`, `soldBranchId` | ObjectId | ✓ | → bills, branches | Where it was sold |
| `validFrom`, `validTill` | String | ✓ |  |  |
| `sessions[]` | Array | package | serviceId, total, used, perSessionValuePaise | Remaining sessions |
| `voucherCode` | String | voucher | unique per business |  |
| `status` | String | ✓ | active, frozen, expired, used\_up, transferred, cancelled |  |
| `log[]` | Array | ✓ | action, at, by, detail | extend, freeze, unfreeze, transfer, redeem, reverse. Field frozenAt (Date) is set while frozen; unfreeze extends validTill by the frozen days |

### walletLedger — append-only wallet history

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `customerId` | ObjectId | ✓ | → customers |  |
| `branchId` | ObjectId |  | → branches | Where it happened |
| `type` | String | ✓ | topup, bonus, redeem, refund, reverse, expiry, adjust, imported |  |
| `amountPaise` | Number | ✓ | signed | + credit, − debit |
| `billId` | ObjectId |  | → bills |  |
| `reason` | String | adjust |  |  |
| `balanceAfterPaise` | Number | ✓ |  | Running balance |

### loyaltyLedger — append-only points history

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `customerId` | ObjectId | ✓ | → customers |  |
| `type` | String | ✓ | earn, redeem, reverse, expiry, adjust, imported |  |
| `points` | Number | ✓ | signed |  |
| `billId` | ObjectId |  | → bills |  |
| `balanceAfter` | Number | ✓ |  |  |

## 8. Stock

Stock is never stored as an editable number: every change is a `stockMovements` row, and `stockBalances` holds the running total per branch, product and pool.

### stockMovements — append-only stock ledger

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `branchId`, `productId` | ObjectId | ✓ | → branches, products |  |
| `pool` | String | ✓ | retail, consumable |  |
| `type` | String | ✓ | purchase, sale, service\_use, transfer\_out, transfer\_in, adjust, internal\_use, cancel\_reverse, audit, imported |  |
| `qty` | Number | ✓ | signed, use units | + in, − out |
| `costPaise` | Number | ✓ |  | Total cost of this movement in paise, rounded once (a per-ml cost can be a fraction of a paisa) |
| `refType`, `refId` | String, ObjectId |  | bill, purchaseOrder, transfer, stockAudit | Source document |
| `reason` | String | adjust |  |  |
| `batch`, `expiry` | String |  |  | From PO receipt |
| `businessDate` | String | ✓ |  |  |

### stockBalances — current quantity (cache)

| Field | Type | Req | Ref | Meaning |
| --- | --- | --- | --- | --- |
| `branchId`, `productId` | ObjectId | ✓ | → branches, products |  |
| `pool` | String | ✓ | retail, consumable |  |
| `qty` | Number | ✓ |  | Sum of movements; can be negative |
| `lastMovementAt` | Date | ✓ |  |  |

### purchaseOrders

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `branchId`, `vendorId` | ObjectId | ✓ | → branches, vendors |  |
| `poNo` | String | ✓ | from counters |  |
| `items[]` | Array | ✓ | productId → products, qtyPurchaseUnits, ratePaise, receivedPurchaseUnits | Ordered lines |
| `totalPaise` | Number | ✓ |  |  |
| `status` | String | ✓ | draft, pending\_approval, approved, partly\_received, received, rejected, cancelled |  |
| `approvals[]` | Array |  | action, by, at, reason |  |
| `receipts[]` | Array |  | at, by, items (productId, qty, batch, expiry) | Goods received |
| `vendorBill` | Object |  | number, amountPaise, paymentStatus, paidPaise | Supplier invoice |

### transfers — stock moved between branches

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `transferNo` | String | ✓ | from counters |  |
| `fromBranchId`, `toBranchId` | ObjectId | ✓ | → branches |  |
| `items[]` | Array | ✓ | productId, pool, qty, receivedQty, mismatchReason |  |
| `status` | String | ✓ | requested, approved, dispatched, received, rejected, cancelled |  |
| `log[]` | Array | ✓ | action, by, at, reason |  |

### stockAudits — physical stock count

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `branchId` | ObjectId | ✓ | → branches |  |
| `pool` | String | ✓ | retail, consumable |  |
| `status` | String | ✓ | counting, submitted, approved |  |
| `lines[]` | Array | ✓ | productId, systemQty, countedQty | Approval posts `audit` movements for the difference |

## 9. Staff operations and payroll

Roster says when a person should work, attendance says when they did, and the payroll run turns both plus bills into pay.

### rosters — one per staff member

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `branchId`, `staffId` | ObjectId | ✓ | → branches, staff (unique per staff) |  |
| `weekly[]` | Array | ✓ | day 0–6, start, end, off | Standard week |
| `overrides[]` | Array |  | date, start, end, off | One-off changes |

### attendance — one per staff per day

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `branchId`, `staffId` | ObjectId | ✓ | → branches, staff |  |
| `businessDate` | String | ✓ | unique with staffId |  |
| `status` | String | ✓ | present, late, half\_day, absent, leave, week\_off, holiday |  |
| `inAt`, `outAt` | Date |  |  | Clock times |
| `overtimeMin` | Number | ✓ | default 0 | Beyond rostered end |
| `note` | String |  |  |  |
| `markedBy` | ObjectId | ✓ | → users | Owner, manager or permitted branch login |
| `edits[]` | Array |  | by, at, reason, before | Changes to past entries |

### leaves

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `branchId`, `staffId` | ObjectId | ✓ | → branches, staff |  |
| `from`, `to` | String | ✓ |  | Dates inclusive |
| `type` | String | ✓ | paid, unpaid | Paid counts as paid day |
| `status` | String | ✓ | approved, rejected |  |
| `reason` | String |  |  |  |

### advances

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `branchId`, `staffId` | ObjectId | ✓ | → branches, staff |  |
| `amountPaise`, `date` | Number, String | ✓ |  |  |
| `recoveryPerMonthPaise` | Number | ✓ |  | Deducted each run. Also expenseId (→ expenses): the till expense created when the advance is paid in cash |
| `recoveredPaise` | Number | ✓ |  |  |
| `status` | String | ✓ | open, closed |  |

### payrollRuns — one per branch per month

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `branchId` | ObjectId | ✓ | → branches |  |
| `month` | String | ✓ | 'YYYY-MM', unique with branchId |  |
| `status` | String | ✓ | draft, reviewed, locked, paid |  |
| `lines[]` | Array | ✓ | sub-table | One per staff |
| `totals.netPaise` | Number | ✓ |  |  |
| `lockedBy`, `lockedAt` | ObjectId, Date |  | → users |  |

`payrollRuns.lines[]`

| Field | Type | Meaning |
| --- | --- | --- |
| `staffId` → staff, `staffName` | ObjectId, String | Staff and name snapshot |
| `paidDays` | Number | From attendance |
| `salaryPaise`, `commissionPaise`, `overtimePaise`, `tipsPaise`, `incentivesPaise` | Number | Earnings |
| `advancePaise`, `pfPaise`, `esiPaise`, `ptPaise`, `otherDeductionPaise` | Number | Deductions |
| `netPaise` | Number | Pay |
| `adjustments[]` | Array | field, deltaPaise, reason, by, at |
| `paid` | Object | mode, date |

### payslips

| Field | Type | Req | Ref | Meaning |
| --- | --- | --- | --- | --- |
| `runId`, `staffId` | ObjectId | ✓ | → payrollRuns, staff |  |
| `month` | String | ✓ |  |  |
| `pdfKey` | String | ✓ | S3 key |  |
| `sentAt` | Date |  |  | Sent on WhatsApp |

## 10. Expenses and day-end

These collections feed the daily cash reconciliation: expected cash comes from bills, dues, refunds, cash tips and the entries below.

### expenses

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `branchId` | ObjectId | ✓ | → branches |  |
| `businessDate` | String | ✓ |  |  |
| `category` | String | ✓ | rent, electricity, salary\_advance, tea\_snacks, repairs, marketing, other |  |
| `amountPaise` | Number | ✓ |  |  |
| `mode` | String | ✓ | cash, upi, card, bank |  |
| `paidFrom` | String | ✓ | till, petty\_cash, bank |  |
| `note`, `receiptKey` | String |  | S3 key |  |
| `recurringId` | ObjectId |  | → recurringExpenses |  |

### recurringExpenses

| Field | Type | Req | Ref | Meaning |
| --- | --- | --- | --- | --- |
| `branchId` | ObjectId | ✓ | → branches |  |
| `category`, `amountPaise`, `dayOfMonth` |  | ✓ |  | Creates an expense each month |
| `active` | Boolean | ✓ |  |  |

### pettyCashEntries

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `branchId` | ObjectId | ✓ | → branches |  |
| `businessDate` | String | ✓ |  |  |
| `type` | String | ✓ | float, topup, expense, deposit |  |
| `amountPaise` | Number | ✓ |  |  |
| `refId` | ObjectId |  | → expenses |  |

### dayClosures — one per branch per day

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `branchId` | ObjectId | ✓ | → branches |  |
| `businessDate` | String | ✓ | unique with branchId |  |
| `expected` | Object | ✓ | cashPaise, upiPaise, cardPaise | System figures |
| `counted` | Object |  | cashPaise, denominations, upiPaise, cardPaise | Entered by branch |
| `diff`, `diffReason` | Object, String |  |  | Required reason if not zero |
| `status` | String | ✓ | open, submitted, approved | Approved = day locked |
| `submittedBy`, `approvedBy`, `approvedAt` |  |  | → users |  |
| `reopenLog[]` | Array |  | by, at, reason | Owner reopenings |
| `report` | Object |  | sentAt, pdfKey, closedAtSend | 23:00 WhatsApp report |

## 11. WhatsApp and growth

Each business (or branch) has a WhatsApp number; conversations are per phone number on that WhatsApp number, and every message, campaign and automation send is stored.

### leads

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `branchId` | ObjectId | ✓ | → branches |  |
| `name` | String |  |  |  |
| `phone` | String | ✓ |  |  |
| `source` | String | ✓ | whatsapp, walk\_in, phone |  |
| `serviceIds` | ObjectId\[\] |  | → services | Interested in |
| `budgetPaise` | Number |  |  |  |
| `stage` | String | ✓ | new, contacted, interested, booked, lost |  |
| `lostReason` | String | lost |  |  |
| `assignedTo` | ObjectId |  | → users |  |
| `followUpDate`, `notes` | String |  |  |  |
| `conversationId` | ObjectId |  | → waConversations | WhatsApp origin |
| `customerId` | ObjectId |  | → customers | Set on conversion |

### waNumbers — WhatsApp numbers configured by Super Admin

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `phone` | String | ✓ |  | WhatsApp Business number |
| `aisensy.apiKeyEnc`, `.projectId`, `.webhookSecretEnc` | String | ✓ | encrypted | AiSensy credentials |
| `branchIds` | ObjectId\[\] |  | → branches | Branches using this number; empty = business default |
| `status` | String | ✓ | active, error |  |
| `lastCheckAt`, `lowBalance` | Date, Boolean |  |  | Health |

### waTemplates — synced from AiSensy

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `numberId` | ObjectId | ✓ | → waNumbers |  |
| `name`, `language` | String | ✓ |  |  |
| `category` | String | ✓ | marketing, utility, authentication | Affects cost |
| `body`, `variables` | String, String\[\] | ✓ |  |  |
| `status` | String | ✓ | approved, pending, rejected | Only approved are usable |
| `syncedAt` | Date | ✓ |  |  |

### waConversations — one per phone per WhatsApp number

| Field | Type | Req | Ref | Meaning |
| --- | --- | --- | --- | --- |
| `numberId` | ObjectId | ✓ | → waNumbers |  |
| `branchId` | ObjectId | ✓ | → branches | Inbox it appears in |
| `phone` | String | ✓ | unique with numberId | Customer's number |
| `customerId`, `leadId` | ObjectId |  | → customers, leads | Matched record |
| `lastMessageAt`, `lastInboundAt` | Date |  |  | 24-hour window from lastInboundAt |
| `unread` | Number | ✓ |  |  |
| `assignedTo` | ObjectId |  | → users |  |

### waMessages

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `conversationId` | ObjectId | ✓ | → waConversations |  |
| `direction` | String | ✓ | in, out |  |
| `providerMessageId` | String |  | unique | AiSensy id, for dedupe |
| `kind` | String | ✓ | text, template, media |  |
| `text`, `templateId`, `variables`, `mediaKey` |  |  | → waTemplates | Content |
| `status` | String | ✓ | queued, sent, delivered, read, failed |  |
| `error`, `costPaise` | String, Number |  |  |  |
| `origin` | String | ✓ | inbox, campaign, automation, transactional |  |
| `originId` | ObjectId |  | → campaigns / automations / bills |  |
| `sentBy` | ObjectId |  | → users |  |

### campaigns

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `name` | String | ✓ |  |  |
| `numberId`, `templateId` | ObjectId | ✓ | → waNumbers, waTemplates |  |
| `audience` | Object | ✓ | kind (segment, upload, selection), segment, customerIds, uploadKey | Who receives it |
| `variableMap` | Object | ✓ |  | Template variable → field or text |
| `scheduledAt` | Date |  |  |  |
| `status` | String | ✓ | draft, scheduled, sending, paused, completed, cancelled |  |
| `stats` | Object | ✓ | total, excluded, sent, delivered, read, failed, costPaise |  |

### automations — one per automation type per business

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `key` | String | ✓ | booking\_confirmation, reminder\_24h, reminder\_2h, rebooking, birthday, anniversary, winback, feedback, review\_push, membership\_expiry, package\_last\_session | unique per business |
| `enabled` | Boolean | ✓ |  |  |
| `templateId` | ObjectId |  | → waTemplates |  |
| `settings` | Object |  |  | Timing, offer text |

### automationSends — prevents sending the same automation twice

| Field | Type | Req | Meaning |
| --- | --- | --- | --- |
| `_id` | String | ✓ | `<key>:<refId>:<period>`, e.g. `birthday:<customerId>:2026` |
| `businessId`, `messageId` | ObjectId | ✓ | → businesses, waMessages |
| `at` | Date | ✓ |  |

### webhookEvents — raw AiSensy callbacks (kept 7 days)

| Field | Type | Req | Meaning |
| --- | --- | --- | --- |
| `numberId` | ObjectId | ✓ | → waNumbers |
| `payload` | Object | ✓ | Raw body |
| `processedAt` | Date |  |  |
| `receivedAt` | Date | ✓ | TTL 7 days |

## 12. System

These collections support auditing, notifications, fast reports and polling; none of them is edited by users.

### auditLogs — append-only

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `businessId`, `branchId` | ObjectId |  | → businesses, branches | Empty for platform-only actions |
| `actor` | Object | ✓ | kind (platform, tenant, system), id, role, name | Who acted |
| `billedByName` | String |  |  | Receptionist on branch login actions |
| `action` | String | ✓ | e.g. bill.cancel, service.price\_change, user.password\_set |  |
| `entity`, `entityId` | String, ObjectId | ✓ |  | What changed |
| `before`, `after` | Object |  |  | Changed fields |
| `reason` | String |  |  |  |
| `ip`, `userAgent` | String |  |  |  |
| `at` | Date | ✓ |  |  |

### notifications — in-app bell (kept 90 days)

| Field | Type | Req | Ref | Meaning |
| --- | --- | --- | --- | --- |
| `businessId`, `userId` | ObjectId | ✓ | → businesses, users | Recipient |
| `type`, `title`, `body` | String | ✓ |  |  |
| `link` | String |  |  | App path |
| `readAt` | Date |  |  |  |
| `createdAt` | Date | ✓ |  | TTL 90 days |

### dailySummaries — pre-computed report data, one per branch per day

| Field | Type | Req | Meaning |
| --- | --- | --- | --- |
| `_id` | String | ✓ | `<branchId>:<businessDate>` |
| `businessId`, `branchId`, `businessDate` |  | ✓ |  |
| `sales` | Object | ✓ | grossPaise, discountPaise, netPaise, taxPaise, servicesPaise, productsPaise, plansPaise |
| `collections` | Object | ✓ | cash, upi, card, wallet (paise) |
| `refundsPaise`, `tipsPaise` | Number | ✓ |  |
| `counts` | Object | ✓ | bills, cancelled, customers, newCustomers, appointments, noShows |
| `byService`, `byStaff`, `byBilledBy` | Object | ✓ | Breakdowns keyed by id or name |
| `updatedAt` | Date | ✓ |  |

### changeCursors — backup of polling counters (live values in Redis)

| Field | Type | Req | Meaning |
| --- | --- | --- | --- |
| `_id` | String | ✓ | Scope, e.g. `appointments:<branchId>:<date>` |
| `businessId` | ObjectId | ✓ |  |
| `rev`, `updatedAt` | Number, Date | ✓ | Last counter value |

### importJobs — data migration runs

| Field | Type | Req | Ref / values | Meaning |
| --- | --- | --- | --- | --- |
| `businessId` | ObjectId | ✓ | → businesses |  |
| `type` | String | ✓ | customers, services, products, staff, plans, wallet |  |
| `fileKey` | String | ✓ | S3 key |  |
| `status` | String | ✓ | validating, ready, importing, done, failed |  |
| `errors[]` | Array |  | row, message |  |
| `summary` | Object |  |  | Counts imported |
| `createdBy`, `confirmedBy` | ObjectId |  | → platformAdmins |  |

## 13. Relationship register

Every link between collections, read as "one *Parent* has many *Child*". MongoDB does not enforce these: the API checks each reference on write and the delete rule in the last column.

**Delete rules used below:** *Deactivate* = parent can only be deactivated, children kept; *Block* = parent cannot be deleted while children exist; *Kept* = child is history and never changes; *Cascade-soft* = children soft-deleted with parent.

| Parent | Child (field) | Cardinality | Stored as | If parent is deleted or deactivated |
| --- | --- | --- | --- | --- |
| businesses | every tenant collection (`businessId`) | 1 : many | reference | Suspend only; never deleted |
| businesses | branches (`businessId`) | 1 : many (≥ 1) | reference | Suspend only |
| businesses | users, role owner | 1 : 1 | reference | Suspend only |
| branches | users, role branch (`branchIds[0]`) | 1 : 1 | reference | Branch login deactivated with branch |
| branches | users, role manager (`branchIds`) | many : many | array of references | Branch removed from list |
| branches | staff (`branchId`) | 1 : many | reference | Deactivate; staff kept |
| branches | appointments, bills, expenses, dayClosures, attendance, payrollRuns, stockBalances, stockMovements, purchaseOrders, leads, dues | 1 : many | reference | Kept, read-only |
| branches | services.branchPrices (`branchId`) | 1 : many | embedded in service | Entry ignored |
| branches | hours, holidays | 1 : many | embedded | — |
| branchRequests | branches (`branchId`) | many : 1 | reference | Kept |
| users | staff (`users.staffId`) | 1 : 0..1 | reference | Link cleared |
| platformAdmins | branchRequests (`handledBy`), importJobs | 1 : many | reference | Kept |
| categories | categories (`parentId`) | 1 : many | reference | Block |
| categories | services (`categoryId`) | 1 : many | reference | Block |
| services | appointments.lines, bills.lines (`serviceId`, `refId`) | 1 : many | reference + name snapshot | Deactivate |
| services | products via `consumables[]` | many : many | embedded array of references | Deactivate |
| services | staff via `staff.serviceIds` | many : many | arrays of references | Id removed from arrays |
| products | stockMovements, stockBalances, purchaseOrders.items, transfers.items, bills.lines | 1 : many | reference | Deactivate |
| vendors | purchaseOrders (`vendorId`) | 1 : many | reference | Deactivate |
| staff | rosters (`staffId`) | 1 : 1 | reference | Exit; kept |
| staff | attendance, leaves, advances, payslips, staffBlocks | 1 : many | reference | Exit; kept |
| staff | appointments.lines, bills.lines.staff, bills.tips, payrollRuns.lines | 1 : many | reference + name snapshot | Kept |
| staff (receptionist) | bills (`billedByStaffId`) | 1 : many | reference + name snapshot | Kept |
| customers | appointments, bills, dues, customerPlans, walletLedger, loyaltyLedger, feedback | 1 : many | reference | Never deleted (merge moves children) |
| customers | customers (`referredBy`, `mergedInto`) | 1 : many | reference | Kept |
| customers | waConversations, leads (`customerId`) | 1 : many | reference | Kept |
| appointments | bills (`appointmentId` ↔ `billId`) | 1 : 0..1 | reference both ways | Kept |
| bills | lines, payments, tips, redemptions | 1 : many | embedded | — |
| bills | billVersions (`billId`) | 1 : many | reference | Kept |
| bills | dues (`billId`) | 1 : 0..1 | reference | Due voided on cancel |
| bills | customerPlans (`soldBillId`) | 1 : many | reference | Plan cancelled on bill cancel (if unused) |
| bills | walletLedger, loyaltyLedger, stockMovements (`billId` / `refId`) | 1 : many | reference | Reversing entries added |
| bills | feedback (`billId`) | 1 : 0..1 | reference | Kept |
| plans | customerPlans (`planId`) | 1 : many | reference + snapshot | Deactivate |
| customerPlans | bills.redemptions (`refId`) | 1 : many | reference | Kept |
| purchaseOrders | stockMovements (`refId`) | 1 : many | reference | Cancel only before receipt |
| transfers | stockMovements (`refId`) | 1 : 2 per item | reference | Cancel only before dispatch |
| stockAudits | stockMovements (`refId`) | 1 : many | reference | Kept |
| payrollRuns | payslips (`runId`) | 1 : many | reference | Locked runs never change |
| recurringExpenses | expenses (`recurringId`) | 1 : many | reference | Deactivate |
| expenses | pettyCashEntries (`refId`) | 1 : 0..1 | reference | Soft delete both |
| waNumbers | waTemplates, waConversations, campaigns, webhookEvents | 1 : many | reference | Status error; kept |
| waNumbers | branches (`waNumberId`), businesses (`defaultWaNumberId`) | 1 : many | reference | Falls back to business number |
| waConversations | waMessages (`conversationId`) | 1 : many | reference | Kept 2 years |
| waConversations | leads (`conversationId`) | 1 : 0..1 | reference | Kept |
| waTemplates | campaigns, automations, waMessages (`templateId`) | 1 : many | reference | Rejected template blocks use |
| campaigns, automations | waMessages (`originId`) | 1 : many | reference | Kept |
| waMessages | automationSends (`messageId`) | 1 : 1 | reference | Kept |
| users | attendance (`markedBy`), notifications, leads (`assignedTo`), waConversations (`assignedTo`) | 1 : many | reference | Kept |
| any entity | auditLogs (`entity`, `entityId`) | 1 : many | polymorphic reference | Kept 3 years |

**Links added after the dry-run test**

| Parent | Child (field) | Cardinality | Stored as | If parent is deleted or deactivated |
| --- | --- | --- | --- | --- |
| platformAdmins, users | emailRegistry (`accountId`) | 1 : 1 | reference | Entry kept while the login exists |
| businesses | branches (`headBranchId`) | 1 : 1 | reference | Head branch cannot be deactivated |
| branches | users (`branchLoginFor`) | 1 : 1 | reference | Login deactivated with branch |
| customers | dueReceipts (`customerId`) | 1 : many | reference | Kept |
| dueReceipts | dues (`allocations.dueId`) | many : many | embedded array of references | Kept; cancelling a receipt re-opens its dues |
| advances | expenses (`expenseId`) | 1 : 0..1 | reference | Kept |

## 14. Sample documents

The examples below follow one salon (Glamour Studio, GST on) through one customer visit, so the ids connect across documents. Ids are shortened for reading; real ones are 24-character ObjectIds.

**businesses**

```json
{
  "_id": "biz_01",
  "name": "Glamour Studio",
  "address": { "line1": "12 VIP Road", "city": "Surat", "state": "Gujarat", "pincode": "395007" },
  "gst": { "enabled": true, "gstin": "24ABCDE1234F1Z5", "pan": "ABCDE1234F", "rateBps": 1800, "sac": "9983", "pricesInclusive": false },
  "fyStartMonth": 4,
  "discountLimits": { "managerBps": 2000, "branchBps": 1000, "ownerAlertBps": 2500 },
  "dayEndReportTime": "23:00",
  "loyalty": { "enabled": false },
  "payroll": { "pf": { "enabled": false }, "esi": { "enabled": false }, "pt": { "enabled": true, "slabs": [{ "uptoPaise": 1200000, "amountPaise": 0 }, { "uptoPaise": 999999999, "amountPaise": 20000 }] } },
  "ownerWhatsappPhone": "+919800000001",
  "defaultWaNumberId": "wan_01",
  "status": "active"
}
```

**branches**

```json
{
  "_id": "br_01", "businessId": "biz_01",
  "name": "Vesu", "code": "SRT1", "invoicePrefix": "SRT1",
  "address": { "line1": "Shop 4, Vesu Main Road", "city": "Surat", "state": "Gujarat", "pincode": "395007" },
  "phone": "+919800000010",
  "hours": [ { "day": 1, "open": "10:00", "close": "21:00", "closed": false }, { "day": 2, "closed": true } ],
  "holidays": [ { "date": "2026-11-08", "name": "Diwali" } ],
  "stations": 6, "pettyCashFloatPaise": 200000, "status": "active"
}
```

**customers**

```json
{
  "_id": "cus_01", "businessId": "biz_01",
  "name": "Neha Shah", "phone": "+919812345678", "gender": "female", "dob": "1994-03-14",
  "source": "walk_in", "tags": ["Regular"], "waOptIn": true, "doNotMessage": false,
  "stats": { "firstVisit": "2026-08-02", "lastVisit": "2026-10-26", "visits": 5, "spendPaise": 845000, "noShows": 0, "favStaffId": "stf_01" },
  "walletBalancePaise": 200000, "loyaltyPoints": 0, "duePaise": 0
}
```

**appointments**

```json
{
  "_id": "apt_01", "businessId": "biz_01", "branchId": "br_01", "customerId": "cus_01",
  "businessDate": "2026-10-26",
  "lines": [ { "_id": "apl_01", "serviceId": "svc_01", "serviceName": "Haircut (Women)", "staffId": "stf_01", "start": "2026-10-26T11:00:00Z", "end": "2026-10-26T11:45:00Z" } ],
  "start": "2026-10-26T11:00:00Z", "end": "2026-10-26T11:45:00Z",
  "status": "billed", "source": "phone", "billId": "bil_01",
  "statusLog": [ { "status": "booked", "at": "2026-10-25T09:12:00Z", "by": "usr_br01" }, { "status": "billed", "at": "2026-10-26T11:52:00Z", "by": "usr_br01" } ]
}
```

**bills** (haircut ₹800 + shampoo ₹600, 18% GST, split UPI and cash, ₹100 cash tip)

```json
{
  "_id": "bil_01", "businessId": "biz_01", "branchId": "br_01",
  "invoiceNo": "SRT1/2026-27/000123", "fy": "2026-27", "businessDate": "2026-10-26",
  "customerId": "cus_01", "customerSnap": { "name": "Neha Shah", "phone": "+919812345678" },
  "billedByStaffId": "stf_09", "billedByName": "Pooja", "appointmentId": "apt_01",
  "gstApplied": true, "pricesInclusive": false,
  "lines": [
    { "_id": "bl_01", "kind": "service", "refId": "svc_01", "name": "Haircut (Women)", "hsnSac": "9983", "qty": 1,
      "unitPricePaise": 80000, "discountPaise": 0, "taxablePaise": 80000, "gstBps": 1800, "cgstPaise": 7200, "sgstPaise": 7200, "totalPaise": 94400,
      "staff": [ { "staffId": "stf_01", "name": "Ravi", "splitBps": 10000, "commissionPaise": 8000 } ],
      "consumablesUsed": [ { "productId": "prd_05", "qty": 30, "costPaise": 1800 } ] },
    { "_id": "bl_02", "kind": "product", "refId": "prd_02", "name": "Keratin Shampoo 250 ml", "hsnSac": "3305", "qty": 1,
      "unitPricePaise": 60000, "discountPaise": 0, "taxablePaise": 60000, "gstBps": 1800, "cgstPaise": 5400, "sgstPaise": 5400, "totalPaise": 70800,
      "staff": [ { "staffId": "stf_01", "name": "Ravi", "splitBps": 10000, "commissionPaise": 3000 } ] }
  ],
  "redemptions": [],
  "totals": { "grossPaise": 140000, "discountPaise": 0, "taxablePaise": 140000, "cgstPaise": 12600, "sgstPaise": 12600, "roundOffPaise": 0, "totalPaise": 165200, "paidPaise": 165200, "duePaise": 0 },
  "payments": [ { "mode": "upi", "amountPaise": 100000, "businessDate": "2026-10-26", "at": "2026-10-26T11:52:00Z" }, { "mode": "cash", "amountPaise": 65200, "businessDate": "2026-10-26", "at": "2026-10-26T11:52:00Z" } ],
  "tips": [ { "staffId": "stf_01", "staffName": "Ravi", "amountPaise": 10000, "payout": "cash_today" } ],
  "status": "paid", "version": 1, "refunds": [],
  "idempotencyKey": "8f3c2a1e-6b1d-4c9e-9a77-2d5f0c1b7e10"
}
```

**walletLedger** (₹2,000 top-up offer: pay ₹1,800, get ₹2,000)

```json
[
  { "_id": "wl_01", "businessId": "biz_01", "customerId": "cus_01", "branchId": "br_01", "type": "topup", "amountPaise": 180000, "billId": "bil_090", "balanceAfterPaise": 180000 },
  { "_id": "wl_02", "businessId": "biz_01", "customerId": "cus_01", "branchId": "br_01", "type": "bonus", "amountPaise": 20000, "billId": "bil_090", "balanceAfterPaise": 200000 }
]
```

**payrollRuns** (one line shown: salary ₹15,000, 28 of 31 paid days)

```json
{
  "_id": "pr_01", "businessId": "biz_01", "branchId": "br_01", "month": "2026-10", "status": "locked",
  "lines": [
    { "staffId": "stf_01", "staffName": "Ravi", "paidDays": 28,
      "salaryPaise": 1354839, "commissionPaise": 620000, "overtimePaise": 40000, "tipsPaise": 50000, "incentivesPaise": 0,
      "advancePaise": 100000, "pfPaise": 0, "esiPaise": 0, "ptPaise": 20000, "otherDeductionPaise": 0,
      "netPaise": 1944839, "adjustments": [], "paid": { "mode": "bank", "date": "2026-11-01" } }
  ],
  "totals": { "netPaise": 1944839 }, "lockedBy": "usr_owner", "lockedAt": "2026-11-01T06:30:00Z"
}
```

In the payroll line, salary = ₹15,000 × 28 ÷ 31 = ₹13,548.39; net = 13,548.39 + 6,200 + 400 + 500 − 1,000 − 200 = ₹19,448.39.

## 15. Indexes and retention

Every tenant index starts with `businessId`, so each query touches only one salon's data; unique indexes enforce the "one per" rules from the tables above.

| Collection | Index (fields) | Type | Serves |
| --- | --- | --- | --- |
| platformAdmins | email | unique | Login |
| users | email | unique | Login |
| users | businessId, role |  | User lists |
| branches | businessId, code | unique | Branch code |
| branchRequests | businessId, status |  | Request lists |
| staff | businessId, branchId, status |  | Staff lists, billed-by |
| customers | businessId, phone | unique | Lookup, duplicate check |
| customers | businessId, stats.lastVisit |  | Win-back, lapsed |
| customers | businessId, dob |  | Birthday automation |
| customers | businessId, name (text) | text | Search |
| categories | businessId, parentId, order |  | Category tree |
| services | businessId, categoryId |  | Catalogue |
| products | businessId, type |  | Stock lists |
| appointments | businessId, branchId, businessDate |  | Calendar |
| appointments | businessId, lines.staffId, lines.start |  | Clash check |
| appointments | businessId, customerId, start (desc) |  | Customer history |
| staffBlocks | businessId, staffId, start |  | Clash check |
| bills | businessId, invoiceNo | unique | Numbering |
| bills | businessId, idempotencyKey | unique | Double-save protection |
| bills | businessId, branchId, businessDate (desc) |  | Bill lists, day-end |
| bills | businessId, customerId, businessDate (desc) |  | Customer history |
| bills | businessId, status, branchId |  | Approvals queue |
| billVersions | businessId, billId, version | unique | Versions |
| dues | businessId, customerId, status |  | Collect dues |
| feedback | businessId, branchId, createdAt |  | Reports |
| customerPlans | businessId, customerId, status |  | Redemption |
| customerPlans | businessId, validTill, status |  | Expiry job |
| customerPlans | businessId, voucherCode | unique, sparse | Voucher lookup |
| walletLedger, loyaltyLedger | businessId, customerId, createdAt (desc) |  | Ledger view |
| stockMovements | businessId, branchId, productId, createdAt (desc) |  | Movement history |
| stockBalances | businessId, branchId, productId, pool | unique | Balance |
| purchaseOrders, transfers | businessId, status, createdAt (desc) |  | Lists |
| rosters | businessId, staffId | unique | One roster per staff |
| attendance | businessId, staffId, businessDate | unique | One entry per day |
| attendance | businessId, branchId, businessDate |  | Daily sheet |
| leaves | businessId, staffId, from |  | Calendar blocking |
| payrollRuns | businessId, branchId, month | unique | One run per month |
| expenses | businessId, branchId, businessDate (desc) |  | Lists, day-end |
| dayClosures | businessId, branchId, businessDate | unique | One closure per day |
| leads | businessId, branchId, stage |  | Board |
| leads | businessId, followUpDate |  | Reminders |
| waConversations | businessId, numberId, phone | unique | One thread per phone |
| waConversations | businessId, branchId, lastMessageAt (desc) |  | Inbox |
| waMessages | conversationId, createdAt (desc) |  | Thread |
| waMessages | providerMessageId | unique, sparse | Webhook dedupe |
| automations | businessId, key | unique | One per type |
| auditLogs | businessId, at (desc) |  | Audit search |
| auditLogs | businessId, entity, entityId |  | Record history |
| notifications | userId, createdAt (desc) |  | Bell |
| notifications | createdAt | TTL 90 days | Auto-delete |
| webhookEvents | receivedAt | TTL 7 days | Auto-delete |
| dailySummaries | businessId, businessDate |  | Reports |

**Indexes added after the dry-run test**

| Collection | Index (fields) | Type | Serves |
| --- | --- | --- | --- |
| emailRegistry | \_id (email) | unique (built in) | One email across all logins |
| users | businessId, role (role = owner) | partial unique | One owner per business |
| users | branchLoginFor | unique, sparse | One login per branch |
| branches | businessId, invoicePrefix | unique | No duplicate invoice numbers |
| customers | businessId, altPhones | multikey | Find merged customers by old phone |
| dueReceipts | businessId, receiptNo | unique | Receipt numbering |
| dueReceipts | businessId, branchId, businessDate |  | Day-end and summaries |
| bills | businessId, branchId, payments.businessDate | multikey | Collections by day received |
| bills | businessId, branchId, refunds.businessDate | multikey, sparse | Refunds by day |

**Retention**

| Data | Kept for | Then |
| --- | --- | --- |
| Bills, ledgers, stock movements, payroll, expenses, day closures | 8 years | Archived to S3 (cold storage) |
| Audit logs | 3 years | Archived |
| WhatsApp messages | 2 years | Deleted |
| Notifications | 90 days | TTL delete |
| Webhook raw events | 7 days | TTL delete |
| Customer personal data on a deletion request | Until request | Name and phone anonymised; bills kept |

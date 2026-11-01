# Glox Salon — Branch Login APIs (Frontend Integration Guide)

A **branch login** is one shared credential per branch, used by that branch's receptionists at the front desk. It works in **its own branch only** and follows the PRD §3 permission matrix.

Branch logins use the same endpoints as the owner, so this guide doesn't repeat every request and response shape. It lists:
- what the branch login can and can't do on each screen;
- the endpoints and fields that are new or different for it;
- the errors it must handle;
- a step-by-step frontend checklist.

For full request and response bodies, see [OWNER_API_GUIDE.md](OWNER_API_GUIDE.md). Section numbers like "§14" point there. For the manager's side of shared flows (approvals, PO approval, transfer dispatch), see [MANAGER_API_GUIDE.md](MANAGER_API_GUIDE.md).

## Contents

1. [Test logins](#1-test-logins)
2. [The rules in one place](#2-the-rules-in-one-place)
3. [Session: `GET /auth/me`](#3-session-get-authme)
4. [Sidebar: what the branch login sees](#4-sidebar-what-the-branch-login-sees)
5. [Home and front desk](#5-home-and-front-desk)
6. [Team: staff are names only](#6-team-staff-are-names-only)
7. [Stock](#7-stock)
8. [Money](#8-money)
9. [Errors a branch login sees](#9-errors-a-branch-login-sees)
10. [Frontend implementation checklist](#10-frontend-implementation-checklist)
11. [Backend changes for the branch login (2026-11-01)](#11-backend-changes-for-the-branch-login-2026-11-01)

---

## 1. Test logins

On Atlas (Glox Test Salon), password `Test@1234`:

| Login | Branch | Use it to test |
| --- | --- | --- |
| `branch@glox.test` | TST1 | The front desk. Request stock **from** TST2, raise a PO for TST1 |
| `branch2@glox.test` | TST2 | The other side of a transfer, and that TST1 data stays out of reach |

The manager decides whether the front desk can mark attendance: Settings → Branch logins → "Can mark attendance" (`PATCH /business/branch-logins/:id`, manager guide §6). The change applies on the next request.

The JSON in this guide was captured on the test database (business "Glamour Studio", branches SRT1 "Vesu" and SRT2 "Adajan"). On Atlas you'll see Glox Test Salon, TST1 and TST2.

---

## 2. The rules in one place

1. **One branch.** `user.branchIds` has exactly one id (also in `user.branchId`). There's no branch switcher and no "All branches".
   - A **screen** for another branch → **403** "You do not have access to this branch".
   - A **record** from another branch (staff member, bill, appointment) → **404**.
2. **Front desk, not back office.** The branch login *creates*: bookings, customers, bills, expenses, POs, stock requests, internal use and counts. Correcting or approving stays with the manager or owner: edit, cancel or refund a bill; approve a held bill, PO, transfer, stock count or day-end; adjust stock; edit or delete an expense.
3. **Billed by on every bill.** `billedByStaffId` is required. Pick the name from `GET /staff/branches/:branchId/billed-by`.
4. **Discount limit.** `config.discountLimitBps` (business `discountLimits.branchBps`, default `1000` = 10 %). Above it, or when a bill is left part-paid, it saves as `awaiting_approval` and a manager decides it.
5. **Masked customers.** Lists and search show `98XXXXXX10`. On the booking and bill screens, call `POST /customers/:id/reveal` to show the full number. Every reveal is written to the audit log. No export.
6. **No money internals.** The branch login never gets:
   - staff salary, commission, PF/ESI, bank details, documents or contacts;
   - product purchase prices, stock value or movement cost;
   - vendor bill amounts on POs.

   It does see what it needs for its work: selling prices, PO rates it enters, and today's sales.
7. **Flags.** Only `markAttendance` matters for a branch login. The manager flags in `user.flags` are always `false` for a branch login; ignore them.

---

## 3. Session: `GET /auth/me`

**200** (captured):

```json
{
  "business": { "_id": "6ae6fedc278ed8920e2d7504", "name": "Glamour Studio", "status": "active", "gst": { "enabled": false } },
  "branches": [{ "_id": "6ae6fedc278ed8920e2d7506", "name": "Vesu", "code": "SRT1", "status": "active" }],
  "config": {
    "gst": { "enabled": false, "rateBps": 1800, "pricesInclusive": false },
    "fyStartMonth": 4,
    "discountLimitBps": 1000,
    "loyalty": { "enabled": true, "earnPer100": 1, "redeemValuePaise": 100, "minRedeem": 10, "expiryDays": 365 },
    "payroll": { "pf": false, "esi": false, "pt": false }
  },
  "user": {
    "id": "6ae6fedc278ed8920e2d751e", "name": "Vesu Login", "email": "branch_mvxljc012@salon.test",
    "role": "branch", "kind": "tenant",
    "businessId": "6ae6fedc278ed8920e2d7504",
    "branchId": "6ae6fedc278ed8920e2d7506",
    "branchIds": ["6ae6fedc278ed8920e2d7506"],
    "flags": { "markAttendance": false, "manageStaff": false, "approvePO": false, "viewPayroll": false, "editBranchPrices": false, "editBranch": false, "manageCatalogue": false, "manageCustomers": false, "manageFinance": false, "managePayroll": false, "exportAudit": false, "manageMarketing": false }
  }
}
```

| Field | Use it for |
| --- | --- |
| `user.branchId` | The fixed active branch for every `/branches/:branchId/...` call |
| `config.discountLimitBps` | "Needs approval above 10 %" on the bill screen |
| `config.gst`, `config.loyalty` | GST columns, points to earn and redeem on the bill |
| `user.flags.markAttendance` | Show or hide Attendance |

---

## 4. Sidebar: what the branch login sees

This is the PRD matrix applied to your sidebar. ✅ = use · 👁 = view only · ⚑ = only with the flag · ❌ = remove from the branch nav.

| Group → item | Branch | Endpoints and notes |
| --- | --- | --- |
| **Dashboard** | ✅ | Own day summary ([§5.1](#51-dashboard-own-day-summary)) |
| **Front Desk → Calendar** | ✅ | The PRD's receptionist home screen (§13). Book, walk-in, reschedule, status, staff blocks |
| Front Desk → Customers | ✅ | Create, edit, notes, history. **Masked** lists; reveal on booking and bill screens (§12) |
| Front Desk → Bills | 👁 | `GET /branches/:id/bills`, detail, PDF. **No** edit, cancel or refund (403) |
| Front Desk → New bill | ✅ | Create with **Billed by**; sell and redeem plans, wallet and vouchers on the bill (§14, §15) |
| Front Desk → Leads, WhatsApp | ✅ later | PRD: full, own branch. Built in the later phase for every role; show "Coming soon" |
| Front Desk → Approvals | ❌ | `GET /approvals` → 403. Held bills show as `awaiting_approval` in Bills |
| **Catalogue → Services** | 👁 | Prices are read-only |
| Catalogue → Plans | ❌ | No screen needed; plans are sold on the bill (`GET /plans` still works for the bill's plan picker) |
| **Team → Attendance** | ⚑ `markAttendance` | Mark for own staff (§7) |
| Team → Roster | 👁 | `GET /staff/:id/roster`; editing → 403 |
| Team → Leave | 👁 | `GET /staff/branches/:id/leaves`; recording or deciding → 403 |
| Team → Staff, Salary advances, Payroll | ❌ | PRD: staff records and payroll "None". Advances → 403 |
| **Stock → Inventory** | ✅ | Stock **quantities**; record **salon use** ([§7.2](#72-salon-use-internal-use)); stock-audit **counts** ([§7.5](#75-stock-audit-counts)) |
| Stock → Purchase orders | ✅ *(new)* | **Raise and receive**, own branch ([§7.3](#73-purchase-orders-raise-and-receive)) |
| Stock → Transfers | ✅ *(new)* | **Request stock into** own branch, **receive** it ([§7.4](#74-transfers-request-and-receive)) |
| Stock → Products | 👁 | No purchase price ([§7.1](#71-stock-and-products-without-cost)) |
| Stock → Vendors | 👁 | `GET /vendors`, for the PO form; there's no separate screen to show |
| **Money → Expenses** | ✅ | **Add** only, plus petty cash. Edit and delete → 403 |
| Money → Day-end | ✅ | **Submit** the count; the manager approves (§17.2) |
| Marketing, Insights (Reports, Audit log), Settings | ❌ | All 403 for the branch login |
| Notifications | ✅ | Low stock, appointment cancelled or no-show |

---

## 5. Home and front desk

### 5.1 Dashboard: own day summary

`GET /dashboard` returns **today only** for the branch login. `mtd` and `last7Days` are no longer sent (the owner and managers still get them). A `?branchId=` of another branch → 403.

**200** (captured):

```json
{
  "date": "2026-11-01",
  "branchIds": ["6ae6fedc278ed8920e2d7506"],
  "today": {
    "salesPaise": 0, "totalPaise": 0, "billsCount": 0, "customersCount": 0, "newCustomersCount": 0,
    "avgTicketSizePaise": 0, "appointmentsCount": 0, "appointmentsByStatus": {},
    "collections": { "cash": 0, "upi": 0, "card": 0, "wallet": 0 }
  },
  "topServicesToday": [],
  "pendingApprovalsCount": 0,
  "lowStockCount": 0,
  "openDuesPaise": 0,
  "unreadWaCount": 0
}
```

Your `branch-dashboard.tsx` only reads `today`, `lowStockCount` and `unreadWaCount`, so it keeps working. Make `mtd` and `last7Days` optional in the `src/lib/api/dashboard.ts` type.

### 5.2 New bill: Billed by and the discount limit

**Billed by list:** `GET /staff/branches/:branchId/billed-by` lists the active receptionists, with no phone for the branch login:

```json
[{ "_id": "6ae6fedc278ed8920e2d7524", "name": "Riya Reception", "designation": "receptionist" }]
```

**Without `billedByStaffId`:**

```json
400 { "error": { "code": "VALIDATION_ERROR", "message": "billedByStaffId is required for bills created by branch login", "fields": { "billedByStaffId": "Choose who is billing" } } }
```

**Over the limit:** a 20 % discount with a 10 % limit saves the bill, held (trimmed):

```json
201 {
  "invoiceNo": "SRT1/2026-27/000001", "billedByName": "Riya Reception",
  "totals": { "grossPaise": 100000, "discountPaise": 20000, "totalPaise": 80000, "paidPaise": 80000, "duePaise": 0 },
  "status": "awaiting_approval",
  "approval": { "reasons": ["discount_over_limit"], "requestedAt": "2026-11-01T08:57:00.475Z", "requestedBy": "6ae6fedc278ed8920e2d751e" }
}
```

Show "Sent to manager for approval". The bill appears in Bills with that status until a manager approves or rejects it.

### 5.3 Customers: masked

`GET /customers` (captured): `"phone": "98XXXXXX10"`. On the booking and bill screens, show a "Show number" button:

```json
POST /customers/:id/reveal  →  200 { "phone": "+919876543210" }
```

Each reveal is written to the audit log. Create and edit work as usual (§12). Merge and export → 403.

---

## 6. Team: staff are names only

PRD: staff records are **None** for the branch login. The bill, calendar, attendance, roster and leave screens still need staff **names**, so every staff read returns a slim record:

| Endpoint | Branch login gets |
| --- | --- |
| `GET /staff`, `GET /staff/:id` | `_id`, `branchId`, `name`, `designation`, `serviceIds`, `status` |
| `GET /staff/branches/:id/attendance` | each row's `staff` in the same slim form |
| `GET /staff/branches/:id/leaves` | `staffId` as `{ name, designation }` |
| `GET /staff/branches/:id/billed-by` | `_id`, `name`, `designation` |
| `GET /staff/branches/:id/advances` | **403** |

`GET /staff` (captured):

```json
[
  { "_id": "6ae6fedc278ed8920e2d7524", "branchId": "6ae6fedc278ed8920e2d7506", "name": "Riya Reception", "designation": "receptionist", "serviceIds": [], "status": "active", "businessId": "6ae6fedc278ed8920e2d7504" },
  { "_id": "6ae6fedc278ed8920e2d7526", "branchId": "6ae6fedc278ed8920e2d7506", "name": "Sam Stylist", "designation": "stylist", "serviceIds": [], "status": "active", "businessId": "6ae6fedc278ed8920e2d7504" }
]
```

Not included for the branch login: `phone`, `joiningDate`, `salary`, `commission`, `statutory`, `bankRef`, `documents` and `emergencyContact`. Owners and managers still get the full record.

---

## 7. Stock

### 7.1 Stock and products, without cost

`GET /branches/:id/stock` keeps `qty`, `reorderLevel` and `low`. For the branch login it drops `valuePaise` and the product's `purchasePricePaise` (captured):

```json
[
  {
    "_id": "6ae6fedc278ed8920e2d7537", "branchId": "6ae6fedc278ed8920e2d7506", "pool": "retail", "qty": 10,
    "productId": { "_id": "6ae6fedc278ed8920e2d7530", "name": "Argan Shampoo", "type": "retail", "purchaseUnit": "bottle", "useUnit": "bottle", "unitsPerPurchase": 1, "sellingPricePaise": 50000, "active": true, "reorderLevels": [] },
    "reorderLevel": null, "low": false
  }
]
```

`GET /products` drops `purchasePricePaise` and keeps `mrpPaise` and `sellingPricePaise`. `GET /branches/:id/stock/movements` drops `costPaise`.

### 7.2 Salon use (internal use)

`POST /branches/:branchId/stock/adjust` is open to the branch login **only with `type: "internal_use"`** and a negative `qty`:

```json
{ "productId": "6ae6fedc278ed8920e2d752e", "pool": "consumable", "qty": -20, "type": "internal_use", "reason": "Back-bar shampoo" }
```

**201** (captured; there's no `costPaise` for the branch login):

```json
{
  "balance": { "productId": "6ae6fedc278ed8920e2d752e", "pool": "consumable", "qty": 480 },
  "movement": { "type": "internal_use", "qty": -20, "reason": "Back-bar shampoo", "businessDate": "2026-11-01" }
}
```

Any other adjustment:

```json
403 { "error": { "code": "FORBIDDEN", "message": "A branch login can only record internal use; ask a manager for other adjustments" } }
```

### 7.3 Purchase orders: raise and receive

PRD §10: "Branch login or manager raises a PO." The branch login can:

| Action | Endpoint | Branch |
| --- | --- | --- |
| List and open | `GET /purchase-orders`, `GET /purchase-orders/:id` | Own branch only |
| Raise | `POST /purchase-orders` with `branchId` = own branch | ✅ → `pending_approval` |
| Approve or reject | `POST /purchase-orders/:id/decide` | ❌ 403 (manager with `approvePO`, or owner) |
| Receive goods | `POST /purchase-orders/:id/receive` | ✅ once approved |
| Vendor bill | `POST /purchase-orders/:id/bill` | ❌ 403 |

**Raise:** the request body is the same as for the owner (§16.3). Vendors come from `GET /vendors`. The rate is entered by hand, because the branch login has no purchase price to prefill it.

```json
POST /purchase-orders
{ "branchId": "6ae6fedc278ed8920e2d7506", "vendorId": "6ae6fedc278ed8920e2d7596", "items": [{ "productId": "6ae6fedc278ed8920e2d7530", "qtyPurchaseUnits": 2, "ratePaise": 30000 }] }
```

**201** (captured, trimmed):

```json
{ "_id": "6ae6fedc278ed8920e2d75a6", "poNo": "PO-SRT1-0001", "branchId": "6ae6fedc278ed8920e2d7506", "vendorId": "6ae6fedc278ed8920e2d7596",
  "items": [{ "productId": "6ae6fedc278ed8920e2d7530", "qtyPurchaseUnits": 2, "ratePaise": 30000, "receivedPurchaseUnits": 0 }],
  "totalPaise": 60000, "status": "pending_approval", "approvals": [], "receipts": [] }
```

**Receive** (after a manager approves): `{ "items": [{ "productId": "…", "qty": 2 }] }` → **200** with `"status": "received"`, or `"partly_received"`.

**No `vendorBill` for the branch login:** list, detail, create and receive responses leave out `vendorBill`. The current frontend reads `po.vendorBill.number` directly, so change those reads to `po.vendorBill?.…` ([§10 step 4](#step-4--screen-by-screen)).

| Case | Response |
| --- | --- |
| A PO for another branch | `403 "You do not manage the branch for this purchase order"` |
| Approve or bill | `403 "Access denied for role: branch"` |

### 7.4 Transfers: request and receive

Flow (PRD §10): **request → approve (sending branch) → dispatch → receive**. The branch login **requests stock into its own branch** and **receives** it. The sending branch's manager, or the owner, approves and dispatches.

**Pick the sending branch:** `GET /business/branches/directory` *(new)* returns every active branch by name only. It's open to every salon role. `GET /business/branches` still returns only the user's own branches.

```json
[
  { "_id": "6ae6fedc278ed8920e2d7506", "name": "Vesu", "code": "SRT1", "status": "active" },
  { "_id": "6ae6fedc278ed8920e2d750f", "name": "Adajan", "code": "SRT2", "status": "active" }
]
```

**Request** (as `branch2@glox.test`, TST2, asking TST1):

```json
POST /transfers
{ "fromBranchId": "6ae6fedc278ed8920e2d7506", "toBranchId": "6ae6fedc278ed8920e2d750f", "items": [{ "productId": "6ae6fedc278ed8920e2d7530", "pool": "retail", "qty": 2 }] }
```

**201** (captured, trimmed): `{ "transferNo": "TR-0001", "status": "requested", "log": [{ "action": "requested", "by": "…" }] }`

**Receive** (after dispatch): `POST /transfers/:id/receive` `{ "items": [{ "productId": "…", "receivedQty": 2 }] }` → **200** `"status": "received"`. A short receipt needs a reason (§16.4).

| Case | Response |
| --- | --- |
| `toBranchId` isn't the own branch (pushing stock out) | `403 "A branch login can only request stock for its own branch"` |
| Approve or dispatch | `403 "Access denied for role: branch"` |
| `GET /transfers` | Only transfers into or out of the own branch |

### 7.5 Stock-audit counts

The branch login can start a count sheet and enter the counts. A manager approves it, which posts the variance.

| Action | Endpoint | Branch |
| --- | --- | --- |
| Start a count sheet | `POST /branches/:id/stock-audits` `{ "pool": "retail" }` | ✅ → `status: "counting"` with `systemQty` per product |
| Enter counts | `PATCH /stock-audits/:id/counts` `{ "lines": [{ "productId": "…", "countedQty": 11 }] }` | ✅ → `status: "submitted"` |
| List | `GET /branches/:id/stock-audits` | ✅ |
| Approve | `POST /stock-audits/:id/approve` | ❌ 403 (shows in the manager's Approvals) |

**201** count sheet (captured, trimmed): `{ "_id": "6ae6fedc278ed8920e2d75fa", "pool": "retail", "status": "counting", "lines": [{ "productId": "6ae6fedc278ed8920e2d7530", "systemQty": 10 }] }`

There's no count-sheet screen in the frontend yet; it's a new screen ([§10 step 4](#step-4--screen-by-screen)).

---

## 8. Money

| Action | Endpoint | Branch |
| --- | --- | --- |
| Add an expense | `POST /branches/:id/expenses` | ✅ (§17.1) |
| Edit or delete an expense | `PATCH` or `DELETE /expenses/:id` | ❌ 403 |
| Petty cash | `GET` or `POST /branches/:id/petty-cash` | ✅ |
| Recurring expenses | `GET` ✅; `POST` ❌ | View only |
| Day-end | `GET /branches/:id/closures/:date`, `POST …/submit` | ✅ submit with denominations, UPI and card (§17.2) |
| Approve or reopen the day | `POST …/approve`, `…/reopen` | ❌ 403 |

After the manager approves the day, bills and expenses for that date return `409 DAY_CLOSED`. Show "Day closed. Ask your manager."

---

## 9. Errors a branch login sees

| Status | Example | Show |
| --- | --- | --- |
| 400 | `fields.billedByStaffId: "Choose who is billing"` | Highlight the Billed by picker |
| 403 | `"Access denied for role: branch"` | An action the branch login doesn't have; the UI should never show it |
| 403 | `"You do not have access to this branch"` | A stale link to another branch |
| 403 | `"Permission denied: missing markAttendance privilege"` | The manager switched attendance off; refetch `/auth/me` and hide it |
| 403 | `"A branch login can only record internal use; …"` | Only "Salon use" is offered |
| 403 | `"A branch login can only request stock for its own branch"` | Fix "To" on the own branch |
| 404 | `"Staff member not found"` | A record from another branch |
| 409 | `DAY_CLOSED` | The day is approved; ask the manager |
| 422 | `INVALID_TRANSITION` | E.g. receiving a PO that isn't approved yet |
| 401 | `SESSION_REVOKED` | Super Admin reset the branch login; log out |

---

## 10. Frontend implementation checklist

I checked `~/Desktop/Glox-Salon-Management-Frontend` (read only; nothing there was changed). **No screen crashes today.** The only visible issue is "₹NaN" in the Inventory cost columns. Purchase orders and transfers aren't in the branch nav yet, so their `vendorBill` reads can't fail until you add them.

### Step 1 — Types (shared)

| File | Change |
| --- | --- |
| `src/types/session.ts` | Add `branchId?: string` to the session user, and `config` if not done in the manager phase |
| `src/lib/api/dashboard.ts` | `mtd?` and `last7Days?` optional |
| Staff type (wherever `/staff` is typed) | `phone`, `salary`, `commission`, `statutory`, `joiningDate` optional |
| Product and stock types | `purchasePricePaise?`, `valuePaise?` optional |
| `PurchaseOrder` type | `vendorBill?` optional |

### Step 2 — `src/lib/permissions.ts` `MATRIX`

| Action | Now | Change to |
| --- | --- | --- |
| `po.raise` | `{ owner, manager }` | add `branch: true` |
| `po.receive` *(new)* | — | `{ owner: true, manager: true, branch: true }` |
| `po.bill` *(new)* | — | `{ owner: true, manager: true }` (the "Record vendor bill" button) |
| `transfer.request` *(new)* | — | `{ owner: true, manager: true, branch: true }` |
| `transfer.dispatch` *(new)* | — | `{ owner: true, manager: true }` (approve and dispatch buttons) |
| `transfer.receive` *(new)* | — | `{ owner: true, manager: true, branch: true }` |
| `inventory.internalUse` *(new)* | — | `{ owner: true, manager: true, branch: true }` |
| `inventory.adjust` | `{ owner, manager }` | no change (manual adjustments) |
| `stockAudit.count` *(new)* | — | `{ owner: true, manager: true, branch: true }` |
| `cost.view` *(new)* | — | `{ owner: true, manager: true }`, to hide cost columns |
| `staff.viewDetails` *(new)* | — | `{ owner: true, manager: true }` |

Already right: `bill.create`, `bill.edit/cancel/refund` (no branch), `customer.viewFullPhone` (no branch), `attendance.mark` (branch with `markAttendance`), `expense.add` (branch), `expense.edit/delete` (no branch), `dayEnd.submit` (branch), `dayEnd.approve` (no branch).

### Step 3 — `src/lib/navigation.ts`

| Route | Now | Change to |
| --- | --- | --- |
| `/inventory/purchase-orders` | `roles: OM` | `OMB` |
| `/inventory/transfers` | `roles: OM` | `OMB` |
| `/leads`, `/whatsapp` | `OMB` | Keep; show "Coming soon" until the WhatsApp phase |
| `HOME.branch` | `/dashboard` | Optional: `/calendar` (PRD: "the calendar is the receptionist's home screen") |
| `BOTTOM_BAR.branch` | dashboard, calendar, new bill, customers | No change |

Everything else in the branch nav already matches §4.

### Step 4 — Screen by screen

**Dashboard** (`src/pages/branch-dashboard.tsx`): ✓ no change.

**New bill** (`src/pages/bills/new-bill-page.tsx`): ✓ Billed by is already required for branch (`needsBilledBy`). Make sure the discount hint uses `config.discountLimitBps`, and that a `201` with `status: "awaiting_approval"` shows "Sent to manager for approval".

**Customers:** ✓ masked numbers and reveal (`customer-profile-page.tsx`, `phone-input.tsx`) already exist. Check that the reveal button is offered on the bill and booking screens.

**Bills:** ✓ edit, cancel and refund are hidden by `can()`.

**Attendance, Roster, Leave:** ✓ these pages don't read the hidden staff fields.

**Inventory** (`src/pages/inventory/inventory-page.tsx`):
- Hide the "Cost / price" cost line (around line 460), the "Stock value" column (around line 476), the cost and margin block in the product drawer (around lines 114 and 195), and the value totals (around lines 349 and 389) when `!can('cost.view')`. Show the selling price only.
- The adjust sheet (`inventory-sheets.tsx:326`) already has `kind === 'use'` → `internal_use`. For the branch login, offer **only** "Salon use": use `can('inventory.internalUse')` for that option and `can('inventory.adjust')` for the rest.
- `canSeePos = useCan('po.raise')` starts working once `po.raise` includes branch.

**Products** (`products-page.tsx`): hide the purchase price (around line 571) and cost per sale (line 92) without `cost.view`.

**Purchase orders** (`purchase-orders-page.tsx`, `po-sheets.tsx`):
- Change every `po.vendorBill.x` to `po.vendorBill?.x` (around lines 77, 248–273, 338 and 503; `po-sheets.tsx:590–592`; `vendors-page.tsx:265`).
- Gate the vendor bill section and button with `can('po.bill')`, and Receive with `can('po.receive')`. Approve stays `po.approve`.
- Create sheet: for the branch login, fix the branch to `session.user.branchId`. The rate prefill (`po-sheets.tsx:226, 331`) reads `purchasePricePaise`, which is now missing, so leave the rate empty for the user to type.

**Transfers** (`transfers-page.tsx`, `transfer-sheets.tsx`):
- Build the "from" picker from `GET /business/branches/directory`, not `session.branches`. This also lets managers request from branches they aren't assigned to.
- For the branch login, **To** is fixed to the own branch and **From** is any other branch.
- `canAct()` (lines 181 and 188): approve and dispatch also need `can('transfer.dispatch')`. Receive (line 195) needs `can('transfer.receive')`.
- `valueOf()` (line 95) uses the purchase cost; hide the value without `cost.view`.

**Stock count (new screen, optional for this phase):** under Inventory, add "Count stock":
1. `POST /branches/:id/stock-audits` `{ pool }`;
2. show `lines[].systemQty` with a counted-qty input;
3. `PATCH /stock-audits/:id/counts`;
4. the sheet then shows "Waiting for manager approval".

Gate it with `stockAudit.count`. The manager already approves counts in Approvals (`approvals.ts:195`).

**Expenses and Day-end:** ✓ add and submit only; edit, delete and approve are hidden by `can()`.

**Leads, WhatsApp:** "Coming soon" for now.

### Step 5 — How to test

1. Log in as `branch@glox.test`. Check that Dashboard shows today only, New bill asks for Billed by, and a 20 % discount gets held.
2. Inventory: there are no cost or value columns, and "Salon use" is the only adjustment.
3. Raise a PO for TST1, approve it as `manager@glox.test`, then receive it as the branch.
4. As `branch2@glox.test`, request stock from TST1. As the manager, approve and dispatch it. As `branch2@glox.test`, receive it.
5. Ask `manager@glox.test` to turn on "Can mark attendance" for TST1, refocus the branch tab, and check that Attendance appears.

---

## 11. Backend changes for the branch login (2026-11-01)

| Area | Change |
| --- | --- |
| Staff (**data leak fix**) | Branch logins received full staff records (salary, commission, PF/ESI, bank, documents, emergency contact) from `/staff`, `/staff/:id` and attendance. They now get names only; the leave list gets `{ name, designation }`; the Billed by list has no phone; advances → 403 |
| Purchase orders (PRD gap) | Branch logins raise, list, open and receive POs of their own branch. Approving and vendor bills stay with the manager or owner. `vendorBill` is left out for branch logins |
| Transfers (PRD gap) | Branch logins request stock **into** their own branch and receive it. Approve and dispatch stay with the sending branch's manager or the owner |
| Branch directory *(new)* | `GET /business/branches/directory`: all active branches, `_id name code status` only, for every salon role |
| Stock | Branch logins record **internal use** only, and start and fill stock-audit counts. Approving counts and other adjustments stay with the manager or owner |
| Cost prices | For branch logins: no `purchasePricePaise` on products and stock, no `valuePaise` on stock, no `costPaise` on movements |
| Dashboard | Branch logins get the PRD's "own day summary": `mtd` and `last7Days` are left out |

**Tests:**
- [tests/integration/branch.test.ts](../tests/integration/branch.test.ts) has 10 tests: Billed by, closed bill actions and the discount hold; the dashboard summary; slim staff everywhere; no cost fields; internal use only; PO raise, receive and no approve; the branch directory; transfer request, receive and no dispatch; counts without approval; and closed money, payroll, report and audit actions.
- Full suite: **680 of 726 passing**. The remaining 46 are the same later-phase items as before (leads and WhatsApp, background workers, reports system, auth hardening).

# Glox Salon — Manager Panel APIs (Frontend Integration Guide)

A manager runs **the branches they are assigned to**. They use the same endpoints as the owner, so this guide doesn't repeat request and response shapes. It lists:
- what a manager can and can't do on each screen;
- which permission flags switch features on;
- the new endpoints and fields for managers;
- the errors a manager panel must handle;
- the changes needed in the frontend repo.

For every request and response body, see [OWNER_API_GUIDE.md](OWNER_API_GUIDE.md). Section numbers like "§14" below point there.

## Contents

1. [Test logins](#1-test-logins)
2. [The rules in one place](#2-the-rules-in-one-place)
3. [Session and config: `GET /auth/me`](#3-session-and-config-get-authme)
4. [Screen-by-screen access](#4-screen-by-screen-access)
5. [Branch settings (new for managers)](#5-branch-settings-new-for-managers)
6. [Branch logins (new for managers)](#6-branch-logins-new-for-managers)
7. [Owner-granted access: the six new flags](#7-owner-granted-access-the-six-new-flags)
8. [Errors a manager sees](#8-errors-a-manager-sees)
9. [Frontend implementation checklist](#9-frontend-implementation-checklist)
10. [Backend changes for the manager panel (2026-10-31)](#10-backend-changes-for-the-manager-panel-2026-10-31)

---

## 1. Test logins

Both are in Atlas (Glox Test Salon), password `Test@1234`:

| Login | Branches | Flags on | Flags off | Use it to test |
| --- | --- | --- | --- | --- |
| `manager@glox.test` | TST1 | `manageStaff`, `approvePO`, `viewPayroll`, `editBranchPrices` | `editBranch` | A single-branch manager with most features; branch settings read-only |
| `manager2@glox.test` | TST1 + TST2 | `manageStaff`, `editBranch`; personal discount cap 15 % | `approvePO`, `viewPayroll`, `editBranchPrices` | The branch switcher, "All my branches", hidden Payroll, PO approval and branch-price controls, and editing branch settings |

Both have all six new flags of [§7](#7-owner-granted-access-the-six-new-flags) **off**. Switch them on from the owner's users page (or `PATCH /business/managers/:id`) to test each one.

The owner can change any of these flags in Settings → Users (`PATCH /business/managers/:id`, §5). The change applies on the manager's **next request**, with no new login needed. Refetch `/auth/me` when the app regains focus so the menu follows.

---

## 2. The rules in one place

1. **Branch scope.** A manager works only in `user.branchIds`.
   - A **screen** for another branch (a `branchId` in the URL or query) returns **403** "You do not have access to this branch".
   - A **record** from another branch (bill, appointment, staff member, leave, PO, stock audit, payroll run, expense) returns **404**, as if it didn't exist.
2. **"All branches"** means *all of the manager's branches*: the dashboard, reports, staff list, POs and transfers without a `branchId` combine only their branches.
3. **Flags** switch features on (§3 `user.flags`):

| Flag | Without it | With it |
| --- | --- | --- |
| `manageStaff` | Staff directory is read-only | Add and edit staff in own branches (§7) |
| `approvePO` | Can raise POs but not approve | Approve or reject POs of own branches (§16.3) |
| `viewPayroll` | Payroll hidden (403) | Generate, adjust and review drafts, generate payslips. **Never** lock or mark paid (§24) |
| `editBranchPrices` | Service prices are read-only | Set a branch price or hide a service in own branches (§6) |
| `editBranch` *(new)* | Branch settings are read-only | Edit hours, holidays, stations, review link and petty-cash float of own branches ([§5 below](#5-branch-settings-new-for-managers)) |
| `maxDiscountBps` | The business limit `discountLimits.managerBps` applies | The manager's own cap. The effective number is `config.discountLimitBps` in `/auth/me` |
| `manageCatalogue` *(new)* | Catalogue, plans and products are view only | Create, edit and delete categories, services, products and plans. **Business-wide**: the change applies to every branch |
| `manageCustomers` *(new)* | No export, no wallet adjust, no plan transfer | Customer export (Excel), wallet adjustment, plan transfer |
| `manageFinance` *(new)* | Can't delete expenses or reopen a day | Delete expenses and reopen an approved day-end, own branches only |
| `managePayroll` *(new)* | Payroll stops at "reviewed" | Lock and mark paid, own branches only. Needs `viewPayroll` too |
| `exportAudit` *(new)* | Audit log view only | Export the audit log (own branches' entries only) |
| `manageMarketing` *(new)* | Campaigns and automations view only | Create campaigns and switch automations on or off |

Every flag is **off** by default. Managers created before 2026-10-31 read as `false` for all six, so nothing changes for them until the owner turns a flag on.

4. **Owner only, no flag can unlock it:**
   - business settings (GST, financial year, discount limits, loyalty);
   - managers: create, edit, change flags or branches (including their **own** flags and discount cap);
   - passwords of users;
   - branch add or close requests, and the subscription;
   - approving or rejecting **their own** held bill (point 6).
5. **Customer contacts:** managers see **full** phone numbers and emails, like the owner. Only branch logins see them masked. Reveal still works for managers, but they don't need it.
6. **Discounts and dues:**
   - A bill with a discount above `config.discountLimitBps`, or one left part-paid, is saved as `awaiting_approval` (§14.4).
   - A manager approves or rejects held bills of their branches (§14.5), **except their own**. A bill they sent for approval (`approval.requestedBy` = their user id) returns `403 "You cannot approve or reject a bill you sent for approval"`; the owner or another manager of the branch decides it. In the approvals queue, show their own bills as "Waiting for the owner".
7. **Closed days:** once a day-end is approved, a manager can't bill, edit or cancel bills, or add expenses for that day (`409 DAY_CLOSED`). Only the owner, or a manager with `manageFinance`, can reopen it.

---

## 3. Session and config: `GET /auth/me`

**New: `config`.** Managers and branch logins can't read `GET /business/settings` (owner only, `403`). Everything a non-owner screen needs from settings is now in `/auth/me` under `config`, read-only, for every salon role.

**200** (a manager of two branches, captured on the test database: business "Glamour Studio", branches SRT1 and SRT2. On Atlas you'll see Glox Test Salon, TST1 and TST2):

```json
{
  "business": { "_id": "6ae578abdda9d3d993e80aee", "name": "Glamour Studio", "status": "active", "gst": { "enabled": false } },
  "branches": [
    { "_id": "6ae578abdda9d3d993e80af0", "name": "Vesu", "code": "SRT1", "status": "active" },
    { "_id": "6ae578abdda9d3d993e80af9", "name": "Adajan", "code": "SRT2", "status": "active" }
  ],
  "config": {
    "gst": { "enabled": false, "rateBps": 1800, "pricesInclusive": false },
    "fyStartMonth": 4,
    "discountLimitBps": 1500,
    "loyalty": { "enabled": true, "earnPer100": 1, "redeemValuePaise": 100, "minRedeem": 10, "expiryDays": 365 },
    "payroll": { "pf": false, "esi": false, "pt": false }
  },
  "user": {
    "id": "6ae578abdda9d3d993e80b37", "name": "Second Manager", "email": "manager2@glox.test", "role": "manager", "kind": "tenant",
    "businessId": "6ae578abdda9d3d993e80aee",
    "branchIds": ["6ae578abdda9d3d993e80af0", "6ae578abdda9d3d993e80af9"],
    "flags": { "manageStaff": true, "editBranch": true, "maxDiscountBps": 1500, "approvePO": false, "viewPayroll": false, "editBranchPrices": false, "markAttendance": false }
  }
}
```

| `config` field | Use it for |
| --- | --- |
| `discountLimitBps` | The **effective** discount cap for this user, already worked out: owner `10000`; manager → `flags.maxDiscountBps`, else the business `managerBps` (`2000` for `manager@glox.test`); branch login → `branchBps`. Show "Needs approval above 15 %" on the bill screen |
| `gst` | Show GST columns, the GSTR-1 report, tax-inclusive prices |
| `fyStartMonth` | Report date presets ("This financial year") |
| `loyalty` | Show points, redeem rules and value on the bill and customer screens |
| `payroll` | Show PF, ESI and PT columns on payroll |

`branches` lists only the manager's branches, so build the branch switcher from it. `business.headBranchId` appears (for every role) once the business has a head branch, as Glox Test Salon does.

---

## 4. Screen-by-screen access

✅ = full use within own branches · 👁 = view only · ⚑ = needs the flag · ❌ = hidden (the API returns 403)

| Menu → screen | Manager | Endpoints and notes |
| --- | --- | --- |
| **Dashboard** | ✅ | `GET /dashboard` = all own branches combined; `?branchId=` = one branch (§21) |
| **Front desk → Calendar** | ✅ | Book, walk-in, reschedule, status, staff blocks (§13) |
| Front desk → Customers | ✅ + ⚑ | List, profile, create, edit, notes, history, **merge**. **Full** phone numbers. Export and wallet adjust with `manageCustomers` (§12, §15) |
| Front desk → Bills / New bill | ✅ | Create, preview, list, detail, PDF. Edit, cancel and refund **with a reason** (§14). Not on an approved day (`409 DAY_CLOSED`) or in a payroll-locked month (`409 PAYROLL_LOCKED`) |
| Front desk → Approvals | ✅ | `GET /approvals` returns own branches only; approve or reject (§14.5). Their own held bills also appear but can't be decided by them (`approval.requestedBy`) |
| Front desk → Dues | ✅ | Collect dues (§14.9) |
| Front desk → Leads, WhatsApp | — | Later phase (PRD: full use for managers, no flag) |
| **Catalogue → Services** | 👁 + ⚑ | View categories and services. Set branch prices or hide a service in own branches with `editBranchPrices` (`PATCH /services/:id/branch-prices`, §6). Create, edit and delete with `manageCatalogue` (business-wide) |
| Catalogue → Plans | 👁 + ⚑ | `GET /plans`; create and edit with `manageCatalogue` (§15) |
| Customer → plans, wallet, loyalty | ✅ | Sell and redeem on bills; **extend, freeze, unfreeze** plans (§15.3). Transfer a plan and adjust the wallet with `manageCustomers` |
| **Team → Staff** | 👁 + ⚑ | `GET /staff` returns own-branch staff only. Add or edit with `manageStaff`, own branches only; can't move staff to another branch |
| Team → Attendance | ✅ | Mark for own branches; no flag needed (§7) |
| Team → Roster | ✅ | View and edit rosters of own-branch staff |
| Team → Leave | ✅ | Record leave (approved at once), approve or reject (§7) |
| Team → Salary advances | ✅ | Give advances in own branches (§7) |
| Team → Payroll | ⚑ `viewPayroll` | Generate or regenerate a draft, adjust, review, payslips (§24). Lock and mark paid with `managePayroll`; without it show "Waiting for owner to lock" |
| **Stock → Inventory** | ✅ | Stock, movements, adjust, internal use, stock audits (count and approve) (§16) |
| Stock → Products | 👁 + ⚑ | `GET /products`; create and edit with `manageCatalogue` |
| Stock → Vendors | ✅ | Create and edit vendors (§16.1) |
| Stock → Purchase orders | ✅ + ⚑ | Raise, receive, vendor bill; approve or reject with `approvePO` (§16.3) |
| Stock → Transfers | ✅ | Request; **approve and dispatch** when the manager owns the *sending* branch; **receive** when they own the *receiving* branch (§16.4) |
| **Money → Expenses** | ✅ | Add, edit, recurring, petty cash. Delete with `manageFinance` (§17.1) |
| Money → Day-end | ✅ + ⚑ | Submit and **approve** the count; reopen with `manageFinance` (§17.2) |
| **Insights → Reports** | ✅ | All 13 reports + Excel for own branches (§22) |
| **Marketing → Campaigns, Automations** | 👁 + ⚑ | View; create campaigns and toggle automations with `manageMarketing`. The feature itself is a later phase |
| Insights → Audit log | 👁 + ⚑ | Own branches' entries; export with `exportAudit` (§23) |
| **Settings → Branches** | 👁 + ⚑ `editBranch` | `GET /business/branches` returns own branches. Edit → [§5](#5-branch-settings-new-for-managers) |
| Settings → Branch logins | ✅ | Own branches' logins: switch "Can mark attendance" on or off → [§6](#6-branch-logins-new-for-managers) |
| Settings → Business, Users (managers) | ❌ | Owner only |

---

## 5. Branch settings (new for managers)

`PATCH /business/branches/:branchId` is now open to managers with the **`editBranch`** flag, for **their own branches only**. Managers can edit the same fields as the owner: `hours`, `holidays`, `stations`, `googleReviewUrl` and `pettyCashFloatPaise`. Name, code, address and login stay with Super Admin. `hours` and `holidays` replace the whole list when sent (§4).

```json
{
  "hours": [
    { "day": 0, "open": "09:30", "close": "21:00", "closed": false },
    { "day": 1, "closed": true },
    { "day": 2, "open": "09:30", "close": "21:00", "closed": false },
    { "day": 3, "open": "09:30", "close": "21:00", "closed": false },
    { "day": 4, "open": "09:30", "close": "21:00", "closed": false },
    { "day": 5, "open": "09:30", "close": "21:00", "closed": false },
    { "day": 6, "open": "09:30", "close": "21:00", "closed": false }
  ],
  "holidays": [{ "date": "2026-11-08", "name": "Diwali" }],
  "stations": 7
}
```

**200**: the branch with the new values. Each change is written to the audit log (`branch.update`).

```json
{
  "_id": "6ae578abdda9d3d993e80af9", "name": "Adajan", "code": "SRT2", "invoicePrefix": "SRT2", "phone": "+919800000002",
  "address": { "line1": "12 MG Road", "city": "Surat", "state": "Gujarat", "pincode": "395007" },
  "stations": 7, "pettyCashFloatPaise": 500000, "status": "active",
  "hours": [{ "day": 0, "open": "09:30", "close": "21:00", "closed": false, "_id": "6ae578abdda9d3d993e80b4f" }, "… 7 entries …"],
  "holidays": [{ "date": "2026-11-08", "name": "Diwali" }]
}
```

**Validation** (now for owners too):

| Rule | Error |
| --- | --- |
| Each weekday at most once | `400 {"fields":{"hours.7.day":"Each weekday may appear only once"}}` |
| Open days need both times | `400 {"fields":{"hours.0.open":"Opening and closing times are required on open days"}}` |
| `open` before `close` | `400 {"error":{"code":"VALIDATION_ERROR","message":"Validation failed","fields":{"hours.0.close":"close must be after open"}}}` |
| A closed day needs no times | `{ "day": 1, "closed": true }` is fine |

| Case | Response |
| --- | --- |
| No `editBranch` flag | `403 {"error":{"code":"FORBIDDEN","message":"Permission denied: missing editBranch privilege"}}` |
| Another branch | `403 {"error":{"code":"FORBIDDEN","message":"You do not have access to this branch"}}` |

**Owner side:** Settings → Users gets one more manager toggle, "Can edit branch settings":

```json
PATCH /business/managers/:id
{ "flags": { "editBranch": true } }
```

**200**: the manager, with `"flags": { "manageStaff": true, "approvePO": true, "viewPayroll": true, "editBranchPrices": true, "editBranch": true, "markAttendance": false }`. `POST /business/managers` also accepts `editBranch`.

---

## 6. Branch logins (new for managers)

As the PRD describes, a manager can give their branches' front desk the "mark attendance" permission.

**`GET /business/branch-logins`** returns the logins of the manager's own branches (all branches for the owner):

```json
[
  {
    "_id": "6ae578abdda9d3d993e80b08", "role": "branch", "name": "Vesu Login", "email": "branch_mvvy2dbj2@salon.test",
    "branchIds": ["6ae578abdda9d3d993e80af0"], "branchLoginFor": "6ae578abdda9d3d993e80af0",
    "flags": { "markAttendance": false, "manageStaff": false, "approvePO": false, "viewPayroll": false, "editBranchPrices": false, "editBranch": false },
    "status": "active", "businessId": "6ae578abdda9d3d993e80aee"
  }
]
```

**`PATCH /business/branch-logins/:id`** with `{ "markAttendance": true }` → **200**: the login with `flags.markAttendance: true`. It's written to the audit log (`branch_login.flags_update`).

| Case | Response |
| --- | --- |
| A login of another branch | `403 {"error":{"code":"FORBIDDEN","message":"Cannot modify branch logins of unassigned branches"}}` |
| Any body other than `{ markAttendance }` | `400` |

Setting a branch login's password is still owner only (`POST /business/users/:id/password` → 403).

---

## 7. Owner-granted access: the six new flags

The owner switches these on per manager. The endpoints are the same ones the owner already uses (see the § links), so **no new request or response shapes**. The only change is that a manager with the flag now gets `200` where they used to get `403`.

| Flag | Endpoints it opens to the manager | Scope |
| --- | --- | --- |
| `manageCatalogue` | `POST/PATCH/DELETE /categories`, `POST/PATCH/DELETE /services/:id` (all fields, not only branch prices), `POST/PATCH /products`, `POST/PATCH /plans` | Business-wide |
| `manageCustomers` | `GET /customers/export`, `POST /customers/:id/wallet/adjust`, `POST /customer-plans/:id/transfer` | Business-wide (customers are shared across branches) |
| `manageFinance` | `DELETE /expenses/:id`, `POST /branches/:branchId/closures/:date/reopen` | Own branches; another branch → 403 / 404 |
| `managePayroll` | `POST /payroll-runs/:id/lock`, `POST /payroll-runs/:id/mark-paid` (with `viewPayroll`) | Own branches; another branch's run → 404 |
| `exportAudit` | `GET /audit-logs/export` | Own branches' entries only |
| `manageMarketing` | `POST /whatsapp/campaigns`, `PATCH /whatsapp/automations/:key` | Business-wide |

**Owner side, turning a flag on:**

```json
PATCH /business/managers/:id
{ "flags": { "manageCatalogue": true, "manageFinance": true } }
```

**200** (captured on the test database). Flags you don't send keep their value, because the backend merges them:

```json
{
  "_id": "6ae596ab1af6e4fe2f09a720", "role": "manager", "name": "manager user", "email": "manager_mvw2mz1j5@salon.test",
  "branchIds": ["6ae596ab1af6e4fe2f09a6d9"], "status": "active",
  "flags": {
    "manageStaff": false, "approvePO": false, "viewPayroll": false, "editBranchPrices": false, "editBranch": false,
    "manageCatalogue": true, "manageCustomers": false, "manageFinance": true, "managePayroll": false,
    "exportAudit": false, "manageMarketing": false, "markAttendance": false
  }
}
```

`POST /business/managers` accepts the same six keys. On the manager's next request, `/auth/me` → `user.flags` shows the new values (no new login needed).

**Without the flag** (captured):

```json
{ "error": { "code": "FORBIDDEN", "message": "Permission denied: missing manageCatalogue privilege" } }
```

The other flags return the same error with their own name (`missing manageCustomers privilege`, and so on).

**Safe to ship in any order.** The current owner frontend keeps working before you add the new toggles: the keys are optional, unknown response fields are ignored, and saving one flag doesn't reset the others.

---

## 8. Errors a manager sees

| Status | Example | Show |
| --- | --- | --- |
| 403 | `{"error":{"code":"FORBIDDEN","message":"You do not have access to this branch"}}` | A branch picked from a stale URL or link. Switch to an own branch |
| 403 | `{"error":{"code":"FORBIDDEN","message":"Permission denied: missing viewPayroll privilege"}}` (also `approvePO`, `editBranchPrices`, `editBranch`, `manageStaff`, and the six flags in §7) | The owner switched the flag off; refetch `/auth/me` and hide the feature |
| 403 | `{"error":{"code":"FORBIDDEN","message":"Access denied for role: manager"}}` | An owner-only action (§2 point 4); the UI should never show it |
| 403 | `{"error":{"code":"FORBIDDEN","message":"You cannot approve or reject a bill you sent for approval"}}` | Own held bill; the owner decides |
| 404 | `{"error":{"code":"NOT_FOUND","message":"Staff member not found"}}` | A record from another branch, or one that doesn't exist |
| 422 | `DISCOUNT_LIMIT` on bill edit | The edit gives more discount than `config.discountLimitBps` |
| 409 | `DAY_CLOSED`, `PAYROLL_LOCKED` | The day or month is closed; ask the owner |
| 401 | `SESSION_REVOKED` | The owner changed the manager's branches or deactivated them. Log out |

---

## 9. Frontend implementation checklist

I checked `~/Desktop/Glox-Salon-Management-Frontend` (read only; nothing there was changed). Work through it in this order. Steps 1–3 are shared code; step 4 goes screen by screen down the manager sidebar.

### Step 1 — Types and session (shared)

| File | Change |
| --- | --- |
| `src/types/session.ts` `PermissionFlags` | Add `editBranch`, `manageCatalogue`, `manageCustomers`, `manageFinance`, `managePayroll`, `exportAudit`, `manageMarketing` (all `?: boolean`). Add `config` (§3) to the session type |
| `src/lib/api/auth.ts` | Already passes `user.flags` through unchanged, so no change for flags. Map `config` and `business.headBranchId` from `/auth/me` into the session |
| `src/lib/api/owner.ts` `ManagerFlags` | Add the same seven keys as optional booleans |
| `src/lib/api/mock/data.ts` `NO_FLAGS` | Add the seven keys as `false`, and add `config` to the mocked `/auth/me` |

### Step 2 — Owner side: Settings → Users (`src/pages/settings/users-page.tsx`)

1. **`FLAG_LABELS`**: add seven toggles. Suggested wording:

| Key | Label | Description |
| --- | --- | --- |
| `editBranch` | Edit branch settings | Hours, holidays, stations and petty cash for their branches. |
| `manageCatalogue` | Manage catalogue | Add and edit services, products and plans. **Applies to all branches.** |
| `manageCustomers` | Customer admin | Export customers, adjust wallets, transfer plans. |
| `manageFinance` | Finance corrections | Delete expenses and reopen a closed day. |
| `managePayroll` | Run payroll | Lock and mark payroll paid (needs "View payroll"). |
| `exportAudit` | Export audit log | Download the audit log for their branches. |
| `manageMarketing` | Manage marketing | Create campaigns and switch automations on or off. |

2. **`toFlags()`** (around line 176) and **`NO_FLAGS`** (around line 186): add the seven keys.
3. **Edit form defaults** (around line 337): add `key: Boolean(manager.flags.key)` for each.
4. **`src/lib/schemas/owner.ts` `managerFlags`**: add the seven keys as `z.boolean()`.
5. Optional: disable "Run payroll" while "View payroll" is off. The backend needs both.

### Step 3 — `src/lib/permissions.ts` `MATRIX` and helpers

Change these rows. Rows not listed already match the backend.

| Action | Now | Change to |
| --- | --- | --- |
| `customer.export` | `{ owner: true }` | `{ owner: true, manager: (f) => Boolean(f.manageCustomers) }` |
| `customer.viewFullPhone` | `{ owner: true }` | `{ owner: true, manager: true }` |
| `customer.walletAdjust` *(new action)* | — | `{ owner: true, manager: (f) => Boolean(f.manageCustomers) }` |
| `service.manage` | `{ owner: true }` | `{ owner: true, manager: (f) => Boolean(f.manageCatalogue) }` |
| `plan.manage` | `{ owner: true }` | `{ owner: true, manager: (f) => Boolean(f.manageCatalogue) }` |
| `product.manage` | `{ owner: true }` | `{ owner: true, manager: (f) => Boolean(f.manageCatalogue) }` |
| `payroll.lock` | `{ owner: true }` | `{ owner: true, manager: (f) => Boolean(f.viewPayroll && f.managePayroll) }` |
| `expense.delete` | `{ owner: true }` | `{ owner: true, manager: (f) => Boolean(f.manageFinance) }` |
| `dayEnd.reopen` | `{ owner: true }` | `{ owner: true, manager: (f) => Boolean(f.manageFinance) }` |
| `audit.export` | `{ owner: true, superadmin: true }` | add `manager: (f) => Boolean(f.exportAudit)` |
| `whatsapp.campaigns` | `{ owner: true }` | `{ owner: true, manager: (f) => Boolean(f.manageMarketing) }` |
| `settings.branches` | `{ owner: true, manager: true }` | Keep for **viewing**. Add `settings.branchEdit`: `{ owner: true, manager: (f) => Boolean(f.editBranch) }` for the edit buttons |
| `branchLogin.flags` *(new action)* | — | `{ owner: true, manager: true }` |
| `maxDiscountBps()` | `session.flags.maxDiscountBps ?? 0` (managers without a cap get 0 %) | `session.config.discountLimitBps` |

### Step 4 — Manager sidebar, section by section

The ✓ items need no work beyond step 3, because those screens already call `can()`.

**Front Desk**
- **Calendar, Bills, New bill**: ✓. Show the discount hint from `config.discountLimitBps`.
- **Customers**: ✓ export button (`customer.export`). In `src/pages/customers/profile-tabs.tsx:574`, replace `session?.role === 'owner'` with `can(session, 'customer.walletAdjust')`. Plan transfer has no UI yet; when you add it, use the same action.
- **Approvals**: show the manager's own held bills (`approval.requestedBy === session.user.id`) as "Waiting for the owner", with no approve or reject buttons.
- **Leads, WhatsApp**: later phase. Hide them or show "Coming soon".

**Catalogue**
- **Services**: ✓ (`service.manage`, `service.editBranchPrice`). With `manageCatalogue`, show "Changes apply to all branches" on the edit form.
- **Plans**: ✓ (`plan.manage`).

**Team**
- **Staff, Attendance, Roster, Leave**: ✓.
- **Salary advances**: the nav says `requires: 'staff.manage'` (`src/lib/navigation.ts:205`). The backend lets every manager give advances, so drop `requires` if all managers should see it.
- **Payroll**: ✓ nav (`payroll.view`). The lock and mark-paid buttons follow `payroll.lock`.

**Stock**
- **Inventory, Transfers, Vendors**: ✓.
- **Purchase orders**: ✓ (`po.approve`).
- **Products**: ✓ (`product.manage`).

**Money**
- **Expenses**: ✓ (`expense.delete`).
- **Day-end**: ✓ (`dayEnd.reopen`).

**Marketing**
- **Campaigns, Automations**: gate "New campaign" and the automation switches with `whatsapp.campaigns`. Everyone else sees them read-only. The feature itself is a later phase.

**Insights**
- **Reports**: ✓. `src/pages/reports/reports-page.tsx:53` reads `fyStartMonth` from settings, which is owner only. Use `session.config.fyStartMonth`.
- **Audit log**: ✓ (`audit.export`).

**Settings**
- **Branches**: gate the edit buttons with `settings.branchEdit`. `src/pages/settings/branches-page.tsx:568` reads `headBranchId` from settings, which is owner only. Use `me.business.headBranchId`.
- **Branch logins tab**: show it to managers (own branches) with the "Can mark attendance" toggle (`branchLogin.flags`, §6). `src/hooks/use-user-names.ts:12` only loads branch logins for owners, so allow managers too.
- **Business, Users**: owner only (`route-tabs.tsx` `ownerOnly`). ✓ no change.

### Step 5 — How to test

1. Log in as `owner@glox.test`, open Users, and turn one flag on for `manager2@glox.test`.
2. Log in as `manager2@glox.test` (or refocus its tab). The button for that flag appears.
3. Turn the flag off again. The button disappears after the `/auth/me` refetch, and if the screen is still open, the backend returns `403 "Permission denied: missing … privilege"`.

---

## 10. Backend changes for the manager panel (2026-10-31)

| Area | Change |
| --- | --- |
| Session | `/auth/me` returns `config` (GST, FY start, effective discount limit, loyalty rules, payroll switches) and `business.headBranchId` for every salon role |
| Branch settings | New manager flag `editBranch`. Managers with it edit their own branches. Hours are validated: unique weekdays, times on open days, open before close (for the owner too) |
| Branch logins | Managers list and toggle `markAttendance` on their branches' logins (PRD §3) |
| Staff (**bug fix**) | Managers and branch logins could list, open and edit **other branches' staff**, their rosters and their leave. Now the list is limited to own branches (`?branchId=` of another → 403), and other-branch staff, rosters and leave → 404 |
| Catalogue (**bug fix**) | `PATCH /services/:id` let a manager change branch prices **without** `editBranchPrices`. Creating and editing categories, services and products is now owner only at the route (PRD: managers *view*); managers use `PATCH /services/:id/branch-prices` |
| Customers | Managers see full phone numbers and emails, in customer lists and profiles and in the appointment and voucher customer blocks; branch logins stay masked |
| Approvals (**bug fix**) | A manager could approve their own over-limit bill, so the discount limit meant nothing. Held bills now record `approval.requestedBy`, and that manager gets 403 on approving or rejecting it |
| Messages | The other-branch error is "You do not have access to this branch" everywhere |
| Owner-granted flags | Six new manager flags (§7): `manageCatalogue`, `manageCustomers`, `manageFinance`, `managePayroll`, `exportAudit`, `manageMarketing`. All are off by default. Each one opens the matching owner action at the route and in the service (`hasPermission()` in `permission.middleware.ts`), still limited to own branches where the data belongs to a branch. Marketing writes are now **flag-gated** (before, every manager could create campaigns, against the PRD) |
| Catalogue | Without `manageCatalogue`, catalogue writes stay owner only. With it, `PATCH /services/:id` takes every field |
| Test data | `manager2@glox.test` (TST1 + TST2, different flags) in `scripts/seed-sample-data.ts`. Re-running the seed no longer recalculates an existing payroll run |

**Tests:**
- [tests/integration/manager.test.ts](../tests/integration/manager.test.ts) has 16 tests: config, branch editing, branch logins, contacts, staff scope, cross-branch 403 and 404, view-only without flags, self-approval, and the six new flags (refused without, allowed with, own branch only, and `/auth/me` updating straight after the owner's change).
- A sweep of **122 manager calls** across every screen above found the staff and catalogue bugs; a code review of approvals found the self-approval gap. All three are fixed.
- Full suite: **670 of 716 passing**. The remaining 46 are the same later-phase items as before: Leads and WhatsApp, background workers, change polling, uploads, hardening and auth hardening. The "manager can only view campaigns" checks now pass.

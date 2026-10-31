# Glox Salon — Owner Panel APIs (Frontend Integration Guide)

The owner runs the whole salon: every branch, the team, the catalogue, staff, the front desk, money and reports. This guide grows phase by phase. Front-desk, stock and money endpoints are shared with managers and branch logins; each section shows who can do what. Every phase is fixed, tested and written up here with **real responses** before you integrate it.

| Phase | Your menu | Covers | Status |
| --- | --- | --- | --- |
| **1. Setup** | Settings · Catalogue → Services · Team | Session, settings, branches, managers and branch logins, catalogue, staff (roster, attendance, leave, advances) | ✅ Ready — §1–§10 |
| **2. Front desk** | Front desk (calendar, customers, bills, new bill, approvals) | Customers, calendar and appointments, billing, approvals, dues, invoice PDF | ✅ Ready — §11–§14 |
| **3. Plans · Stock · Money** | Catalogue → Plans · Stock · Money | Memberships, packages, wallet, vouchers, loyalty; products, vendors, stock, POs, transfers, audits; expenses, petty cash, day-end | ✅ Ready — §15–§17 (React: §18, changes: §19) |
| **4. Insights · Payroll** | Insights · Team → Payroll | Dashboard, 13 reports + Excel, audit log, payroll runs, payslip PDFs | ✅ Ready — §20–§25 |
| Later | Front desk → Leads, WhatsApp · Marketing | | Later |

Login, refresh, logout and the axios client are covered in [AUTH_API_GUIDE.md](AUTH_API_GUIDE.md). This guide builds on them.

---

## 0. Basics

- **Base URL:** `VITE_API_URL` (for example `http://localhost:4000`). There is no `/api/v1` prefix.
- **Auth:** every call needs `Authorization: Bearer <accessToken>` from an owner login.
- **Responses** are plain JSON (no `{ data }` wrapper). Errors are always `{ "error": { "code", "message", "fields?", "details?" } }`. For `VALIDATION_ERROR`, `fields` maps input paths (such as `"gst.gstin"` or `"weekly.0.end"`) to messages.
- **Units:**

| Kind | Format | Example |
| --- | --- | --- |
| Money | integer **paise** | `60000` = ₹600.00 |
| Percent | integer **basis points** | `1000` = 10 % |
| Business date | `YYYY-MM-DD`, IST | `"2026-10-29"` |
| Time of day | `HH:mm`, IST | `"10:00"` |
| Instant | ISO UTC | `"2026-10-29T04:30:00.000Z"` = 10:00 IST |
| Weekday | `0`–`6`, `0` = Sunday | |
| Phone | send any Indian format, stored as `+91XXXXXXXXXX` | `"98111 00007"` → `"+919811100007"` |

- **Common errors:**

| Status | `code` | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Bad body, query or id format (a malformed id in the URL is 400, not 500) |
| 401 | `UNAUTHENTICATED` / `SESSION_REVOKED` | Token expired or revoked; the auth client refreshes or logs out |
| 403 | `FORBIDDEN` | Not allowed for this role |
| 404 | `NOT_FOUND` | Not found, **or it belongs to another business** (including a `branchId` from another salon) |
| 409 | `DUPLICATE_EMAIL`, `CATEGORY_IN_USE`, `VERSION_CONFLICT` | Conflicts, explained per endpoint |

### Test data in Atlas

`scripts/seed-test-logins.ts` and then `scripts/seed-sample-data.ts` set up **Glox Test Salon**. Both are safe to re-run.

| Login | Password | Sees |
| --- | --- | --- |
| `owner@glox.test` | `Test@1234` | Everything |
| `manager@glox.test` | `Test@1234` | Branch TST1 |
| `branch@glox.test` | `Test@1234` | Branch TST1 (front desk) |
| `branch2@glox.test` | `Test@1234` | Branch TST2 (front desk) |

Sample data:
- **Branches:** TST1 "Test Branch" (the head branch) and TST2 "Adajan".
- **Categories:** Hair → Colour, Skin, Nails.
- **Services:** 6, with Haircut (Women) priced at ₹650 in TST2.
- **Staff:** 6 (TST1: Riya, the receptionist; Sameer, Tara and Neha. TST2: Kavya, the receptionist; Arjun).
- **Products:** 2, with opening stock.
- **Customers:** 6.

---

## 1. Screens → endpoints (Phase 1)

| Screen | Endpoints |
| --- | --- |
| App shell (business name, branch switcher) | `GET /auth/me` |
| Settings → Business | `GET /business/settings`, `PATCH /business/settings` |
| Settings → Branches | `GET /business/branches`, `PATCH /business/branches/:branchId`, `POST /business/branch-requests` |
| Team → Managers | `GET /business/managers`, `POST /business/managers`, `PATCH /business/managers/:id`, `POST /business/users/:id/password` |
| Team → Branch logins | `GET /business/branch-logins`, `PATCH /business/branch-logins/:id`, `POST /business/users/:id/password` |
| Catalogue → Categories | `GET /categories`, `POST /categories`, `PATCH /categories/:id`, `DELETE /categories/:id` |
| Catalogue → Services | `GET /services`, `GET /services/:id`, `POST /services`, `PATCH /services/:id`, `DELETE /services/:id`, `PATCH /services/:id/branch-prices` |
| Staff → Directory and profile | `GET /staff`, `GET /staff/:id`, `POST /staff`, `PATCH /staff/:id` |
| Staff → Roster | `GET /staff/:id/roster`, `PATCH /staff/:id/roster` |
| Staff → Attendance (per branch, per day) | `GET`/`POST /staff/branches/:branchId/attendance?date=` |
| Staff → Leave | `GET`/`POST /staff/branches/:branchId/leaves`, `PATCH /staff/leaves/:id/status` |
| Staff → Advances | `GET`/`POST /staff/branches/:branchId/advances` |
| (used by billing later) | `GET /staff/branches/:branchId/billed-by` |

Suggested build order: app shell → settings → branches → catalogue → staff → team.

---

## 2. Session: `GET /auth/me`

Call it after login and on reload. For salon logins it now also returns the **business** and the **branches the user can open**: all of them for an owner, only the assigned ones for a manager or branch login. The existing `user` block is unchanged.

**200** (owner)

```json
{
  "business": { "_id": "6ae2fcb94dc5ea6930b47a40", "name": "Glox Test Salon", "gst": { "enabled": false }, "status": "active", "headBranchId": "6ae2fcb94dc5ea6930b47a43" },
  "branches": [
    { "_id": "6ae2fcb94dc5ea6930b47a43", "name": "Test Branch", "code": "TST1", "status": "active" },
    { "_id": "6ae2fcc4d27d0ed7a1a0e260", "name": "Adajan", "code": "TST2", "status": "active" }
  ],
  "user": {
    "id": "6ae2fcb94dc5ea6930b47a4d", "name": "Test Owner", "email": "owner@glox.test", "role": "owner", "kind": "tenant",
    "businessId": "6ae2fcb94dc5ea6930b47a40", "branchIds": [],
    "flags": { "manageStaff": false, "approvePO": false, "viewPayroll": false, "editBranchPrices": false, "markAttendance": false }
  }
}
```

- An owner has `branchIds: []`, which means **all branches**; use `branches` for the switcher. `flags` don't apply to owners, who can do everything.
- **Branch switcher:** the owner picks a branch, or "All branches" where a screen supports it (reports later). Keep the selected `branchId` in app state and pass it to branch-scoped calls (`/staff/branches/:branchId/...`, `GET /services?branchId=`).
- `branches[].status` can be `active`, `deactivation_requested` or `deactivated`. Show deactivated branches greyed out.
- A Super Admin gets `business: null, branches: []`.

---

## 3. Business settings

### `GET /business/settings`

**200**

```json
{
  "_id": "6ae2fcb94dc5ea6930b47a40",
  "name": "Glox Test Salon",
  "address": { "line1": "12 MG Road", "city": "Surat", "state": "Gujarat", "pincode": "395007" },
  "gst": { "enabled": false, "rateBps": 1800, "sac": "9983", "pricesInclusive": false },
  "fyStartMonth": 4,
  "discountLimits": { "managerBps": 2000, "branchBps": 1000, "ownerAlertBps": 2500 },
  "dayEndReportTime": "23:00",
  "loyalty": { "enabled": false, "earnPer100": 1, "redeemValuePaise": 100, "minRedeem": 100, "expiryDays": 365 },
  "payroll": {
    "pf": { "enabled": false, "employeePct": 12, "wageCeilingPaise": 1500000 },
    "esi": { "enabled": false, "employeePct": 0.75, "wageCeilingPaise": 2100000 },
    "pt": { "enabled": false, "slabs": [] }
  },
  "automationGuards": { "quietStart": "21:00", "quietEnd": "09:00", "maxMarketingPerDay": 1 },
  "ownerWhatsappPhone": "+919800000001",
  "status": "active",
  "headBranchId": "6ae2fcb94dc5ea6930b47a43",
  "createdAt": "2026-10-29T07:58:49.863Z",
  "updatedAt": "2026-10-29T07:59:00.789Z"
}
```

| Field | Meaning |
| --- | --- |
| `gst` | `enabled` turns bills into tax invoices; `gstin` is required when enabled; `rateBps` (1800 = 18 %); `pricesInclusive`: service prices already include GST |
| `fyStartMonth` | 1–12 (4 = April); used for invoice numbering and reports |
| `discountLimits` | Highest bill discount a **manager** (`managerBps`) or **branch login** (`branchBps`) can give without approval; bigger discounts go to approval. `ownerAlertBps` is meant to alert the owner above that level ⚠️ stored, but not used yet (Phase 2, billing) |
| `dayEndReportTime` | `HH:mm` when the day-end report goes to `ownerWhatsappPhone` |
| `loyalty` | `earnPer100` points per ₹100; a point is worth `redeemValuePaise`; `minRedeem` points minimum; points expire after `expiryDays` |
| `payroll` | PF, ESI and PT apply only when `enabled` here, even if a staff member's own flag is on |
| `automationGuards` | No marketing WhatsApp between `quietStart` and `quietEnd`; at most `maxMarketingPerDay` per customer |

### `PATCH /business/settings`

**Send only what changed. Nested objects are merged**, so `{ "gst": { "rateBps": 500 } }` keeps `enabled`, `gstin` and the rest.

```json
{ "discountLimits": { "branchBps": 1500 }, "loyalty": { "enabled": true } }
```

**200**: the full settings object as above, with the new values (`discountLimits.branchBps: 1500`, `loyalty.enabled: true`, everything else unchanged). Each change is written to the audit log.

| Rule | Error |
| --- | --- |
| GST on without a GSTIN | `400 {"error":{"code":"VALIDATION_ERROR","message":"GSTIN is required when GST is enabled","fields":{"gst.gstin":"GSTIN is required when GST is enabled"}}}` |
| `dayEndReportTime`, `quietStart`, `quietEnd` | must be `HH:mm` |
| `fyStartMonth` | 1–12 |
| bps, paise and day values | non-negative integers (`expiryDays` ≥ 1) |
| `pt.slabs` | an array, **replaced** as a whole: `[{ "uptoPaise": 1500000, "amountPaise": 0 }, { "uptoPaise": 99999999, "amountPaise": 20000 }]` |

The owner can also edit `name`, `logoUrl` and `address` here. `status` (suspend) is Super Admin only.

---

## 4. Branches

### `GET /business/branches`

**200**: every branch, head branch first.

```json
[
  {
    "_id": "6ae2fcb94dc5ea6930b47a43", "name": "Test Branch", "code": "TST1", "invoicePrefix": "TST1", "phone": "+919800000002",
    "address": { "line1": "12 MG Road", "city": "Surat", "state": "Gujarat", "pincode": "395007" },
    "stations": 4, "pettyCashFloatPaise": 500000, "status": "active",
    "hours": [
      { "_id": "6ae2fcb94dc5ea6930b47a44", "day": 0, "open": "10:00", "close": "20:00", "closed": false },
      { "_id": "6ae2fcb94dc5ea6930b47a45", "day": 1, "open": "10:00", "close": "20:00", "closed": false }
    ],
    "holidays": [],
    "businessId": "6ae2fcb94dc5ea6930b47a40", "createdAt": "2026-10-29T07:58:49.873Z", "updatedAt": "2026-10-29T07:58:49.873Z"
  }
]
```

(`hours` always has 7 entries; shortened here.)

### `PATCH /business/branches/:branchId`

Owner-editable fields: `hours`, `holidays`, `stations`, `googleReviewUrl` and `pettyCashFloatPaise`. `hours` and `holidays` are **replaced** as whole arrays. Name, code, address and login belong to Super Admin.

```json
{
  "hours": [
    { "day": 0, "open": "10:00", "close": "21:00", "closed": false },
    { "day": 1, "open": "10:00", "close": "21:00", "closed": true },
    { "day": 2, "open": "10:00", "close": "21:00", "closed": false },
    { "day": 3, "open": "10:00", "close": "21:00", "closed": false },
    { "day": 4, "open": "10:00", "close": "21:00", "closed": false },
    { "day": 5, "open": "10:00", "close": "21:00", "closed": false },
    { "day": 6, "open": "10:00", "close": "21:00", "closed": false }
  ],
  "holidays": [{ "date": "2026-11-08", "name": "Diwali" }],
  "stations": 8
}
```

**200**: the branch with the new values. Appointments then follow these hours: a booking outside opening hours or on a holiday is rejected.

### `POST /business/branch-requests` — ask Super Admin to add or close a branch

Add a branch:

```json
{ "type": "add", "payload": { "name": "Piplod", "address": { "line1": "9 VIP Road", "city": "Surat", "state": "Gujarat", "pincode": "395007" } }, "reason": "Opening a third outlet" }
```

Close a branch:

```json
{ "type": "delete", "branchId": "6ae2fcc4d27d0ed7a1a0e260", "reason": "Lease ended" }
```

**201**

```json
{ "_id": "6ae2fcee10dd55c52125be1a", "type": "add", "payload": { "name": "Piplod", "address": { "line1": "9 VIP Road", "city": "Surat", "state": "Gujarat", "pincode": "395007" } }, "reason": "Opening a third outlet", "status": "pending", "businessId": "6ae2fcb94dc5ea6930b47a40", "createdAt": "2026-10-29T07:59:42.555Z" }
```

- A `delete` request sets the branch to `deactivation_requested` until Super Admin decides. If they reject it, the branch goes back to `active`.
- The head branch can't be requested for deletion (`403`).

---

## 5. Team

### Managers

A manager works in their **assigned branches** only. Permission flags:

| Flag | Lets the manager… |
| --- | --- |
| `manageStaff` | add and edit staff in their branches |
| `approvePO` | approve purchase orders (Phase 3) |
| `viewPayroll` | see payroll (Phase 3) |
| `editBranchPrices` | change service prices for their branches |
| `maxDiscountBps` | optional personal discount cap ⚠️ stored, but billing still uses `discountLimits.managerBps`. Wired up in Phase 2 |

#### `GET /business/managers`

**200**

```json
[
  {
    "_id": "6ae2fcb94dc5ea6930b47a51", "role": "manager", "name": "Test Manager", "email": "manager@glox.test",
    "branchIds": ["6ae2fcb94dc5ea6930b47a43"],
    "flags": { "manageStaff": true, "approvePO": true, "viewPayroll": true, "editBranchPrices": true, "markAttendance": false },
    "status": "active", "sessionVersion": 0, "failedLogins": 0, "businessId": "6ae2fcb94dc5ea6930b47a40",
    "createdAt": "2026-10-29T07:58:49.894Z", "updatedAt": "2026-10-29T07:58:49.894Z"
  }
]
```

#### `POST /business/managers`

```json
{
  "name": "Ravi Verma", "email": "ravi@glox.test", "phone": "9800000044", "password": "Manager@123",
  "branchIds": ["6ae2fcc4d27d0ed7a1a0e260"],
  "flags": { "manageStaff": true, "approvePO": true, "viewPayroll": false, "editBranchPrices": false, "maxDiscountBps": 1500 }
}
```

**201**: the manager, with no password hash. The phone is stored as `+919800000044`.

```json
{
  "_id": "6ae2fcee10dd55c52125be23", "role": "manager", "name": "Ravi Verma", "email": "ravi@glox.test",
  "branchIds": ["6ae2fcc4d27d0ed7a1a0e260"],
  "flags": { "manageStaff": true, "approvePO": true, "viewPayroll": false, "editBranchPrices": false, "maxDiscountBps": 1500, "markAttendance": false },
  "status": "active", "businessId": "6ae2fcb94dc5ea6930b47a40", "createdAt": "2026-10-29T07:59:42.729Z"
}
```

| Rule | Error |
| --- | --- |
| Password 8+ characters | 400 |
| At least one branch, all from this business | 400 if the list is empty; 404 if a branch belongs to another business |
| Email unused by any login on the platform | `409 {"error":{"code":"DUPLICATE_EMAIL","message":"Email ravi@glox.test is already in use"}}` |

#### `PATCH /business/managers/:id`

Any of `branchIds`, `flags` (merged with the current flags), `status` (`active`/`inactive`) or `staffId` (links the manager to their staff record).

```json
{ "branchIds": ["6ae2fcb94dc5ea6930b47a43", "6ae2fcc4d27d0ed7a1a0e260"], "flags": { "editBranchPrices": true } }
```

**200**: the updated manager, with no hash.

- **Changing branches or setting `inactive` logs the manager out immediately**: their next request returns `401 SESSION_REVOKED`.
- Flag changes apply on their next request without logging them out.

### Branch logins

One shared login per branch for the reception desk. Super Admin creates them; the owner only toggles `markAttendance`, which lets that front desk mark staff attendance.

#### `GET /business/branch-logins`

**200**

```json
[
  {
    "_id": "6ae2fcb94dc5ea6930b47a55", "role": "branch", "name": "Test Branch Login", "email": "branch@glox.test",
    "branchIds": ["6ae2fcb94dc5ea6930b47a43"], "branchLoginFor": "6ae2fcb94dc5ea6930b47a43",
    "flags": { "markAttendance": false, "manageStaff": false, "approvePO": false, "viewPayroll": false, "editBranchPrices": false },
    "status": "active", "businessId": "6ae2fcb94dc5ea6930b47a40"
  }
]
```

#### `PATCH /business/branch-logins/:id`

```json
{ "markAttendance": true }
```

**200**: the branch login (no hash) with `flags.markAttendance: true`. Any other body → `400`.

### `POST /business/users/:id/password` — set a manager's or branch login's password *(new)*

```json
{ "password": "Manager@456" }
```

**204** (empty body). All of that user's sessions end; share the new password with them.

| Case | Error |
| --- | --- |
| 8–64 characters with a letter and a number | `400` with `fields.password` |
| The owner's own id | `403 {"error":{"code":"FORBIDDEN","message":"Owner cannot set own password through this endpoint"}}` |
| A user of another business | `404` |

---

## 6. Catalogue

### Categories (at most two levels: category → sub-category)

#### `GET /categories?active=true|false`

**200**, sorted by `order` then name. Sub-categories have `parentId`; build the tree on the client.

```json
[
  { "_id": "6ae2fcc4d27d0ed7a1a0e275", "name": "Colour", "parentId": "6ae2fcc4d27d0ed7a1a0e26f", "gender": "unisex", "order": 1, "active": true },
  { "_id": "6ae2fcc4d27d0ed7a1a0e26f", "name": "Hair", "gender": "unisex", "order": 1, "active": true },
  { "_id": "6ae2fcc4d27d0ed7a1a0e27a", "name": "Skin", "gender": "unisex", "order": 2, "active": true },
  { "_id": "6ae2fcc5d27d0ed7a1a0e27f", "name": "Nails", "gender": "women", "order": 3, "active": true }
]
```

#### `POST /categories`

```json
{ "name": "Bridal", "gender": "women", "order": 4 }
```

Add `"parentId": "<top-level category id>"` to create a sub-category. `gender` is `men`, `women` or `unisex`.

**201**

```json
{ "_id": "6ae2fcef10dd55c52125be45", "name": "Bridal", "gender": "women", "order": 4, "active": true, "businessId": "6ae2fcb94dc5ea6930b47a40", "createdAt": "2026-10-29T07:59:43.110Z" }
```

A third level → `400 {"error":{"code":"VALIDATION_ERROR","message":"Maximum 2 levels of categories allowed"}}`.

#### `PATCH /categories/:id`

```json
{ "name": "Bridal & Party", "order": 5 }
```

Also accepts `gender`, `active`, and `parentId` (a top-level id, or `null` to make it top-level). Moving a category that has sub-categories under another one → `400` (it would make three levels).

#### `DELETE /categories/:id`

Deactivates the category (soft delete). **200**: the category with `"active": false`.

While active services or active sub-categories still use it:

```json
{ "error": { "code": "CATEGORY_IN_USE", "message": "Move or deactivate its services and sub-categories first", "details": { "services": 3, "subCategories": 1 } } }
```

(409). Show the counts from `details`.

### Services

#### `GET /services?branchId=&categoryId=&search=&active=`

| Query | Effect |
| --- | --- |
| `branchId` | Computes that branch's `effectivePricePaise` and `branchActive`. Without it, `effectivePricePaise` is the base price |
| `categoryId` | One category |
| `search` | Case-insensitive "contains" search on the name, matched as plain text |
| `active` | `true` or `false`; omit for all |

**200**, sorted by name:

```json
[
  {
    "_id": "6ae2fcc5d27d0ed7a1a0e2ab", "categoryId": "6ae2fcc4d27d0ed7a1a0e26f", "name": "Haircut (Women)", "gender": "women",
    "basePricePaise": 60000, "durationMin": 45, "rebookDays": 45,
    "branchPrices": [{ "_id": "6ae2fcc5d27d0ed7a1a0e2d1", "branchId": "6ae2fcc4d27d0ed7a1a0e260", "pricePaise": 65000, "active": true }],
    "consumables": [], "eligibleStaffIds": [],
    "commission": { "type": "pct", "value": 1000, "slabs": [] },
    "active": true, "businessId": "6ae2fcb94dc5ea6930b47a40",
    "effectivePricePaise": 65000, "branchActive": true
  }
]
```

Show `effectivePricePaise` in branch views. `branchActive: false` means the service is hidden in that branch.

#### `GET /services/:id?branchId=`

**200**: one service, in the same shape.

#### `POST /services`

```json
{
  "categoryId": "6ae2fcc4d27d0ed7a1a0e26f",
  "name": "Keratin Treatment",
  "gender": "unisex",
  "basePricePaise": 450000,
  "durationMin": 150,
  "rebookDays": 120,
  "commission": { "type": "fixed", "value": 30000 },
  "eligibleStaffIds": ["6ae2fcc5d27d0ed7a1a0e2e6"],
  "consumables": [{ "productId": "<consumable product id>", "qty": 30 }],
  "branchPrices": [{ "branchId": "6ae2fcc4d27d0ed7a1a0e260", "pricePaise": 500000, "active": true }]
}
```

| Field | Rule |
| --- | --- |
| `basePricePaise` | integer ≥ 0 |
| `durationMin` | 5–480 |
| `rebookDays` | 1–365; used for "due for a visit" reminders later |
| `commission` | optional; overrides the staff member's own rate for this service. `pct` uses `value` in bps; `fixed` uses `value` in paise per service; `slab` uses `slabs: [{ uptoPaise, bps }]` |
| `consumables` | product used per service, in its `useUnit` (e.g. 30 ml). Deducted from branch stock when billed |
| `eligibleStaffIds` | who may perform it; empty = anyone |
| ids | category, products, staff and branches must all belong to this business → otherwise 404 |

**201**: the service. Validation errors list each field:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Validation failed", "fields": { "basePricePaise": "Number must be greater than or equal to 0", "durationMin": "Number must be greater than or equal to 5" } } }
```

#### `PATCH /services/:id`

Send only the fields that change, for example `{ "basePricePaise": 480000 }`. **200**: the updated service.

⚠️ `branchPrices`, `consumables` and `eligibleStaffIds` **replace** the whole list when sent. To change a single branch's price, use the endpoint below.

#### `PATCH /services/:id/branch-prices` — one branch's price or visibility

| Body | Effect |
| --- | --- |
| `{ "branchId": "…", "pricePaise": 500000 }` | Set that branch's price |
| `{ "branchId": "…", "active": false }` | Hide the service in that branch (price unchanged) |
| `{ "branchId": "…", "pricePaise": null }` | Remove the override; the base price applies again |

**200**: the service with its `branchPrices`:

```json
"branchPrices": [
  { "_id": "6ae2fcef10dd55c52125be73", "branchId": "6ae2fcc4d27d0ed7a1a0e260", "pricePaise": 500000, "active": true },
  { "_id": "6ae2fcef10dd55c52125be7b", "branchId": "6ae2fcb94dc5ea6930b47a43", "active": false }
]
```

- The body must contain `pricePaise` or `active`; otherwise `400`.
- A branch of another business → `404`.
- Each change is written to the audit log (`service.branch_price_update`).

#### `DELETE /services/:id`

Deactivates the service (`active: false`). **200**: the service. Past bills keep it. An unknown id → `404`.

---

## 7. Staff

### Directory and profile

#### `GET /staff?branchId=&status=&designation=&q=`

`status` is `active` or `exited`. `designation` is one of `stylist`, `senior_stylist`, `beautician`, `receptionist`, `manager`, `helper` or `other`. `q` matches the name or phone. **200**, sorted by name:

```json
[
  {
    "_id": "6ae2fcc5d27d0ed7a1a0e2d7", "branchId": "6ae2fcb94dc5ea6930b47a43", "name": "Riya Mehta", "phone": "+919811100001",
    "designation": "receptionist", "joiningDate": "2026-04-01", "serviceIds": [], "documents": [], "status": "active",
    "salary": { "type": "monthly", "amountPaise": 1800000 },
    "commission": { "service": { "slabs": [] } },
    "statutory": { "pf": false, "esi": false, "pt": false },
    "businessId": "6ae2fcb94dc5ea6930b47a40", "createdAt": "2026-10-29T07:59:01.166Z"
  }
]
```

#### `POST /staff`

```json
{
  "branchId": "6ae2fcb94dc5ea6930b47a43",
  "name": "Pooja Rao",
  "phone": "98111 00007",
  "designation": "stylist",
  "joiningDate": "2026-10-01",
  "salary": { "type": "monthly", "amountPaise": 2400000 },
  "commission": { "service": { "type": "pct", "value": 1000 }, "productBps": 500, "overtimePerHourPaise": 10000 },
  "statutory": { "pf": false, "esi": false, "pt": true },
  "bankRef": { "bank": "HDFC", "last4": "4321" },
  "emergencyContact": { "name": "Raj Rao", "phone": "9822200001" }
}
```

| Field | Rule |
| --- | --- |
| `salary.type` | `monthly` or `none` (commission only) |
| `commission.service` | the default service commission, same rule shape as on services. `productBps` is commission on retail product sales. `overtimePerHourPaise` is the overtime rate |
| `statutory` | this person's PF, ESI and PT; they only apply if switched on in business settings |
| `bankRef.last4` | exactly 4 digits. Full account numbers are never stored |
| `serviceIds` | services they perform; must be this business's |
| `branchId` | must be this business's branch → otherwise 404 |

**201**: the staff record, with the phone stored as `+919811100007`. A default roster (every day 10:00–20:00) is created automatically.

#### `GET /staff/:id`, `PATCH /staff/:id`

`PATCH` accepts any field from create, plus `exitDate` and `exitReason`.

- **Promote:** `{ "designation": "senior_stylist", "salary": { "type": "monthly", "amountPaise": 2800000 } }`.
- **Transfer:** `{ "branchId": "<other branch>" }`. Their roster moves with them.
- **Exit:** `{ "status": "exited", "exitDate": "2026-10-31", "exitReason": "Moved city" }`. The record is kept for history.

### Roster

#### `GET /staff/:id/roster`

**200**

```json
{
  "_id": "6ae2fcef10dd55c52125be8d", "staffId": "6ae2fcef10dd55c52125be8b", "branchId": "6ae2fcb94dc5ea6930b47a43",
  "weekly": [
    { "day": 0, "start": "10:00", "end": "20:00", "off": false },
    { "day": 1, "start": "10:00", "end": "20:00", "off": false }
  ],
  "overrides": []
}
```

#### `PATCH /staff/:id/roster`

Replaces the weekly template and the overrides (date-specific changes).

```json
{
  "weekly": [
    { "day": 0, "start": "10:00", "end": "19:00", "off": false },
    { "day": 1, "start": "10:00", "end": "19:00", "off": false },
    { "day": 2, "off": true },
    { "day": 3, "start": "10:00", "end": "19:00", "off": false },
    { "day": 4, "start": "10:00", "end": "19:00", "off": false },
    { "day": 5, "start": "10:00", "end": "19:00", "off": false },
    { "day": 6, "start": "10:00", "end": "19:00", "off": false }
  ],
  "overrides": [{ "date": "2026-11-08", "off": true }]
}
```

- **Rules:** a working slot needs `start` < `end`; an `off` slot needs no times; each weekday may appear only once.
- **Error example:** `400 {"error":{"code":"VALIDATION_ERROR","message":"Validation failed","fields":{"weekly.0.end":"end must be after start"}}}`.
- **Used for:** appointment slots and **overtime**. Overtime is worked minutes beyond the rostered shift for that day; on a rostered day off, every worked minute counts.

### Attendance (one branch, one day)

#### `GET /staff/branches/:branchId/attendance?date=2026-10-29`

`date` defaults to **today in IST**. **200**: one row per active staff member of the branch. `attendance` is `null` when not yet marked.

```json
[
  { "staff": { "_id": "6ae2fcc5d27d0ed7a1a0e2d7", "name": "Riya Mehta", "designation": "receptionist", "...": "..." }, "attendance": null },
  {
    "staff": { "_id": "6ae2fcc5d27d0ed7a1a0e2e6", "name": "Sameer Khan", "designation": "senior_stylist", "...": "..." },
    "attendance": {
      "_id": "6ae2fcef10dd55c52125bed5", "staffId": "6ae2fcc5d27d0ed7a1a0e2e6", "businessDate": "2026-10-29",
      "status": "late", "inAt": "2026-10-29T05:15:00.000Z", "overtimeMin": 0, "note": "Traffic", "edits": []
    }
  }
]
```

#### `POST /staff/branches/:branchId/attendance?date=2026-10-29`

Mark one or many staff at once. Marking someone again the same day updates their record rather than adding a second one.

```json
{
  "entries": [
    { "staffId": "6ae2fcef10dd55c52125be8b", "status": "present", "inAt": "2026-10-29T04:30:00.000Z", "outAt": "2026-10-29T14:30:00.000Z" },
    { "staffId": "6ae2fcc5d27d0ed7a1a0e2e6", "status": "late", "inAt": "2026-10-29T05:15:00.000Z", "note": "Traffic" }
  ]
}
```

`status` is one of `present`, `late`, `half_day`, `absent`, `leave`, `week_off` or `holiday` (default `present`).

**200**: the saved records. Pooja is rostered 10:00–19:00 and worked 10:00–20:00 IST, so she gets `overtimeMin: 60`:

```json
[
  { "_id": "6ae2fcef10dd55c52125bed2", "staffId": "6ae2fcef10dd55c52125be8b", "branchId": "6ae2fcb94dc5ea6930b47a43", "businessDate": "2026-10-29", "status": "present", "inAt": "2026-10-29T04:30:00.000Z", "outAt": "2026-10-29T14:30:00.000Z", "overtimeMin": 60, "edits": [] },
  { "_id": "6ae2fcef10dd55c52125bed5", "staffId": "6ae2fcc5d27d0ed7a1a0e2e6", "branchId": "6ae2fcb94dc5ea6930b47a43", "businessDate": "2026-10-29", "status": "late", "inAt": "2026-10-29T05:15:00.000Z", "overtimeMin": 0, "note": "Traffic", "edits": [] }
]
```

| Rule | Error |
| --- | --- |
| A **past date** needs `"reason"` in the body; it's stored in the record's `edits` | `400 "A reason is mandatory when modifying attendance records for past dates"` |
| Every `staffId` must be staff of **this branch** | `404 "One or more staff members are not in this branch"` |
| `outAt` after `inAt` | `400` with `fields.outAt` |

Build `inAt`/`outAt` from the date and an IST time: `new Date(\`${date}T${time}:00+05:30\`).toISOString()`.

### Leave

#### `POST /staff/branches/:branchId/leaves`

```json
{ "staffId": "6ae2fcef10dd55c52125be8b", "from": "2026-11-10", "to": "2026-11-12", "type": "paid", "reason": "Family function" }
```

**201**: the leave. When the owner or a manager records it, it's **approved straight away**, and it blocks appointments for that staff member on those days.

```json
{ "_id": "6ae2fcef10dd55c52125bee2", "staffId": "6ae2fcef10dd55c52125be8b", "branchId": "6ae2fcb94dc5ea6930b47a43", "from": "2026-11-10", "to": "2026-11-12", "type": "paid", "status": "approved", "reason": "Family function" }
```

- `type` is `paid` or `unpaid`.
- `to` before `from` → `400`.
- The staff member must be in this branch → `404`.
- Branch logins can view leave but not create it (`403`).

#### `GET /staff/branches/:branchId/leaves?staffId=&status=`

**200**, newest `from` first. `staffId` is expanded:

```json
[
  { "_id": "6ae2fcef10dd55c52125bee2", "staffId": { "_id": "6ae2fcef10dd55c52125be8b", "name": "Pooja Rao", "phone": "+919811100007", "designation": "senior_stylist" }, "from": "2026-11-10", "to": "2026-11-12", "type": "paid", "status": "rejected", "reason": "Family function" }
]
```

#### `PATCH /staff/leaves/:id/status`

```json
{ "status": "rejected" }
```

`status` is `approved` or `rejected`. **200**: the leave.

### Salary advances

#### `POST /staff/branches/:branchId/advances`

```json
{ "staffId": "6ae2fcef10dd55c52125be8b", "amountPaise": 500000, "date": "2026-10-29", "recoveryPerMonthPaise": 250000, "payFromTill": true }
```

**201**

```json
{ "_id": "6ae2fcef10dd55c52125bef3", "staffId": "6ae2fcef10dd55c52125be8b", "branchId": "6ae2fcb94dc5ea6930b47a43", "amountPaise": 500000, "date": "2026-10-29", "recoveryPerMonthPaise": 250000, "recoveredPaise": 0, "expenseId": "6ae2fcef10dd55c52125bef1", "status": "open" }
```

- `payFromTill: true` also records a cash **till expense** (`salary_advance`) for that day, so day-end cash matches. `expenseId` points to it.
- Payroll deducts up to `recoveryPerMonthPaise` each month until the advance is recovered (documented in Phase 3).
- The staff member must be in this branch → otherwise `404`.

#### `GET /staff/branches/:branchId/advances?staffId=&status=open|closed`

**200**, newest first, with `staffId` expanded as for leaves.

### `GET /staff/branches/:branchId/billed-by`

The branch's active **receptionists**, for the "Billed by" dropdown on bills (Phase 2):

```json
[{ "_id": "6ae2fcc5d27d0ed7a1a0e2d7", "name": "Riya Mehta", "phone": "+919811100001", "designation": "receptionist" }]
```

---

## 8. React integration

This uses the `api` axios client and `AuthProvider` from [AUTH_API_GUIDE.md §6](AUTH_API_GUIDE.md#6-integrating-in-react).

### 8.1 Money, percent and time helpers

```ts
export const rupees = (paise: number) =>
  (paise / 100).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
export const toPaise = (rupeesValue: number) => Math.round(rupeesValue * 100);
export const bpsToPercent = (bps: number) => bps / 100;
export const percentToBps = (pct: number) => Math.round(pct * 100);

/** "2026-10-29" + "10:00" (IST) → ISO instant for inAt/outAt */
export const istInstant = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`).toISOString();
/** ISO instant → "10:00" IST */
export const istTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
/** Today's business date in IST */
export const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
```

### 8.2 Branch context

```tsx
import { createContext, useContext, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './client';

type BranchLite = { _id: string; name: string; code: string; status: string };
type Me = { business: { _id: string; name: string; headBranchId?: string } | null; branches: BranchLite[]; user: any };

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me').then((r) => r.data) });

const BranchCtx = createContext<{ branchId: string | null; setBranchId: (id: string) => void }>(null!);

export function BranchProvider({ children }: { children: ReactNode }) {
  const { data } = useMe();
  const [picked, setPicked] = useState<string | null>(() => localStorage.getItem('branchId'));
  const valid = data?.branches.some((b) => b._id === picked);
  const branchId = valid ? picked : data?.business?.headBranchId ?? data?.branches[0]?._id ?? null;
  const setBranchId = (id: string) => { localStorage.setItem('branchId', id); setPicked(id); };
  return <BranchCtx.Provider value={{ branchId, setBranchId }}>{children}</BranchCtx.Provider>;
}
export const useBranch = () => useContext(BranchCtx);
```

Include `branchId` in query keys so that switching branches refetches: `['attendance', branchId, date]`.

### 8.3 API module: `src/api/owner.ts` (Phase 1)

```ts
import { api } from './client';

const get = <T,>(url: string, params?: object) => api.get<T>(url, { params }).then((r) => r.data);
const post = <T,>(url: string, body?: unknown) => api.post<T>(url, body).then((r) => r.data);
const patch = <T,>(url: string, body?: unknown) => api.patch<T>(url, body).then((r) => r.data);
const del = <T,>(url: string) => api.delete<T>(url).then((r) => r.data);

export const ownerApi = {
  // settings & branches
  settings: () => get('/business/settings'),
  updateSettings: (patchBody: object) => patch('/business/settings', patchBody),
  branches: () => get('/business/branches'),
  updateBranch: (id: string, body: object) => patch(`/business/branches/${id}`, body),
  requestBranch: (body: object) => post('/business/branch-requests', body),

  // team
  managers: () => get('/business/managers'),
  createManager: (body: object) => post('/business/managers', body),
  updateManager: (id: string, body: object) => patch(`/business/managers/${id}`, body),
  branchLogins: () => get('/business/branch-logins'),
  setMarkAttendance: (id: string, markAttendance: boolean) => patch(`/business/branch-logins/${id}`, { markAttendance }),
  setPassword: (userId: string, password: string) => api.post(`/business/users/${userId}/password`, { password }),

  // catalogue
  categories: (active?: boolean) => get('/categories', { active }),
  createCategory: (body: object) => post('/categories', body),
  updateCategory: (id: string, body: object) => patch(`/categories/${id}`, body),
  deleteCategory: (id: string) => del(`/categories/${id}`),
  services: (params: { branchId?: string; categoryId?: string; search?: string; active?: boolean }) => get('/services', params),
  service: (id: string, branchId?: string) => get(`/services/${id}`, { branchId }),
  createService: (body: object) => post('/services', body),
  updateService: (id: string, body: object) => patch(`/services/${id}`, body),
  deleteService: (id: string) => del(`/services/${id}`),
  setBranchPrice: (id: string, body: { branchId: string; pricePaise?: number | null; active?: boolean }) =>
    patch(`/services/${id}/branch-prices`, body),

  // staff
  staff: (params: { branchId?: string; status?: 'active' | 'exited'; designation?: string; q?: string }) => get('/staff', params),
  staffMember: (id: string) => get(`/staff/${id}`),
  createStaff: (body: object) => post('/staff', body),
  updateStaff: (id: string, body: object) => patch(`/staff/${id}`, body),
  roster: (id: string) => get(`/staff/${id}/roster`),
  saveRoster: (id: string, body: object) => patch(`/staff/${id}/roster`, body),
  attendance: (branchId: string, date?: string) => get(`/staff/branches/${branchId}/attendance`, { date }),
  markAttendance: (branchId: string, date: string, body: { entries: object[]; reason?: string }) =>
    api.post(`/staff/branches/${branchId}/attendance`, body, { params: { date } }).then((r) => r.data),
  leaves: (branchId: string, params?: object) => get(`/staff/branches/${branchId}/leaves`, params),
  createLeave: (branchId: string, body: object) => post(`/staff/branches/${branchId}/leaves`, body),
  setLeaveStatus: (id: string, status: 'approved' | 'rejected') => patch(`/staff/leaves/${id}/status`, { status }),
  advances: (branchId: string, params?: object) => get(`/staff/branches/${branchId}/advances`, params),
  createAdvance: (branchId: string, body: object) => post(`/staff/branches/${branchId}/advances`, body),
  billedBy: (branchId: string) => get(`/staff/branches/${branchId}/billed-by`),
};
```

### 8.4 Settings form: send only the changed fields

react-hook-form tracks `dirtyFields`. Build the PATCH body from them, so untouched nested fields aren't sent. The server merges nested objects anyway.

```ts
function dirtyValues(dirty: any, values: any): any {
  if (dirty === true) return values;
  if (Array.isArray(dirty)) return values; // arrays (pt.slabs, hours) are sent whole
  return Object.fromEntries(Object.keys(dirty).map((k) => [k, dirtyValues(dirty[k], values[k])]));
}
// onSubmit: ownerApi.updateSettings(dirtyValues(form.formState.dirtyFields, form.getValues()))
```

Edit percentages and rupees in the form, and convert them with `percentToBps` and `toPaise` before sending, as the onboarding wizard does.

### 8.5 Attendance sheet

1. `GET .../attendance?date=` gives one row per staff member.
2. Show the status, in/out time pickers (IST) and a note.
3. Save all rows in one `POST` with `entries`.
4. For a past date, ask for a reason and send it as `reason`.
5. Show `overtimeMin` as hours and minutes.

### 8.6 Cache invalidation

| After | Invalidate |
| --- | --- |
| settings update | `['settings']`, `['me']` |
| branch update or request | `['branches']`, `['me']` |
| manager / branch-login change | `['managers']` / `['branch-logins']` |
| category change | `['categories']`, `['services']` |
| service or branch price change | `['services']` |
| staff create / update | `['staff']`, `['billed-by', branchId]`, `['attendance', branchId]` |
| roster save | `['roster', staffId]` |
| leave / advance | `['leaves', branchId]` / `['advances', branchId]` |

---

## 9. Not covered yet

| Item | Where |
| --- | --- |
| Leads, WhatsApp inbox, campaigns and automations | Later |
| Background jobs (reminders, recurring expenses, auto day-close), change polling (`GET /changes`), file uploads | Later (workers phase) |
| Leads-conversion and WhatsApp-spend reports, sending payslips on WhatsApp | With Leads / WhatsApp |
| Bulk price change by category, reorder categories in one call | No route yet; added on request (use `PATCH /services/:id` / `PATCH /categories/:id`) |

---

## 10. Backend changes made for Phase 1 (2026-10-29)

| Change | Where |
| --- | --- |
| `/auth/me` returns `business` and accessible `branches` | `controllers/auth.controller.ts` |
| Owner branch access checks that the branch belongs to the owner's business (another salon's branch → 404); a malformed `branchId` → 400 | `middlewares/branch.middleware.ts` |
| Malformed ids anywhere → 400 instead of 500 | `middlewares/errorHandler.ts` |
| `.populate()` no longer crashes with `TENANT_SCOPE_MISSING` (leave and advance lists 500'd; this also fixes other lists app-wide) | `models/plugins/tenantScope.plugin.ts` |
| Settings: nested objects merged, all fields optional; GSTIN required when GST is on; time fields validated | `services/business.service.ts`, `validations/business.schema.ts` |
| Managers: branches must belong to the business; phone normalised; no `passwordHash` in responses; sessions revoked only on a branch or status change | `business.service.ts` |
| Branch logins: body is `{ markAttendance }` (validated) | `business.controller.ts`, `routes/business.routes.ts` |
| New `POST /business/users/:id/password` | `business.routes.ts`, `business.controller.ts` |
| Categories: delete blocked while in use (`CATEGORY_IN_USE`), returns the category, audited; the two-level rule also applies on move | `services/catalogue.service.ts` |
| Services: delete returns the service and is audited (404 if unknown); search is plain text; `?active=`; referenced category, branch, product and staff ids must belong to the business | `catalogue.service.ts`, `validations/catalogue.schema.ts` |
| Branch prices: validated body (`pricePaise` ≥ 0 or `null`, `active`), branch ownership and manager branch checks, audited | `catalogue.service.ts`, `routes/catalogue.routes.ts` |
| Staff: branch and service ids checked; a transfer moves the roster; `?q=` search; billed-by lists receptionists only | `services/staff.service.ts` |
| Roster: start < end, times required on working days, no repeated weekday | `validations/staff.schema.ts` |
| Attendance: staff must be in the branch; clock-out after clock-in; overtime measured against the roster; default date is today in IST | `staff.service.ts`, `controllers/staff.controller.ts` |
| Leave and advance: staff must be in the URL's branch; leave `to` ≥ `from`; branch logins can't create leave | `staff.service.ts`, `routes/staff.routes.ts` |
| Ids in URLs and list queries validated | `routes/catalogue.routes.ts`, `routes/staff.routes.ts`, `routes/business.routes.ts` |

Tests: [tests/integration/owner.setup.test.ts](../tests/integration/owner.setup.test.ts) has 25 new tests, and 21 earlier spec tests for these screens now pass. Run them with `npx jest tests/integration/owner.setup`.

---

# Part 2: Front desk (Phase 2)

Customers, the calendar, billing and approvals. These endpoints are **shared by all three salon roles**. Each section says what the owner, a manager and a branch login can do, so the manager and branch panels reuse the same calls.

## 11. Who can do what (Phase 2)

| Action | Owner | Manager | Branch login |
| --- | --- | --- | --- |
| Customers: list, view, create, edit, add notes | ✅ all | ✅ | ✅ |
| Customer phone and email in responses | Full | Masked (`98XXXXXX01`) | Masked |
| Reveal a phone (`POST /customers/:id/reveal`) | ✅ | ✅ audited | ✅ audited |
| Merge duplicates | ✅ | ✅ | ❌ |
| Export to Excel | ✅ | ❌ | ❌ |
| Calendar, booking, walk-in, reschedule, status, staff blocks | ✅ every branch | ✅ own branches | ✅ own branch |
| Create a bill | ✅ | ✅ | ✅ (`billedByStaffId` required) |
| Discount without approval | Unlimited | Up to `flags.maxDiscountBps`, else `discountLimits.managerBps` | Up to `discountLimits.branchBps` |
| Part-paid bill (a due) without approval | ✅ | Needs approval | Needs approval |
| Approve or reject held bills | ✅ every branch | ✅ own branches | ❌ |
| Edit, cancel, refund a bill | ✅ (also on a closed day) | ✅ own branches, not on a closed day | ❌ |
| Collect dues | ✅ | ✅ | ✅ |

A bill, appointment or block of a branch you can't access is a **404**, the same as one that doesn't exist.

---

## 12. Customers

### `GET /customers?q=&tags=&segment=&lastVisitFrom=&lastVisitTo=&page=&limit=`

| Query | Effect |
| --- | --- |
| `q` | 4+ digits search phone and alternate phones; anything else is a case-insensitive name search (plain text) |
| `tags` | `vip` or `vip,bridal`: customers with any of these tags |
| `segment` | `new` (1 visit), `regular` (3+ visits), `lapsed` (no visit in 60+ days) |
| `lastVisitFrom`, `lastVisitTo` | `YYYY-MM-DD` |
| `page`, `limit` | `limit` 1–100, default 25 |

**200** (as a branch login sees it, with masked contacts), most recently updated first:

```json
{
  "customers": [
    {
      "_id": "6ae3157ff1687a9fa505136a", "name": "Priya Shah", "phone": "98XXXXXX01", "altPhones": [], "email": "",
      "gender": "female", "dob": "1994-03-12", "source": "walk_in", "tags": ["vip"], "waOptIn": true, "doNotMessage": false,
      "stats": { "visits": 1, "spendPaise": 260000, "noShows": 0, "firstVisit": "2026-10-29", "lastVisit": "2026-10-29" },
      "walletBalancePaise": 0, "loyaltyPoints": 0, "duePaise": 0, "createdAt": "2026-10-29T09:44:31.209Z"
    }
  ],
  "total": 1
}
```

### `POST /customers`

```json
{
  "name": "Kiran Rao", "phone": "98765 00099", "altPhones": ["98765 00098"],
  "gender": "female", "dob": "1992-08-15", "anniversary": "2018-12-02",
  "tags": ["bridal"], "source": "referral", "notes": "Prefers weekends"
}
```

| Field | Rule |
| --- | --- |
| `phone`, `altPhones[]` | Indian mobile in any format, stored as `+91…`; up to 3 alternate phones. Not a phone number → `400` |
| `gender` | `male`, `female` or `other` |
| `dob`, `anniversary` | real calendar dates (`2026-02-30` → 400); `dob` not in the future |
| `source` | `walk_in` (default), `phone`, `whatsapp` or `referral`; `referredBy` is a customer id |
| `waOptIn`, `doNotMessage` | WhatsApp consent (default `true`, `false`) |

**201**: the customer. The creator gets the **unmasked** phone, since they just typed it.

```json
{ "_id": "6ae315f88f7662f81c2120fa", "name": "Kiran Rao", "phone": "+919876500099", "altPhones": ["+919876500098"], "gender": "female", "dob": "1992-08-15", "source": "referral", "tags": ["bridal"], "notes": "Prefers weekends", "stats": { "visits": 0, "spendPaise": 0, "noShows": 0 }, "walletBalancePaise": 0, "loyaltyPoints": 0, "duePaise": 0, "serviceNotes": [] }
```

A phone that already exists:

```json
{ "error": { "code": "DUPLICATE_PHONE", "message": "Customer with phone +919876500099 already exists", "details": { "customerId": "6ae315f88f7662f81c2120fa" } } }
```

(409). Offer "Open existing customer" using `details.customerId`.

### `GET /customers/:id`, `PATCH /customers/:id`

`PATCH` takes any create field and changes only what you send. Responses are masked for managers and branch logins.

### `POST /customers/:id/reveal`

**200** `{ "phone": "+919876500001" }`. For a manager or branch login this writes a `customer.phone_reveal` audit entry. Show it on a "tap to call" button rather than storing it.

### `POST /customers/:id/notes` — service note (colour formula, skin type…)

```json
{ "text": "Global colour 6.0 + 20 vol, 35 min", "colourFormula": "6.0 + 20vol", "staffId": "6ae3157ff1687a9fa505132e" }
```

**200**: the customer, with the note first in `serviceNotes` (`{ date, staffId, text, colourFormula }`). Up to 200 notes are kept.

### `GET /customers/:id/history?type=`

`type` is one of `bills`, `appointments`, `plans`, `wallet`, `loyalty`, `feedback` or `whatsapp`; omit it for all. **200**: `{ bills: [...], appointments: [...], ... }`, the latest 50 of each. An unknown customer → 404.

### Merge duplicates: `POST /customers/:id/merge`

```json
{ "duplicateId": "6ae315f88f7662f81c2120fa" }
```

`:id` is the customer you **keep**. Moved into it:
- the duplicate's bills, appointments, plans, wallet and loyalty ledgers, dues, receipts, leads and WhatsApp chats;
- its balances (wallet, points, dues) and visit stats;
- its phone, which becomes an alternate phone.

The duplicate is retired (`mergedInto`), and its phone becomes free. **200**: the kept customer. The older `POST /customers/merge` with `{ primaryId, duplicateId }` also works.

### `GET /customers/export` (owner)

An `.xlsx` file (`Content-Disposition: attachment`). Download it with `responseType: 'blob'`.

---

## 13. Calendar and appointments

### Status lifecycle

| From | Can move to |
| --- | --- |
| `booked` | `confirmed`, `arrived`, `cancelled`, `no_show` |
| `confirmed` | `arrived`, `in_service`, `cancelled`, `no_show` |
| `arrived` | `in_service`, `cancelled` |
| `in_service` | `completed` |
| `completed` | (`billed` happens automatically when a bill with this `appointmentId` is saved) |

- **Arrived:** only on the appointment's day.
- **Cancelled:** needs a `reason`.
- **No-show:** adds 1 to the customer's `stats.noShows`.
- **Not allowed** → `422 INVALID_TRANSITION`.
- **Cancelling the bill** moves the appointment back to `completed`.

### `GET /branches/:branchId/appointments?from=&to=&staffId=&status=&customerId=` — calendar

`from` and `to` are `YYYY-MM-DD` (default today), at most 31 days apart. **200**:

```json
{
  "from": "2026-10-30", "to": "2026-10-30",
  "appointments": [
    {
      "_id": "6ae3157ff1687a9fa50513cf", "branchId": "6ae3157eee449d9d05b4175b",
      "customerId": { "_id": "6ae3157ff1687a9fa5051370", "name": "Ananya Iyer", "phone": "98XXXXXX02" },
      "businessDate": "2026-10-30", "status": "booked", "source": "phone",
      "start": "2026-10-30T05:30:00.000Z", "end": "2026-10-30T06:15:00.000Z",
      "lines": [{ "_id": "6ae3157ff1687a9fa50513ce", "serviceId": "6ae3157ff1687a9fa50512e4", "serviceName": "Haircut (Women)", "staffId": "6ae3157ff1687a9fa505132e", "start": "2026-10-30T05:30:00.000Z", "end": "2026-10-30T06:15:00.000Z" }]
    }
  ],
  "staff": [
    { "_id": "6ae3157ff1687a9fa505131f", "name": "Sameer Khan", "designation": "senior_stylist" },
    { "_id": "6ae3157ff1687a9fa505132e", "name": "Tara Patel", "designation": "stylist" }
  ],
  "rosters": [{ "staffId": "6ae3157ff1687a9fa505131f", "weekly": [{ "day": 0, "start": "10:00", "end": "20:00", "off": false }], "overrides": [] }],
  "leaves": [],
  "staffBlocks": []
}
```

- **Columns:** `staff` holds the bookable staff, everyone except receptionists and managers.
- **Placing appointments:** put each **line** in its stylist's column. One appointment can have lines with different stylists.
- **Greying out unavailable time:** use the branch hours (`GET /business/branches`), each stylist's `rosters` (an override for the date wins over `weekly`), approved `leaves`, and `staffBlocks`.
- Customer phones are masked for managers and branch logins.

### `GET /branches/:branchId/availability?serviceId=&date=&staffId=&stepMin=`

Free start times (IST `HH:mm`) per eligible stylist. `stepMin` is 5, 10, 15 (default), 30 or 60.

```json
{
  "date": "2026-10-30", "serviceId": "6ae3157ff1687a9fa50512e4", "serviceName": "Haircut (Women)", "durationMin": 45, "stepMin": 30,
  "staff": [
    { "staffId": "6ae3157ff1687a9fa505131f", "name": "Sameer Khan", "designation": "senior_stylist", "slots": ["10:00", "10:30", "11:00", "12:30", "13:00", "13:30"] },
    { "staffId": "6ae3157ff1687a9fa505132e", "name": "Tara Patel", "designation": "stylist", "slots": ["10:00", "12:00", "12:30", "13:00", "13:30", "14:00"] }
  ]
}
```

A slot means the **whole service fits**:
- the stylist is rostered then and not on leave, blocked or booked;
- the branch is open (holidays return `staff: []`);
- the service isn't hidden for this branch;
- times already past today are left out.

Eligibility follows the service's `eligibleStaffIds` and the staff member's `serviceIds`.

### `POST /branches/:branchId/appointments` — book

```json
{
  "customerId": "6ae3157ff1687a9fa5051382",
  "lines": [
    { "serviceId": "6ae3157ff1687a9fa50512ea", "staffId": "6ae3157ff1687a9fa505131f", "start": "2026-10-30T09:30:00.000Z" },
    { "serviceId": "6ae3157ff1687a9fa50512fe", "start": "2026-10-30T10:00:00.000Z" }
  ],
  "source": "phone",
  "notes": "First visit"
}
```

- **New customer:** send `"newCustomer": { "name": "…", "phone": "…" }` instead of `customerId`. If the phone already belongs to a customer, that customer is used.
- **Any available:** leave out `staffId` and the first free bookable stylist is picked (the facial above went to Sameer).
- **Times:** `start` is an ISO instant; build it with `istInstant(date, '15:00')` (§8.1). Each line's end is `start` plus the service duration.

**201**:

```json
{
  "_id": "6ae315f88f7662f81c21219d", "branchId": "6ae3157eee449d9d05b4175b", "customerId": "6ae3157ff1687a9fa5051382", "businessDate": "2026-10-30",
  "lines": [
    { "_id": "6ae315f88f7662f81c21216e", "serviceId": "6ae3157ff1687a9fa50512ea", "serviceName": "Haircut (Men)", "staffId": "6ae3157ff1687a9fa505131f", "start": "2026-10-30T09:30:00.000Z", "end": "2026-10-30T10:00:00.000Z" },
    { "_id": "6ae315f88f7662f81c21219c", "serviceId": "6ae3157ff1687a9fa50512fe", "serviceName": "Classic Facial", "staffId": "6ae3157ff1687a9fa505131f", "start": "2026-10-30T10:00:00.000Z", "end": "2026-10-30T11:00:00.000Z" }
  ],
  "start": "2026-10-30T09:30:00.000Z", "end": "2026-10-30T11:00:00.000Z",
  "status": "booked", "source": "phone", "notes": "First visit",
  "statusLog": [{ "status": "booked", "at": "2026-10-29T09:46:32.370Z", "by": "6ae3157eee449d9d05b41765", "reason": "Initial booking" }],
  "__v": 0
}
```

**409 `SLOT_CLASH`** carries a human-readable reason, for example:
- `"Staff Sameer Khan already has an appointment during this time window"`
- `"Appointment (09:00 - 09:30) is outside branch hours (10:00 - 20:00)"`
- `"Staff Tara Patel is on approved leave on 2026-11-10"`
- `"Staff Tara Patel is blocked for \"Lunch\""`
- `"Staff member Tara Patel is not eligible for service Global Colour"`
- `"Two services in this booking overlap for the same stylist"`
- `"No eligible staff available for Haircut (Men) at 15:00"`

Two bookings sent at the same moment for the same stylist and time: exactly one wins, the other gets 409.

### `POST /branches/:branchId/walk-in` (also `/appointments/walk-in`)

```json
{ "customerId": "6ae3157ff1687a9fa5051388", "serviceIds": ["6ae3157ff1687a9fa50512ea"] }
```

Starts at the next 5-minute mark with the first free stylist. Services run back to back. **201**: an appointment with `"source": "walk_in"`. Outside opening hours, or with nobody free → 409.

### `PATCH /appointments/:id` — reschedule or edit notes *(new)*

```json
{ "lines": [{ "serviceId": "6ae3157ff1687a9fa50512ea", "staffId": "6ae3157ff1687a9fa505131f", "start": "2026-10-30T10:30:00.000Z" }], "notes": "Moved by phone", "__v": 0 }
```

- **What to send:** `__v` as you loaded it, and `lines` (the full new list) and/or `notes`.
- **Clash rules:** the same as booking; the appointment's own old slot doesn't count against it.
- **Who can reschedule:** only `booked` and `confirmed` appointments; otherwise 422.
- **200**: the appointment with `__v` incremented.
- **Stale `__v`:** `409 {"error":{"code":"VERSION_CONFLICT","message":"The appointment was changed by someone else; reload and try again"}}`.

### `PATCH /appointments/:id/status` (also `POST`)

```json
{ "status": "cancelled", "reason": "Customer called" }
```

**200**: the appointment, with the change added to `statusLog`.

### `GET /appointments/:id`

The appointment, with the customer (name and phone, masked for staff), services and staff names filled in.

### Staff blocks

`POST /branches/:branchId/staff-blocks`:

```json
{ "staffId": "6ae3157ff1687a9fa505132e", "start": "2026-10-30T07:30:00.000Z", "end": "2026-10-30T08:30:00.000Z", "reason": "Lunch" }
```

- **201**: the block.
- **Rules:** `end` after `start`, and the staff member must be in this branch (404).
- **Remove:** `DELETE /branches/:branchId/staff-blocks/:blockId` → `{ "success": true }`, or 404.

---

## 14. Billing

### 14.1 The new-bill screen, step by step

1. **Customer:** search, or create one (§12).
2. **Lines:** services (each with a stylist split), products, or plans to sell. Offer services with `branchActive: true` (§6).
3. **Live totals:** as the cart changes, call `POST /bills/preview` (debounced). It returns totals, line commissions, `payablePaise` and whether approval is needed.
4. **Payments:** cash, UPI, card or wallet, adding up to `payablePaise`. For cash, record `tenderedPaise` to show change.
5. **Save:** `POST /bills` with an `Idempotency-Key` header, so a double tap or a retry never creates two bills.
6. **Result:** if the response status is `awaiting_approval`, show "Sent for approval". Otherwise, offer **Print** (`GET /bills/:id/pdf`).

### 14.2 Request body (create and preview)

```json
{
  "customerId": "6ae3157ff1687a9fa505136a",
  "billedByStaffId": "6ae3157ff1687a9fa5051310",
  "appointmentId": "6ae3157ff1687a9fa50513cf",
  "lines": [
    { "kind": "service", "refId": "<serviceId>", "qty": 1, "staff": [{ "staffId": "<stylistId>", "splitBps": 10000 }] },
    { "kind": "service", "refId": "<serviceId>", "staff": [{ "staffId": "<a>", "splitBps": 5000 }, { "staffId": "<b>", "splitBps": 5000 }] },
    { "kind": "product", "refId": "<productId>", "qty": 2, "lineDiscount": { "type": "amount", "value": 5000 }, "staff": [{ "staffId": "<seller>", "splitBps": 10000 }] },
    { "kind": "membership", "refId": "<planId>" }
  ],
  "billDiscount": { "type": "pct", "value": 1000 },
  "redemptions": [
    { "kind": "package", "refId": "<customerPlanId>", "lineId": "0" },
    { "kind": "membership", "refId": "<customerPlanId>" },
    { "kind": "loyalty", "refId": "<customerId>", "points": 100 },
    { "kind": "voucher", "refId": "<customerPlanId of the voucher>" }
  ],
  "tips": [{ "staffId": "<stylistId>", "amountPaise": 5000, "payout": "cash_today" }],
  "payments": [{ "mode": "upi", "amountPaise": 100000, "ref": "UPI-4471" }, { "mode": "cash", "amountPaise": 15000, "tenderedPaise": 20000 }],
  "collectDues": [{ "dueId": "<dueId>", "amountPaise": 18000 }]
}
```

| Part | Rules |
| --- | --- |
| `lines[].kind` | `service`, `product`, `membership`, `package`, `wallet_topup` (wallet offer plan) or `voucher` (gift voucher plan). `refId` is the service, product or plan id |
| price | taken from the server: the branch price if set (§6), the product's selling price, or the plan price. A service hidden for the branch → `422 SERVICE_UNAVAILABLE`; a consumable product can't be sold |
| `staff[]` | stylists (services) or sellers (products) of this business. `splitBps` on a line must add up to 10000 → otherwise `422 SPLIT_INVALID`. Names are copied onto the bill. Commission uses the service's rule, else the staff member's own; products use their `productBps` |
| discounts | `lineDiscount` and `billDiscount` take `{ type: 'amount', value: paise }` or `{ type: 'pct', value: bps }`. Order: line discount → membership → bill discount → loyalty and vouchers → GST |
| `redemptions` | package: `lineId` is the **index** of the line it pays for; it makes that line ₹0 and uses one session. Membership: % off service lines only. Loyalty: `points`, valued by the server at `points × redeemValuePaise` (any client amount is ignored), with `minRedeem` and loyalty switched on. Voucher: its value, once. Expired, frozen, used or other-branch plans → `422 PLAN_INACTIVE` / `PLAN_OUT_OF_SCOPE` |
| `tips` | to staff of this business; not taxed, not sales. `cash_today` is paid from the till (day-end); `payroll` is paid with salary |
| `payments` | modes `cash`, `upi`, `card`, `wallet` (the wallet must cover it). The total may be **less** than payable (the rest becomes a due, which needs approval for non-owners) but never **more**: `422 "Payments are more than the amount payable"` with `details.payablePaise` |
| `collectDues` | old dues of this customer collected on this bill. Payments must then cover the bill **and** those dues in full |
| `billedByStaffId` | branch login: **required**, an active receptionist of this branch (`GET /staff/branches/:id/billed-by`). Owner or manager: optional, any active staff member |
| `appointmentId` | that customer's appointment in this branch; it becomes `billed` |

### 14.3 `POST /branches/:branchId/bills/preview`

Same body; `customerId` is optional (redemptions and dues need it). Nothing is saved. **200**:

```json
{
  "payablePaise": 99000,
  "totals": { "grossPaise": 110000, "discountPaise": 11000, "taxablePaise": 99000, "cgstPaise": 0, "sgstPaise": 0, "roundOffPaise": 0, "totalPaise": 99000, "paidPaise": 0, "duePaise": 99000, "totalTipsPaise": 0 },
  "lines": [
    { "kind": "service", "name": "Haircut (Women)", "qty": 1, "unitPricePaise": 60000, "discountPaise": 6000, "taxablePaise": 54000, "gstBps": 0, "cgstPaise": 0, "sgstPaise": 0, "totalPaise": 54000, "staff": [{ "staffId": "6ae3157ff1687a9fa505132e", "name": "Tara Patel", "splitBps": 10000, "commissionPaise": 5400 }] },
    { "kind": "product", "name": "Argan Shampoo", "qty": 1, "unitPricePaise": 50000, "discountPaise": 5000, "taxablePaise": 45000, "totalPaise": 45000, "staff": [] }
  ],
  "redemptions": [], "tips": [], "collectDuesPaise": 0,
  "needsApproval": true, "approvalReasons": ["partly_paid"]
}
```

`approvalReasons` can contain `discount_over_limit` and/or `partly_paid`. Owners never need approval. `payablePaise` = total + tips + dues being collected.

### 14.4 `POST /branches/:branchId/bills`

Send the header `Idempotency-Key: <uuid>`. Generate it once when the screen opens, and reuse it for retries of the same bill. A repeat with the same key returns the **same** bill, even if two requests race. Send the same body with it; the body is validated first.

**201**:

```json
{
  "_id": "6ae315f88f7662f81c2122c3", "invoiceNo": "TST1/2026-27/000004", "fy": "2026-27", "businessDate": "2026-10-29", "status": "paid",
  "branchId": "6ae3157eee449d9d05b4175b", "customerId": "6ae3157ff1687a9fa505136a", "customerSnap": { "name": "Priya Shah", "phone": "+919876500001" },
  "billedByStaffId": "6ae3157ff1687a9fa5051310", "billedByName": "Riya Mehta", "gstApplied": false, "pricesInclusive": false,
  "lines": [
    { "_id": "6ae315f88f7662f81c2122be", "kind": "service", "refId": "6ae3157ff1687a9fa50512e4", "name": "Haircut (Women)", "hsnSac": "9983", "qty": 1, "unitPricePaise": 60000, "discountPaise": 0, "taxablePaise": 60000, "gstBps": 0, "cgstPaise": 0, "sgstPaise": 0, "totalPaise": 60000, "staff": [{ "staffId": "6ae3157ff1687a9fa505132e", "name": "Tara Patel", "splitBps": 10000, "commissionPaise": 6000 }], "consumablesUsed": [] },
    { "_id": "6ae315f88f7662f81c2122c0", "kind": "product", "refId": "6ae3157ef1687a9fa50512bd", "name": "Argan Shampoo", "hsnSac": "3305", "qty": 1, "unitPricePaise": 50000, "discountPaise": 0, "taxablePaise": 50000, "totalPaise": 50000, "staff": [{ "staffId": "6ae3157ff1687a9fa505132e", "name": "Tara Patel", "splitBps": 10000, "commissionPaise": 0 }] }
  ],
  "redemptions": [],
  "totals": { "grossPaise": 110000, "discountPaise": 0, "taxablePaise": 110000, "cgstPaise": 0, "sgstPaise": 0, "roundOffPaise": 0, "totalPaise": 110000, "paidPaise": 115000, "duePaise": 0 },
  "payments": [
    { "mode": "upi", "amountPaise": 100000, "businessDate": "2026-10-29", "ref": "UPI-4471", "at": "2026-10-29T09:46:32.471Z" },
    { "mode": "cash", "amountPaise": 15000, "businessDate": "2026-10-29", "tenderedPaise": 20000, "at": "2026-10-29T09:46:32.471Z" }
  ],
  "tips": [{ "staffId": "6ae3157ff1687a9fa505132e", "staffName": "Tara Patel", "amountPaise": 5000, "payout": "cash_today" }],
  "refunds": [], "version": 1, "idempotencyKey": "demo-key-1", "__v": 0
}
```

- **Paid amount:** `totals.paidPaise` is what was paid towards this bill, including tips (here ₹1,100 + ₹50 tip).
- **Statuses:** `paid`, `partly_paid` (a due was created), or `awaiting_approval`. An `awaiting_approval` bill has its invoice number but no effects yet: no stock taken, no dues, no points.
- **When saved paid:** stock is deducted (products, and service consumables at cost), wallet, points and dues are updated, the customer's visits and spend go up, and the day's totals are updated.

| Error | When |
| --- | --- |
| `400 {"error":{"code":"VALIDATION_ERROR","message":"billedByStaffId is required for bills created by branch login","fields":{"billedByStaffId":"Choose who is billing"}}}` | Branch login without billed-by |
| `422 VALIDATION_ERROR "Payments are more than the amount payable"` | Overpaying (`details.payablePaise`) |
| `422 INSUFFICIENT_WALLET` | Wallet payment above the balance, or loyalty points above the customer's |
| `422 NO_SESSIONS_LEFT`, `PLAN_INACTIVE`, `PLAN_OUT_OF_SCOPE` | Redemptions |
| `422 SERVICE_UNAVAILABLE`, `SPLIT_INVALID` | Lines |
| `409 DAY_CLOSED` | The branch's day-end is approved (§17) |
| `404` | Customer, staff, service, product or plan not in this business |

### 14.5 Approvals

`GET /approvals?branchId=` (owner, manager) returns held bills, oldest first. A manager only ever sees their own branches. Each bill has `"status": "awaiting_approval"` and `"approval": { "reasons": ["discount_over_limit"], "requestedAt": "…" }`.

`POST /bills/:id/decide`:

```json
{ "decision": "approve", "reason": "Regular customer" }
```

```json
{ "decision": "reject", "reason": "Discount too high" }
```

| Result | Details |
| --- | --- |
| **Approve** | applies all effects; `status` becomes `paid` or `partly_paid` |
| **Reject** | `rejected`; nothing is applied; the invoice number stays used |
| `decision` | must be exactly `approve` or `reject` (400 otherwise); reject needs a `reason` |
| Already decided | `422 INVALID_TRANSITION` |

Above `discountLimits.ownerAlertBps`, the owner gets an in-app notification (`type: "bill.discount_alert"`) for bills by managers and branch logins.

### 14.6 Bills list, detail and invoice

- **`GET /branches/:branchId/bills?from=&to=&status=&customerId=&billedBy=&q=&page=&limit=`** → `{ "bills": [...], "total": 12 }`, newest first. `q` searches invoice numbers (e.g. `000004`). `status` is `awaiting_approval`, `rejected`, `paid`, `partly_paid`, `cancelled`, `refunded` or `partly_refunded`.
- **`GET /bills/:id`** → `{ "bill": {…}, "versions": [ { "version": 1, "snapshot": {…}, "editedBy": "…", "reason": "…" } ] }`. `versions` holds earlier versions, newest first.
- **`GET /bills/:id/pdf?format=a4|thermal`** *(new)* returns a real PDF (`Content-Type: application/pdf`, `Content-Disposition: inline; filename="TST1-2026-27-000004.pdf"`):
  - **Layouts:** A4 is a GST tax invoice (a bill of supply when GST is off), with GSTIN, HSN/SAC, CGST/SGST, payments, dues and refunds. Thermal is the 80 mm receipt.
  - **Stamps:** cancelled, held and refunded bills are stamped.
  - **Phone:** shown masked.
  - **Fetching it:** `api.get(url, { responseType: 'blob' })`, then open `URL.createObjectURL(blob)` in a new tab or an `<iframe>` and print.

### 14.7 Edit: `PATCH /bills/:id` (owner, manager)

```json
{ "lines": [{ "kind": "service", "refId": "<serviceId>", "staff": [{ "staffId": "<id>", "splitBps": 10000 }] }], "reason": "Shampoo returned unopened", "__v": 0 }
```

| Part | Rules |
| --- | --- |
| `lines` | always the full new list |
| `payments`, `tips`, `billDiscount` | optional; **if left out, they stay as they were** |
| `redemptions` | send them again if they still apply |
| `reason`, `__v` | required. Stale `__v` → `409 VERSION_CONFLICT` |

**What happens:**
1. The old version is saved as a snapshot (`versions`) and its effects are reversed: stock, wallet, dues, points, sessions, stats, day totals.
2. The new version is applied. The invoice number stays the same and `version` goes up.
3. If the new total is less than what was paid (payments untouched), the bill shows `paidPaise` > `totalPaise`. Give the difference back with a refund (§14.8).

**Limits:**
- Only `paid`, `partly_paid` and `awaiting_approval` bills can be edited; others → `422`.
- A manager can't edit to a discount above their limit → `422 DISCOUNT_LIMIT`, and can't edit on a closed day → `409 DAY_CLOSED`. The owner can do both.
- A plan sold on the bill that has already been used blocks the edit (`422 PLAN_IN_USE`).

### 14.8 Cancel and refund

**Cancel:** `POST /bills/:id/cancel` with `{ "reason": "Billed the wrong customer" }`.
- **What it does:** the bill is kept, marked `cancelled`, and every effect is reversed:
  - stock comes back, and wallet payments are refunded to the wallet;
  - points earned are removed and points redeemed are returned;
  - package sessions and vouchers come back;
  - unused plans sold on it are cancelled, and wallet credit sold on it is removed;
  - its due is voided, and dues it collected are owed again;
  - visit stats and the day's totals are reversed.
- **Blocked when:**
  - a plan it sold has been used, or the wallet credit it sold has been spent → `422 PLAN_IN_USE`;
  - the bill is rejected, already cancelled or refunded → `422`;
  - the day is closed (managers) → `409 DAY_CLOSED`.
- **A held bill** is simply cancelled; nothing had been applied.

**Refund:** `POST /bills/:id/refund` with `{ "amountPaise": 50000, "mode": "cash", "reason": "Shampoo refunded" }`.
- **What it does:** money goes back to the customer; stock and stats are unchanged.
- **Statuses:** `partly_refunded`, then `refunded` once the whole paid amount is returned.
- **Limits:**
  - total refunds can't exceed `totals.paidPaise` (`details.refundablePaise`);
  - only `paid`, `partly_paid` and `partly_refunded` bills can be refunded;
  - `mode` is `cash`, `upi` or `card`.
- **Day-end:** the refund counts on the day it's paid out, even for an older bill.

### 14.9 Dues

`GET /customers/:id/dues` returns open dues, oldest first:

```json
[{ "_id": "6ae3157ff1687a9fa5051457", "customerId": "6ae3157ff1687a9fa5051370", "billId": { "_id": "6ae3157ff1687a9fa505144b", "invoiceNo": "TST1/2026-27/000002", "businessDate": "2026-10-29", "branchId": "6ae3157eee449d9d05b4175b" }, "amountPaise": 70000, "settledPaise": 0, "status": "open", "settlements": [] }]
```

`POST /branches/:branchId/due-receipts` (any role):

```json
{ "customerId": "6ae3157ff1687a9fa5051370", "payments": [{ "mode": "upi", "amountPaise": 40000, "ref": "UPI-8812" }] }
```

**201**: allocated to the oldest dues first, and added to today's takings.

```json
{ "_id": "6ae315f88f7662f81c2123cc", "receiptNo": "TST1/2026-27/RCP-000001", "businessDate": "2026-10-29", "customerId": "6ae3157ff1687a9fa5051370", "payments": [{ "mode": "upi", "amountPaise": 40000 }], "allocations": [{ "dueId": "6ae3157ff1687a9fa5051457", "amountPaise": 40000 }], "status": "active" }
```

- More than owed → `422 "Payment is more than the customer owes"` (`details.outstandingPaise`).
- Wallet can't pay dues.
- To collect a due together with a new bill, use `collectDues` on the bill (§14.2).

---

# Part 3: Catalogue → Plans, Stock, Money (Phase 3)

## 15. Plans (memberships, packages, wallet offers, gift vouchers)

| Action | Owner | Manager | Branch login |
| --- | --- | --- | --- |
| Create or edit plans | ✅ | ❌ | ❌ |
| View plans, customer plans, wallet, loyalty, vouchers | ✅ | ✅ | ✅ |
| Sell or redeem plans on a bill | ✅ | ✅ | ✅ |
| Extend, freeze, unfreeze | ✅ | ✅ | ❌ |
| Transfer a plan to another customer; adjust a wallet | ✅ | ❌ | ❌ |

### 15.1 Plan catalogue

`GET /plans?type=&active=` returns plans, newest first. `type` is `membership`, `package`, `wallet_offer` or `voucher`.

`POST /plans`: each type needs its own block.

```json
{ "type": "membership", "name": "Gold Membership", "pricePaise": 200000, "validityDays": 365, "membership": { "serviceDiscountBps": 2000 } }
```

```json
{ "type": "package", "name": "4 Facials", "pricePaise": 500000, "validityDays": 120, "package": { "items": [{ "serviceId": "<facial>", "sessions": 4 }] }, "branchScope": ["<branchId>"] }
```

```json
{ "type": "wallet_offer", "name": "Pay ₹5,000 get ₹6,000", "pricePaise": 500000, "validityDays": 365, "walletOffer": { "creditPaise": 600000 } }
```

```json
{ "type": "voucher", "name": "₹1,000 Gift Voucher", "pricePaise": 100000, "validityDays": 90, "voucher": { "valuePaise": 100000 } }
```

| Field | Rule |
| --- | --- |
| type block | missing → `400 {"fields":{"membership":"membership is required for a membership plan"}}` |
| `walletOffer.creditPaise` | at least `pricePaise` |
| `package.items[].serviceId`, `branchScope[]` | this business's services and branches; an empty `branchScope` means every branch |
| `validityDays` | 1–3650 |

**201**:

```json
{ "_id": "6ae315f88f7662f81c2123e4", "type": "package", "name": "4 Facials", "pricePaise": 500000, "validityDays": 120, "package": { "items": [{ "serviceId": "6ae3157ff1687a9fa50512fe", "sessions": 4 }] }, "branchScope": ["6ae3157eee449d9d05b4175b"], "active": true }
```

`PATCH /plans/:id` accepts **only** `name`, `active`, `validityDays` and `branchScope` (these apply to future sales). Price and contents are fixed: `{ "pricePaise": 1 }` → `400` (unrecognised key). To change a price, deactivate the plan and create a new one; plans already sold keep a snapshot.

### 15.2 Selling a plan

Add it as a bill line: `{ "kind": "membership" | "package" | "wallet_topup" | "voucher", "refId": "<planId>" }`. When the bill is saved:

| Type | Creates |
| --- | --- |
| membership | a customer plan, `validFrom` = bill date, `validTill` = + `validityDays` |
| package | a customer plan with `sessions: [{ serviceId, total, used: 0, perSessionValuePaise }]`, where `perSessionValuePaise` = price ÷ sessions. Commission on a redeemed session uses this value |
| wallet offer | wallet credit of `creditPaise`: ledger rows `topup` (the price) and `bonus` (the extra) |
| voucher | a customer plan with a unique `voucherCode` such as `GV-XYJ4XPM4` (print it for the gift) |

Gift vouchers and wallet top-ups carry no GST.

### 15.3 Customer plans

`GET /customers/:id/plans`: plans past `validTill` show as `expired`.

```json
[{
  "_id": "6ae3157ff1687a9fa5051430", "customerId": "6ae3157ff1687a9fa5051376", "planId": "6ae3157ff1687a9fa505139a",
  "planSnap": { "type": "package", "name": "6 Men's Haircuts", "pricePaise": 150000, "validityDays": 180, "package": { "items": [{ "serviceId": "6ae3157ff1687a9fa50512ea", "sessions": 6 }] }, "branchScope": [] },
  "soldBillId": "6ae3157ff1687a9fa5051429", "soldBranchId": "6ae3157eee449d9d05b4175b",
  "validFrom": "2026-10-29", "validTill": "2027-04-27",
  "sessions": [{ "serviceId": "6ae3157ff1687a9fa50512ea", "total": 6, "used": 0, "perSessionValuePaise": 25000 }],
  "status": "active",
  "log": [{ "action": "sold", "at": "2026-10-29T09:44:31.407Z", "by": "6ae3157eee449d9d05b41765", "detail": { "soldBillId": "6ae3157ff1687a9fa5051429" } }]
}]
```

- `status` is one of `active`, `frozen`, `expired`, `used_up`, `transferred` or `cancelled`.
- `log[].action` is one of `sold`, `redeem`, `extend`, `freeze`, `unfreeze`, `transfer`, `reverse` or `cancel`.
- `GET /customer-plans/:id` returns one plan.

| Call | Body | Rules |
| --- | --- | --- |
| `POST /customer-plans/:id/extend` | `{ "days": 30 }` | not for cancelled or transferred plans; an expired plan becomes active again if the new date is in the future |
| `POST /customer-plans/:id/freeze` | `{ "reason": "Travelling for a month" }` | active plans only |
| `POST /customer-plans/:id/unfreeze` | — | frozen plans only; validity is extended by the frozen days (at least 1) |
| `POST /customer-plans/:id/transfer` | `{ "toCustomerId": "…" }` | owner; active plans; to a customer of the same business (404 otherwise) |

An invalid change → `422 {"error":{"code":"INVALID_TRANSITION","message":"Only active plans can be frozen"}}`.

### 15.4 Redeeming on a bill

See the `redemptions` row in §14.2.
- **Package:** a ₹300 haircut with a package session gives a line of `discountPaise: 30000, totalPaise: 0`. Sameer's commission is 10% of the ₹250 session value, which is `commissionPaise: 2500`.
- **Membership:** in preview, a 20% membership takes ₹120 off the ₹600 haircut. The shampoo stays at ₹500, because memberships discount services only.

### 15.5 Wallet and loyalty

- **`GET /customers/:id/wallet`** *(new)* → `{ "customerId": "…", "balancePaise": 20000, "ledger": [{ "type": "adjust", "amountPaise": 20000, "reason": "Goodwill for delay", "balanceAfterPaise": 20000, "createdAt": "…" }] }`. Ledger `type` is one of `topup`, `bonus`, `redeem`, `reverse` or `adjust`; the latest 50 rows.
- **`POST /customers/:id/wallet/adjust`** (owner) with `{ "amountPaise": 20000, "reason": "Goodwill for delay" }`. Negative amounts take money out; going below zero → `422 INSUFFICIENT_WALLET` (`details.balancePaise`).
- **`GET /customers/:id/loyalty`** *(new)* → `{ "points": 50, "valuePaise": 5000, "rules": { "enabled": true, "earnPer100": 1, "redeemValuePaise": 100, "minRedeem": 10, "expiryDays": 365 }, "ledger": [...] }`.
  - **Earning:** a paid bill earns `earnPer100` points per full ₹100 of its total.
  - **Using:** redeem them on a bill (§14.2).
- The older `GET /customers/:id/wallet/ledger` and `/loyalty/ledger` still work.

### 15.6 `GET /vouchers/:code`

The voucher with its owner (phone masked for staff):

```json
{ "_id": "6ae315f88f7662f81c212408", "voucherCode": "GV-XYJ4XPM4", "customerId": { "_id": "6ae3157ff1687a9fa5051388", "name": "Sneha Kapoor", "phone": "98XXXXXX06" }, "planSnap": { "type": "voucher", "name": "₹1,000 Gift Voucher", "voucher": { "valuePaise": 100000 } }, "validFrom": "2026-10-29", "validTill": "2027-01-27", "status": "active" }
```

Unknown code → 404. Expired or used → `422 PLAN_INACTIVE`. To redeem, put `{ "kind": "voucher", "refId": "<its _id>" }` in the bill's `redemptions`; anyone holding the code can use it, once.

---

## 16. Stock

| Action | Owner | Manager | Branch login |
| --- | --- | --- | --- |
| Products: create or edit | ✅ | ❌ | ❌ |
| Vendors: create or edit | ✅ | ✅ | ❌ |
| View stock and movements | ✅ | ✅ own branches | ✅ own branch |
| Adjust stock / record internal use | ✅ | ✅ own branches | ❌ |
| Purchase orders | ✅ | ✅ own branches (approval needs `approvePO`) | ❌ |
| Transfers | ✅ | ✅ sending branch approves and dispatches; receiving branch receives | ❌ |
| Stock audits | ✅ | ✅ own branches (count and approve) | ❌ |

### 16.1 Products and vendors

- **`GET /products?type=&active=`**. `type` is `retail` (sold), `consumable` (used in services) or `both`.
- **`POST /products`** (owner):

```json
{ "name": "Keratin Serum", "brand": "Moroccan", "type": "both", "purchaseUnit": "bottle", "useUnit": "ml", "unitsPerPurchase": 100, "mrpPaise": 120000, "sellingPricePaise": 99000, "purchasePricePaise": 60000, "hsn": "3305", "gstBps": 1800, "reorderLevels": [{ "branchId": "<TST1>", "qty": 200 }] }
```

  - **Units:** buy in `purchaseUnit`, stock and use in `useUnit` (1 bottle = 100 ml).
  - **Prices:** `purchasePricePaise` is per purchase unit and drives cost and stock value. `sellingPricePaise` (else `mrpPaise`) is the retail price on bills; `gstBps` is the product GST.
  - **Reorder level:** `reorderLevels` set per branch, in use units.
  - **Edit:** `PATCH /products/:id`.
- **Vendors:** `GET /vendors`; `POST /vendors` with `{ "name": "Keratin House", "contact": "Amit", "phone": "9822200012", "gstin": "24ABCDE1234F1Z5", "terms": "30 days credit" }`; `PATCH /vendors/:id`.

### 16.2 Stock and movements

**`GET /branches/:branchId/stock?pool=&productId=&lowOnly=true`**:

```json
[{
  "_id": "6ae3157e19bcd4a3b90d29e8", "branchId": "6ae3157eee449d9d05b4175b", "pool": "retail", "qty": 19,
  "productId": { "_id": "6ae3157ef1687a9fa50512bd", "name": "Argan Shampoo", "brand": "Moroccan", "type": "retail", "purchaseUnit": "bottle", "useUnit": "bottle", "unitsPerPurchase": 1, "sellingPricePaise": 50000, "purchasePricePaise": 30000, "active": true },
  "reorderLevel": null, "low": false, "valuePaise": 570000, "lastMovementAt": "2026-10-29T09:46:32.543Z"
}]
```

- **Pools:** `retail` (for sale) and `consumable` (for services). A `both`-type product can hold stock in each.
- **Quantities and value:** `qty` is in use units and **may go negative**; billing never blocks on stock. `valuePaise` is the quantity at purchase cost.
- **Low stock:** `low` is true when `qty` ≤ the branch reorder level.

**`GET /branches/:branchId/stock/movements?productId=&pool=&type=&businessDate=&limit=&skip=`** returns movements, newest first, with the product filled in:
- **`type`:** `purchase`, `sale`, `service_use`, `transfer_out`, `transfer_in`, `adjust`, `internal_use`, `cancel_reverse` or `audit`.
- **`qty`:** signed.
- **`costPaise`:** the total cost of the movement.
- **`refType` / `refId`:** point to the bill, purchase order, transfer or audit.

**`POST /branches/:branchId/stock/adjust`**:

```json
{ "productId": "<shampoo>", "pool": "retail", "qty": -1, "reason": "Damaged bottle", "type": "adjust" }
```

- **201** `{ "balance": { "qty": 18, … }, "movement": { "type": "adjust", "qty": -1, "costPaise": 30000, "reason": "Damaged bottle", … } }`.
- **Types:** `type: "internal_use"` (negative qty) records stock used in the salon.
- **Wrong pool:** a pool the product doesn't have → `422 "Argan Shampoo is a retail product and has no consumable stock"`.

### 16.3 Purchase orders

Lifecycle: `pending_approval` → `approved` → `partly_received` → `received` (or `rejected`).

1. **Create:** `POST /purchase-orders`

```json
{ "branchId": "<TST1>", "vendorId": "<vendor>", "items": [{ "productId": "<serum>", "qtyPurchaseUnits": 3, "ratePaise": 60000 }] }
```

   **201** `{ "poNo": "PO-TST1-0002", "status": "pending_approval", "totalPaise": 180000, "items": [{ "productId": "…", "qtyPurchaseUnits": 3, "ratePaise": 60000, "receivedPurchaseUnits": 0 }], "vendorBill": { "paymentStatus": "unpaid", "paidPaise": 0 }, … }`. The vendor and products must be this business's, and each product can appear once.

2. **Decide:** `POST /purchase-orders/:id/decide` with `{ "decision": "approve" }`, or `{ "decision": "reject", "reason": "…" }`.

3. **Receive:** `POST /purchase-orders/:id/receive`, as many times as goods arrive:

```json
{ "items": [{ "productId": "<serum>", "qty": 2, "pool": "retail", "batch": "B-102", "expiry": "2027-12-31" }] }
```

   - **Quantities:** `qty` is in purchase units; stock goes up by `qty × unitsPerPurchase` use units.
   - **Pool:** retail products go to retail and consumables to consumable. For `both`, choose with `pool` (default retail); stock is still in use units (ml here).
   - **Cost:** the movement cost is `qty × ratePaise`.
   - **Limits:** more than is still due → `422 "Only 1 purchase unit(s) of this product are still due on the PO"`, and you can't receive before approval.

4. **Vendor bill:** `POST /purchase-orders/:id/bill` with `{ "number": "GBD/2210", "amountPaise": 180000, "paidPaise": 100000 }`. `paymentStatus` is worked out (`unpaid`, `partly_paid` or `paid`), and paid can't exceed the amount.

5. **List and detail:**
   - **`GET /purchase-orders?branchId=&vendorId=&status=`:** managers see only their own branches.
   - **`GET /purchase-orders/:id`** *(new)*: vendor, branch and product details filled in:

```json
{ "poNo": "PO-TST1-0002", "status": "partly_received", "branchId": { "name": "Test Branch", "code": "TST1" }, "vendorId": { "name": "Glam Beauty Distributors", "contact": "Sales desk", "phone": "+919822200010" }, "items": [{ "productId": { "name": "Keratin Serum", "type": "both", "purchaseUnit": "bottle", "useUnit": "ml", "unitsPerPurchase": 100 }, "qtyPurchaseUnits": 3, "ratePaise": 60000, "receivedPurchaseUnits": 2 }], "receipts": [{ "at": "…", "items": [{ "qty": 2, "batch": "B-102", "expiry": "2027-12-31" }] }], "vendorBill": { "number": "GBD/2210", "amountPaise": 180000, "paymentStatus": "partly_paid", "paidPaise": 100000 } }
```

### 16.4 Transfers between branches

Lifecycle: `requested` → `approved` (sending branch) → `dispatched` (stock leaves the sender) → `received` (stock arrives).

1. **Request:** `POST /transfers`. Both branches must be this business's, and each item's pool must be one the product has.

```json
{ "fromBranchId": "<TST1>", "toBranchId": "<TST2>", "items": [{ "productId": "<shampoo>", "pool": "retail", "qty": 3 }, { "productId": "<colour tube>", "pool": "consumable", "qty": 200 }] }
```

2. **Approve and dispatch:** `POST /transfers/:id/approve`, then `POST /transfers/:id/dispatch`. Both are done by the **sending** branch. The sender must have the stock (`422 INSUFFICIENT_STOCK`).

3. **Receive:** `POST /transfers/:id/receive`, by the **receiving** branch:

```json
{ "items": [{ "productId": "<shampoo>", "receivedQty": 2, "mismatchReason": "One bottle leaked" }, { "productId": "<colour tube>", "receivedQty": 200 }] }
```

   - **Every product** on the transfer must be listed; send `0` with a reason if nothing arrived.
   - **Too many:** more than dispatched → 422.
   - **Short:** fewer than dispatched needs `mismatchReason` → otherwise `422 "A short receipt needs a mismatch reason"`.

4. **List:** `GET /transfers?branchId=&status=`. `branchId` matches either side; managers see transfers involving their branches.

### 16.5 Stock audit (count sheet)

1. **Start:** `POST /branches/:branchId/stock-audits` with `{ "pool": "retail" }` creates a count sheet of every active product in that pool, with the current `systemQty`:

```json
{ "_id": "6ae315f88f7662f81c212545", "pool": "retail", "status": "counting", "lines": [{ "productId": "<shampoo>", "systemQty": 15 }, { "productId": "<serum>", "systemQty": 200 }] }
```

2. **Count:** `PATCH /stock-audits/:id/counts` with `{ "lines": [{ "productId": "<shampoo>", "countedQty": 10 }] }`. Status becomes `submitted`. You can send counts again until approval.

3. **Approve:** `POST /stock-audits/:id/approve`.
   - **Variance:** each counted line posts `countedQty − systemQty` as an `audit` movement. Sales made after the count still count.
   - **Approving twice** → `422`.

4. **List:** `GET /branches/:branchId/stock-audits`.

---

## 17. Money: expenses, petty cash, day-end

| Action | Owner | Manager | Branch login |
| --- | --- | --- | --- |
| Add an expense or petty-cash entry | ✅ | ✅ | ✅ |
| Edit an expense | ✅ | ✅ own branches | ❌ |
| Delete an expense | ✅ | ❌ | ❌ |
| Recurring expenses | ✅ | ✅ | view |
| Day-end: view, submit the count | ✅ | ✅ | ✅ |
| Day-end: approve | ✅ | ✅ | ❌ |
| Day-end: reopen | ✅ | ❌ | ❌ |

### 17.1 Expenses

**`POST /branches/:branchId/expenses`**:

```json
{ "category": "repairs", "amountPaise": 120000, "mode": "upi", "paidFrom": "bank", "note": "AC service", "receiptKey": "<upload key>", "businessDate": "2026-10-29" }
```

| Field | Values |
| --- | --- |
| `category` | `rent`, `electricity`, `salary_advance`, `tea_snacks`, `repairs`, `marketing`, `other` |
| `mode` | `cash`, `upi`, `card`, `bank` |
| `paidFrom` | `till` (cash drawer, which reduces day-end cash; must be `mode: cash`), `petty_cash`, `bank` |
| `businessDate` | default today; not in the future; not an approved (closed) day (`409 DAY_CLOSED`) |

**201**: the expense. Other calls:
- `GET /branches/:branchId/expenses?date=` or `?from=&to=&category=` lists expenses (deleted ones excluded).
- `PATCH /expenses/:id` with only the fields that change.
- `DELETE /expenses/:id` is a soft delete; it returns `{ "success": true }`.

**Recurring:** `POST /branches/:branchId/recurring-expenses` with `{ "category": "rent", "amountPaise": 4500000, "dayOfMonth": 5 }`, and `GET` lists them. The monthly expense is created by the background job (part of the background-workers phase; not running yet).

**Petty cash:** `POST /branches/:branchId/petty-cash` with `{ "type": "deposit", "amountPaise": 200000 }`. Types:
- `float`: today's opening cash in the drawer;
- `topup`: money added to the petty-cash box;
- `expense`: paid from petty cash;
- `deposit`: cash taken out of the drawer to the bank or owner.

Only `float` and `deposit` change the drawer's expected cash at day-end.

`GET /branches/:branchId/petty-cash?date=` lists entries. Entries are recorded for today and blocked once the day is approved.

### 17.2 Day-end closing

**`GET /branches/:branchId/closures/:date`** (`date` = `YYYY-MM-DD`; a bad date → 400) opens the screen. It returns the closure (created as `open` the first time) and what the drawer should hold:

```json
{
  "existing": { "closure": { "_id": "6ae315f88f7662f81c2125b4", "businessDate": "2026-10-29", "status": "open", "expected": { "cashPaise": 560000, "upiPaise": 400000, "cardPaise": 100000 }, "reopenLog": [] }, "breakdown": { "…": "same as below" } },
  "expected": {
    "cashPaise": 560000, "upiPaise": 400000, "cardPaise": 100000,
    "breakdown": {
      "openingCashFloat": 500000, "cashSales": 340000, "dueCash": 0, "cashRefunds": 50000, "cashExpenses": 25000, "cashTipsPaid": 5000, "cashDeposits": 200000,
      "upiSales": 360000, "dueUpi": 40000, "upiRefunds": 0,
      "cardSales": 100000, "dueCard": 0, "cardRefunds": 0
    }
  }
}
```

**Expected cash** = opening float (today's `float` entry, else the branch's `pettyCashFloatPaise`) + cash taken on bills and due receipts − cash refunds paid today (even on older bills) − cash expenses from the till − cash tips paid today − cash deposits.

UPI and card are worked out the same way, without float, expenses, tips or deposits. These don't count:
- held, rejected or cancelled bills;
- wallet payments (not cash).

**`POST /branches/:branchId/closures/:date/submit`**:

```json
{ "denominations": { "500": 11, "50": 1 }, "cashPaise": 555000, "upiPaise": 400000, "cardPaise": 100000, "diffReason": "Rs. 50 short: change given twice" }
```

| Rule | Error |
| --- | --- |
| `denominations` are note/coin counts by rupee value (`2000 500 200 100 50 20 10 5 2 1`); their total must equal `cashPaise` | `400 {"fields":{"denominations":"Notes add up to Rs. 500.00, counted cash is Rs. 5550.00"}}` |
| any difference from expected needs `diffReason` | `400 {"fields":{"diffReason":"Explain the difference"}}` |
| an approved day can't be re-submitted | `409 DAY_CLOSED` |

**200**: the closure with `expected`, `counted`, `diff` (`{ cashPaise: -5000, upiPaise: 0, cardPaise: 0 }`) and `"status": "submitted"`. It can be submitted again until approved.

**`POST /branches/:branchId/closures/:date/approve`** (owner, manager):
- **Before:** the day must be `submitted` (`422 "Submit the day-end count before approving it"`).
- **After:** `"status": "approved"`, and the day is **locked**:
  - new bills → `409 DAY_CLOSED`;
  - expenses and petty cash for that day → `409`;
  - editing or cancelling that day's bills → owner only.

**`POST /branches/:branchId/closures/:date/reopen`** (owner) with `{ "reason": "Late card settlement" }`:
- **Rules:** a reason is required (400 without one), and only an approved day can be reopened (422).
- **Result:** the closure goes back to `open`, and the reopen is logged in `reopenLog`.

Submit, approve and reopen are all written to the audit log.

---

## 18. React integration (Phases 2–3)

### 18.1 API additions

```ts
import { api } from './client';
const get = <T,>(url: string, params?: object) => api.get<T>(url, { params }).then((r) => r.data);
const post = <T,>(url: string, body?: unknown, headers?: Record<string, string>) => api.post<T>(url, body, { headers }).then((r) => r.data);
const patch = <T,>(url: string, body?: unknown) => api.patch<T>(url, body).then((r) => r.data);

export const frontDeskApi = {
  customers: (params: object) => get('/customers', params),
  customer: (id: string) => get(`/customers/${id}`),
  createCustomer: (body: object) => post('/customers', body),
  updateCustomer: (id: string, body: object) => patch(`/customers/${id}`, body),
  revealPhone: (id: string) => post<{ phone: string }>(`/customers/${id}/reveal`),
  addNote: (id: string, body: object) => post(`/customers/${id}/notes`, body),
  history: (id: string, type?: string) => get(`/customers/${id}/history`, { type }),
  merge: (keepId: string, duplicateId: string) => post(`/customers/${keepId}/merge`, { duplicateId }),
  exportCustomers: () => api.get('/customers/export', { responseType: 'blob' }).then((r) => r.data as Blob),

  calendar: (branchId: string, from: string, to?: string) => get(`/branches/${branchId}/appointments`, { from, to }),
  availability: (branchId: string, serviceId: string, date: string, stepMin = 15) => get(`/branches/${branchId}/availability`, { serviceId, date, stepMin }),
  book: (branchId: string, body: object) => post(`/branches/${branchId}/appointments`, body),
  walkIn: (branchId: string, body: object) => post(`/branches/${branchId}/walk-in`, body),
  reschedule: (id: string, body: { lines?: object[]; notes?: string; __v: number }) => patch(`/appointments/${id}`, body),
  setStatus: (id: string, status: string, reason?: string) => patch(`/appointments/${id}/status`, { status, reason }),
  block: (branchId: string, body: object) => post(`/branches/${branchId}/staff-blocks`, body),
  unblock: (branchId: string, blockId: string) => api.delete(`/branches/${branchId}/staff-blocks/${blockId}`),

  previewBill: (branchId: string, draft: object) => post(`/branches/${branchId}/bills/preview`, draft),
  createBill: (branchId: string, draft: object, idempotencyKey: string) => post(`/branches/${branchId}/bills`, draft, { 'Idempotency-Key': idempotencyKey }),
  bills: (branchId: string, params: object) => get(`/branches/${branchId}/bills`, params),
  bill: (id: string) => get(`/bills/${id}`),
  invoicePdf: (id: string, format: 'a4' | 'thermal' = 'a4') => api.get(`/bills/${id}/pdf`, { params: { format }, responseType: 'blob' }).then((r) => r.data as Blob),
  approvals: (branchId?: string) => get('/approvals', { branchId }),
  decide: (id: string, decision: 'approve' | 'reject', reason?: string) => post(`/bills/${id}/decide`, { decision, reason }),
  editBill: (id: string, body: object) => patch(`/bills/${id}`, body),
  cancelBill: (id: string, reason: string) => post(`/bills/${id}/cancel`, { reason }),
  refundBill: (id: string, body: { amountPaise: number; mode: 'cash' | 'upi' | 'card'; reason: string }) => post(`/bills/${id}/refund`, body),
  dues: (customerId: string) => get(`/customers/${customerId}/dues`),
  collectDues: (branchId: string, body: object) => post(`/branches/${branchId}/due-receipts`, body),
};

export const moneyStockApi = {
  plans: (params?: object) => get('/plans', params),
  createPlan: (body: object) => post('/plans', body),
  customerPlans: (customerId: string) => get(`/customers/${customerId}/plans`),
  wallet: (customerId: string) => get(`/customers/${customerId}/wallet`),
  loyalty: (customerId: string) => get(`/customers/${customerId}/loyalty`),
  voucher: (code: string) => get(`/vouchers/${encodeURIComponent(code)}`),
  stock: (branchId: string, params?: object) => get(`/branches/${branchId}/stock`, params),
  movements: (branchId: string, params?: object) => get(`/branches/${branchId}/stock/movements`, params),
  adjust: (branchId: string, body: object) => post(`/branches/${branchId}/stock/adjust`, body),
  purchaseOrders: (params?: object) => get('/purchase-orders', params),
  purchaseOrder: (id: string) => get(`/purchase-orders/${id}`),
  createPo: (body: object) => post('/purchase-orders', body),
  decidePo: (id: string, decision: 'approve' | 'reject', reason?: string) => post(`/purchase-orders/${id}/decide`, { decision, reason }),
  receivePo: (id: string, items: object[]) => post(`/purchase-orders/${id}/receive`, { items }),
  transfers: (params?: object) => get('/transfers', params),
  createTransfer: (body: object) => post('/transfers', body),
  transferStep: (id: string, step: 'approve' | 'dispatch') => post(`/transfers/${id}/${step}`),
  receiveTransfer: (id: string, items: object[]) => post(`/transfers/${id}/receive`, { items }),
  expenses: (branchId: string, params: object) => get(`/branches/${branchId}/expenses`, params),
  addExpense: (branchId: string, body: object) => post(`/branches/${branchId}/expenses`, body),
  closure: (branchId: string, date: string) => get(`/branches/${branchId}/closures/${date}`),
  submitClosure: (branchId: string, date: string, body: object) => post(`/branches/${branchId}/closures/${date}/submit`, body),
  approveClosure: (branchId: string, date: string) => post(`/branches/${branchId}/closures/${date}/approve`),
  reopenClosure: (branchId: string, date: string, reason: string) => post(`/branches/${branchId}/closures/${date}/reopen`, { reason }),
};
```

### 18.2 New-bill screen essentials

```tsx
// One key per bill being written; a retry or double tap sends the same key and gets the same bill
const [idempotencyKey] = useState(() => crypto.randomUUID());

const preview = useQuery({
  queryKey: ['bill-preview', branchId, debouncedDraft],
  queryFn: () => frontDeskApi.previewBill(branchId, debouncedDraft),
  enabled: debouncedDraft.lines.length > 0,
});

const save = useMutation({
  mutationFn: () => frontDeskApi.createBill(branchId, draft, idempotencyKey),
  onSuccess: (bill) => {
    queryClient.invalidateQueries({ queryKey: ['bills', branchId] });
    queryClient.invalidateQueries({ queryKey: ['calendar', branchId] });
    if (bill.status === 'awaiting_approval') notify.info('Sent for approval');
    else navigate(`/bills/${bill._id}?print=1`);
  },
});

// Remaining = preview.payablePaise - sum(payments). Disable Save while it's negative (overpaid).
// A positive remainder is allowed: it becomes a due (and approval for non-owners).
```

Print the invoice:

```ts
const blob = await frontDeskApi.invoicePdf(billId, isThermalPrinter ? 'thermal' : 'a4');
const url = URL.createObjectURL(blob);
window.open(url, '_blank'); // or set it as an <iframe> src and call iframe.contentWindow.print()
```

### 18.3 Calendar layout

- **Columns:** one column per entry in `staff`.
- **Blocks:** each appointment *line* becomes a block in its stylist's column, from `start` to `end` (convert with `istTime`).
- **Colour:** by `status`.
- **Grey areas:** outside branch hours, outside the stylist's roster (override for the date, else `weekly`), approved `leaves`, and `staffBlocks`.
- **Drag to move:** a drag calls `reschedule` with the appointment's `__v`. On `409 SLOT_CLASH`, snap back and show `error.message`; on `VERSION_CONFLICT`, refetch.
- **Refresh:** refetch the calendar after a booking or status change (or poll `GET /changes`, which comes in a later phase).

### 18.4 Cache invalidation (Phases 2–3)

| After | Invalidate |
| --- | --- |
| customer create, edit, note or merge | `['customers']`, `['customer', id]` |
| booking, reschedule, status, block, walk-in | `['calendar', branchId]`, `['availability', branchId]` |
| bill create, approve, edit, cancel or refund | `['bills', branchId]`, `['bill', id]`, `['approvals']`, `['customer', customerId]`, `['stock', branchId]`, `['closure', branchId, date]`, `['calendar', branchId]` (when linked) |
| due receipt | `['dues', customerId]`, `['customer', customerId]`, `['closure', branchId, date]` |
| plan sale or redemption | `['customer-plans', customerId]`, `['wallet', customerId]`, `['loyalty', customerId]` |
| PO, transfer or audit step | `['purchase-orders']`, `['transfers']`, `['stock', branchId]` |
| expense or petty cash | `['expenses', branchId]`, `['closure', branchId, date]` |

---

## 19. Backend changes for Phases 2–3 (2026-10-29)

| Area | Change |
| --- | --- |
| Routing (report #1) | Feature routers' guards run only for their own routes: branch logins reach stock, day-end, inbox and notifications again; the public webhook needs no token. A Super Admin token on salon routes → 403 (not 500). Managers mark attendance without a flag (the flag is for branch logins). Managers can read their branches' audit log |
| Indexes (report #3) | The app builds the schema indexes on connect when `DB_AUTO_INDEX=true` (on in tests). `scripts/check-duplicates.ts` (read-only) and `scripts/build-indexes.ts` were added. The voucher-code index is now partial (the compound sparse one allowed only one non-voucher plan per business) |
| Customers | Merge moves in the right direction (`POST /customers/:id/merge` added) and moves dues, receipts and leads too; `altPhones` saved; an edited phone is normalised; real date validation; responses masked for staff; plain-text search; `tags`; history 404 and limits; export owner only; a parallel duplicate phone → 409 `DUPLICATE_PHONE`; non-phone input → 400 |
| Calendar | Clashes checked per line (including two lines of one booking); eligibility by service *and* staff; customer must belong to the business; "any available" skips receptionists and managers; walk-in fixed; `billed` only via a bill; staff blocks validated and branch-checked; branch scoping by id. New: availability, reschedule, a richer calendar response, SRS path aliases |
| Billing | Staff on lines are checked, names snapshotted, commission falls back to the staff member's own, product commission works, slab commission works, splits never overpay; services hidden in a branch can't be billed; consumable and product cost recorded; membership discounts services only; the server values loyalty and vouchers; overpayment rejected; collected dues must be paid; Idempotency-Key honoured (also under races); manager `maxDiscountBps` and owner alerts; approve, reject, cancel, refund, edit and view scoped to the user's branches; `decision` validated; edit works (#7) with full reversal; cancel reverses stats, the day's totals, loyalty, dues collected and sold plans/credit; held and rejected bills handled; refunds counted on their own day; due receipts capped and counted in the day's takings; preview without a customer. New: invoice PDF (A4 and thermal) |
| Plans | Selling works (the plan lookup used to crash), validity uses business dates, vouchers get unique `GV-` codes, the last-session race is safe, expired and out-of-branch plans are refused, used vouchers are refused, plan creation is validated by type and owner-only, price is immutable, invalid changes → 422, expired plans shown as expired. New: `GET /customers/:id/wallet`, `/loyalty` |
| Stock | Pool must match the product type; costs are rounded totals; PO vendor and products checked, branch scope, no over-receiving, vendor bill status derived; transfers checked (business, pools, sender approves, receiver receives, full and justified receipts); stock audits fixed (wrong arguments, pool-specific sheet, variance applied once, manager approval); stock list carries reorder level, a low flag and value. New: `GET /purchase-orders/:id` |
| Money | Expenses were ignored by day-end and the list (a `deletedAt` bug); opening cash defaults to the branch float; refunded bills' payments still count; refunds count on their own day; note counts must add up; submit, approve and reopen follow the lifecycle; an approved day blocks expenses and petty cash (409); till expenses must be cash; manager branch scope |
| Platform | A malformed id → 400; a Redis hiccup no longer fails a bill or booking (change counters are best-effort); real PDFs via `pdfkit` |

Tests: [tests/integration/frontdesk.test.ts](../tests/integration/frontdesk.test.ts) (28) and [tests/integration/plans-stock-money.test.ts](../tests/integration/plans-stock-money.test.ts) (15), plus every earlier spec test in these areas. Full suite at the end of Phase 3: **618 of 680 passing**. The remaining 62 are Phase 4 and later: reports and dashboard, payroll, leads and WhatsApp, background workers and auth hardening.

---

# Part 4: Insights and Payroll (Phase 4)

## 20. Who can do what (Phase 4)

| Action | Owner | Manager | Branch login |
| --- | --- | --- | --- |
| Dashboard | ✅ all branches or one | ✅ own branches | ✅ own branch |
| Reports + Excel export | ✅ all branches or one | ✅ own branches only | ❌ |
| Audit log: view | ✅ | ✅ own branches | ❌ |
| Audit log: export | ✅ | ❌ | ❌ |
| Payroll: view, create or regenerate a draft, adjust, review, payslips | ✅ | ✅ own branches, **with `viewPayroll`** | ❌ |
| Payroll: lock, mark paid | ✅ | ❌ | ❌ |

`?branchId=` of a branch you can't access → `403 "You do not have access to this branch"`.

---

## 21. Dashboard: `GET /dashboard?branchId=`

Without `branchId`: an owner gets **all branches combined**, a manager their branches, a branch login its own branch. Pass `branchId` for one branch. Everything is for today (IST), except `mtd` and `last7Days`.

```json
{
  "date": "2026-10-29",
  "branchIds": null,
  "today": {
    "salesPaise": 580000, "totalPaise": 580000, "billsCount": 3, "customersCount": 3, "newCustomersCount": 3,
    "avgTicketSizePaise": 193333,
    "appointmentsCount": 0, "appointmentsByStatus": {},
    "collections": { "cash": 250000, "upi": 260000, "card": 0, "wallet": 0 }
  },
  "mtd": { "from": "2026-10-01", "salesPaise": 580000, "totalPaise": 580000, "billsCount": 3 },
  "last7Days": [
    { "date": "2026-10-23", "salesPaise": 0, "billsCount": 0 },
    "… 24th to 28th, all 0 …",
    { "date": "2026-10-29", "salesPaise": 580000, "billsCount": 3 }
  ],
  "topServicesToday": [{ "name": "Hair Spa", "count": 1, "netPaise": 120000 }, { "name": "Haircut (Women)", "count": 1, "netPaise": 60000 }],
  "pendingApprovalsCount": 0,
  "lowStockCount": 0,
  "openDuesPaise": 70000,
  "unreadWaCount": 0
}
```

| Field | Meaning |
| --- | --- |
| `salesPaise` | net sales: after discounts, **before GST** (the number to compare day to day) |
| `totalPaise` | what customers were billed (with GST) |
| `collections` | money taken today by mode, including dues collected today |
| `newCustomersCount` | customers whose first ever visit is today |
| `appointmentsByStatus` | e.g. `{ "booked": 4, "completed": 6 }`; only statuses that occur appear |
| `last7Days` | always 7 entries, oldest first (use it for the sparkline) |
| `pendingApprovalsCount` | held bills; link to the approvals screen |
| `lowStockCount` | stock rows at or below their reorder level (§16.2) |
| `openDuesPaise` | money customers still owe |

Only sales that happened are counted: held, rejected and cancelled bills are not. Poll this every minute or so, or refetch after billing.

---

## 22. Reports

### 22.1 How reports work

`GET /reports/:name?branchId=&from=&to=`

| Rule | Detail |
| --- | --- |
| Dates | `from` and `to` (`YYYY-MM-DD`, IST); default today; at most 366 days; `to` ≥ `from` |
| Branches | no `branchId` = all the branches you can access |
| Money | integer paise, like everywhere else |
| Response | `{ "report", "from", "to", "branchIds", "summary": {…}, "rows": [ … ] }`; some reports add extra keys (below) |
| Counted as a sale | bills that are paid, part-paid or refunded (refunds appear separately on the day they're paid out). Held, rejected and cancelled bills are not sales |
| Unknown name | `404` with `details.reports` (the valid names) |

**Excel:** `GET /reports/:name/export?branchId=&from=&to=` returns an `.xlsx` (`Content-Disposition: attachment; filename="sales-summary_2026-10-29.xlsx"`).
- **Sheets:** a *Summary* sheet plus the rows; some reports have several sheets.
- **Money columns** are in rupees, headed e.g. `Net (Rs.)`.
- **Download** with `responseType: 'blob'`.

### 22.2 The 13 reports

| `name` | What it answers | `rows` (one per…) | Extra keys |
| --- | --- | --- | --- |
| `sales-summary` | How much did we sell and collect each day? | day: bills, customers, gross, discount, net, tax, total, services/products/plans, tips, cash/upi/card/wallet, duesCollected, refunds | `summary` = totals + `avgTicketPaise` |
| `branch-comparison` | Which branch performs best? | branch (all branches, even with no sales): bills, customers, net, total, services/products/plans, avgTicket | — |
| `service-profitability` | What do services really earn? | service: count, gross, discount, net, **commission**, **consumable cost**, **margin** | `summary.marginPaise` |
| `product-profitability` | What do products really earn? | product sold: qty, net, **cost of goods**, commission, margin, stock now | `summary.marginPaise` |
| `customer-retention` | Who came, who was new? | customer (by spend): visits, spend, firstVisit, new | `summary`: customers, newCustomers, returningCustomers, retentionPct, lapsedCustomers (no visit for 60+ days) |
| `membership-liability` | What do we still owe in prepaid services or credit? (today, no dates) | type: wallet, package (with unused sessions), voucher, membership | `summary.liabilityPaise`, `asOf` |
| `staff-performance` | Who sold what? | staff member: services count, service sales (their split share), product sales, commission, tips | — |
| `attendance-payroll` | Attendance and pay by staff member | staff: present/late/halfDay/absent/leave/weekOff/holiday, overtimeMin, payroll net and status | `runs` (the payroll runs of those months) |
| `inventory-valuation` | What is our stock worth? (today) | branch × product × pool: qty, useUnit, unit cost (per use unit), value | `summary`: retail, consumable, total, negativeLines |
| `discounts-cancellations` | Where is money leaking? | discounted bill: invoice, billedBy, gross, discount, discount % | `byBilledBy`, `sheets` (Discounts, Cancellations, Refunds) |
| `expenses-pnl` | Did we make money? | P&L line items (revenue, refunds, product cost, consumables, gross profit, commission, salaries, each expense category, net profit) | `summary` with each figure |
| `day-closures` | Did the cash tally? | day × branch: status, expected/counted/diff for cash, UPI and card, diff reason, times reopened | `summary.cashDiffPaise` |
| `gstr-1` | GST filing data (GST businesses only; otherwise `422`) | invoice: date, taxable, CGST, SGST, total | `gstin`, `b2b` (empty for now: customer GSTINs aren't captured yet), `b2cs` (by rate), `hsn` (HSN/SAC summary), `sheets` |

`leads-conversion` and `whatsapp-spend` also exist; they belong to the later Leads and WhatsApp phases.

### 22.3 Real responses

**`sales-summary`** (one day):

```json
{
  "report": "sales-summary", "from": "2026-10-29", "to": "2026-10-29", "branchIds": null,
  "summary": { "bills": 3, "customers": 3, "grossPaise": 580000, "discountPaise": 0, "netPaise": 580000, "taxPaise": 0, "totalPaise": 580000, "servicesPaise": 180000, "productsPaise": 50000, "plansPaise": 350000, "tipsPaise": 0, "cashPaise": 250000, "upiPaise": 260000, "cardPaise": 0, "walletPaise": 0, "duesCollectedPaise": 0, "refundsPaise": 0, "avgTicketPaise": 193333 },
  "rows": [{ "date": "2026-10-29", "bills": 3, "customers": 3, "grossPaise": 580000, "netPaise": 580000, "servicesPaise": 180000, "productsPaise": 50000, "plansPaise": 350000, "cashPaise": 250000, "upiPaise": 260000, "…": "…" }]
}
```

**`service-profitability`**:

```json
{ "summary": { "netPaise": 180000, "marginPaise": 162000 },
  "rows": [
    { "serviceId": "6ae336059e995146b4148b9d", "name": "Hair Spa", "count": 1, "grossPaise": 120000, "discountPaise": 0, "netPaise": 120000, "commissionPaise": 12000, "consumableCostPaise": 0, "marginPaise": 108000 },
    { "serviceId": "6ae336059e995146b4148b91", "name": "Haircut (Women)", "count": 1, "grossPaise": 60000, "discountPaise": 0, "netPaise": 60000, "commissionPaise": 6000, "consumableCostPaise": 0, "marginPaise": 54000 }
  ] }
```

**`product-profitability`**: `{ "name": "Argan Shampoo", "qty": 1, "netPaise": 50000, "costPaise": 30000, "commissionPaise": 2500, "marginPaise": 17500, "stockQty": 39 }`.

**`staff-performance`**: `{ "name": "Sameer Khan", "designation": "senior_stylist", "branch": "Test Branch", "services": 1, "serviceSalesPaise": 120000, "productSalesPaise": 50000, "commissionPaise": 14500, "tipsPaise": 0 }`.

**`membership-liability`**:

```json
{ "asOf": "2026-10-29", "summary": { "liabilityPaise": 150000 },
  "rows": [
    { "type": "wallet", "count": 0, "liabilityPaise": 0 },
    { "type": "package", "count": 1, "liabilityPaise": 150000, "unusedSessions": 6 },
    { "type": "voucher", "count": 0, "liabilityPaise": 0 },
    { "type": "membership", "count": 1, "liabilityPaise": 0 }
  ] }
```

**`inventory-valuation`**: `summary { "retailPaise": 1170000, "consumablePaise": 1000000, "totalPaise": 2170000, "negativeLines": 0 }`, with rows like `{ "name": "Argan Shampoo", "branch": "Test Branch", "pool": "retail", "qty": 19, "useUnit": "bottle", "unitCostPaise": 30000, "valuePaise": 570000 }`. The unit cost is per **use unit**: a ₹500 tube of 100 ml is ₹5 per ml.

**`expenses-pnl`**:

```json
{ "summary": { "revenuePaise": 580000, "refundsPaise": 0, "productCostPaise": 30000, "consumableCostPaise": 0, "grossProfitPaise": 550000, "commissionPaise": 20500, "salariesPaise": 0, "expensesPaise": 25000, "netProfitPaise": 504500 },
  "rows": [
    { "item": "Revenue (net of discounts, before GST)", "amountPaise": 580000 },
    { "item": "Refunds paid", "amountPaise": 0 },
    { "item": "Cost of products sold", "amountPaise": -30000 },
    { "item": "Consumables used in services", "amountPaise": 0 },
    { "item": "Gross profit", "amountPaise": 550000 },
    { "item": "Staff commission", "amountPaise": -20500 },
    { "item": "Salaries (locked payroll runs in these months)", "amountPaise": 0 },
    { "item": "Expense: tea_snacks", "amountPaise": -25000 },
    { "item": "Net profit", "amountPaise": 504500 }
  ] }
```

- **Salaries** come from **locked or paid** payroll runs for the months the range touches (salary + overtime + incentives; commission is already counted above).
- **Avoid double counting:** don't enter salaries as expenses too.

**`customer-retention`**: `summary { "customers": 3, "newCustomers": 3, "returningCustomers": 0, "retentionPct": 0, "lapsedCustomers": 0 }`, with rows `{ "name": "Priya Shah", "visits": 1, "spendPaise": 260000, "firstVisit": "2026-10-29", "new": true }`.

**`gstr-1`** (GST business):
- **`summary`:** `{ invoices, taxablePaise, cgstPaise, sgstPaise }`.
- **`b2cs`:** `[{ "ratePct": 18, "taxablePaise": 100000, "cgstPaise": 9000, "sgstPaise": 9000 }]`.
- **`hsn`:** `[{ "hsnSac": "9983", "ratePct": 18, "qty": 1, "taxablePaise": 100000, "cgstPaise": 9000, "sgstPaise": 9000 }]`.
- **`rows`:** one per invoice.
- **GST off** → `422 "GSTR-1 is only available when GST is enabled for the business"`.

### 22.4 Building the reports screen

1. A report picker, a branch picker ("All branches" + `me.branches`) and a date range (presets: today, this week, this month, last month, this financial year from `settings.fyStartMonth`).
2. `GET /reports/:name` → show `summary` as KPI cards and `rows` as a table. Column headers can be generated from the keys: `netPaise` → "Net", shown with `rupees()`.
3. An **Export** button → `/reports/:name/export` with the same query, saved as a file.

---

## 23. Audit log

**`GET /audit-logs?from=&to=&branchId=&userId=&action=&entity=&entityId=&page=&limit=`** (owner; managers see their branches):

```json
{
  "logs": [
    {
      "_id": "6ae336069e995146b4148d08",
      "at": "2026-10-29T12:03:18.268Z",
      "actor": { "kind": "tenant", "id": "6ae33604e51828c6dfcfd65b", "role": "owner", "name": "Test Owner" },
      "branchId": "6ae33604e51828c6dfcfd651", "billedByName": "Riya Mehta",
      "action": "bill.create", "entity": "bill", "entityId": "6ae336069e995146b4148cf8",
      "after": { "invoiceNo": "TST1/2026-27/000003", "totalPaise": 170000, "status": "partly_paid" },
      "businessId": "6ae33604e51828c6dfcfd64e", "__v": 0
    }
  ],
  "total": 3
}
```

- **Entry fields:** `before` / `after` hold the changed values and `reason` the stated reason.
- **Filters:** `userId` filters by the person who acted; `action` matches exactly; `limit` max 100, newest first.
- **Common actions:**
  - bills: `bill.create`, `bill.edit`, `bill.cancel`, `bill.refund`, `bill.approve`, `bill.reject`;
  - appointments: `appointment.create`, `appointment.reschedule`, `appointment.status_*`;
  - customers: `customer.update`, `customer.merge`, `customer.phone_reveal`, `customer.export`;
  - settings and catalogue: `business.settings_update`, `branch.update`, `service.update`, `service.branch_price_update`;
  - staff and payroll: `staff.updated`, `attendance.marked`, `payroll.locked`;
  - stock and money: `stock.adjusted`, `day_closure.approved`;
  - logins: `user.password_set`.
- **Append-only:** entries can never be changed or deleted, by anyone.
- **`GET /audit-logs/export`** (owner): the same filters, up to 5,000 rows, as an Excel file (`audit-log.xlsx`).

---

## 24. Payroll

### 24.1 Lifecycle

`draft` → `reviewed` → `locked` → `paid`

| Step | Endpoint | Who | What happens |
| --- | --- | --- | --- |
| Create or regenerate | `POST /branches/:branchId/payroll-runs` `{ "month": "2026-10" }` | owner, manager* | Calculates every line (below). Running it again for the same month **recalculates** a draft or reviewed run (back to `draft`). Future month → 422; a locked or paid month → `409 PAYROLL_LOCKED` |
| Adjust | `PATCH /payroll-runs/:id/adjust-line` | owner, manager* | Bonus, deduction or correction on one line, with a reason (draft or reviewed only) |
| Review | `POST /payroll-runs/:id/review` | owner, manager* | `draft` → `reviewed`; payslips can now be generated (marked PROVISIONAL until locked) |
| Lock | `POST /payroll-runs/:id/lock` | owner | Freezes the month (below) |
| Mark paid | `POST /payroll-runs/:id/mark-paid` | owner | Records payment per staff member; `paid` when everyone is |

\* Managers need the `viewPayroll` flag, and only see their branches.

### 24.2 How a line is calculated

| Part | Rule |
| --- | --- |
| Paid days | days employed in the month (from the joining date, up to the exit date), minus absent days, minus ½ for each half day, minus approved **unpaid** leave. Days with no attendance record count as worked |
| `salaryPaise` | monthly salary × paid days ÷ days in the month (`salary.type: "none"` → 0) |
| `commissionPaise` | from this month's sales bills of the branch (cancelled bills don't count) |
| `tipsPaise` | tips with `payout: "payroll"` (cash tips were already paid at the counter) |
| `overtimePaise` | rostered overtime (§7) at `overtimePerHourPaise`, in half-hour steps |
| `incentivesPaise` | 0; add it with adjust-line |
| `advancePaise` | open salary advances, up to each one's `recoveryPerMonthPaise` |
| `pfPaise` | only when **business** PF is on **and** the staff member's `statutory.pf` is on: `employeePct` % of the salary, capped at `wageCeilingPaise` (12% of ₹15,000 = ₹1,800) |
| `esiPaise` | business ESI on and staff `statutory.esi` on, and gross ≤ the ESI wage ceiling: `employeePct` % of gross (salary + commission + overtime) |
| `ptPaise` | business PT on and staff `statutory.pt` on: the amount of the first slab whose `uptoPaise` covers the gross |
| `netPaise` | earnings (salary + commission + overtime + tips + incentives) − deductions (advance + PF + ESI + PT + other) |

Run `totals`: `{ grossPaise, deductionsPaise, netPaise }`.

### 24.3 Endpoints and responses

**`POST /branches/:branchId/payroll-runs`** → **201**:

```json
{
  "_id": "6ae336069e995146b4148d3e", "branchId": "6ae33604e51828c6dfcfd651", "month": "2026-10", "status": "draft",
  "generatedAt": "2026-10-29T12:03:18.301Z",
  "totals": { "grossPaise": 10020500, "deductionsPaise": 0, "netPaise": 10020500 },
  "lines": [
    { "staffId": "6ae336069e995146b4148bea", "staffName": "Neha Joshi", "paidDays": 31,
      "salaryPaise": 2200000, "commissionPaise": 0, "overtimePaise": 0, "tipsPaise": 0, "incentivesPaise": 0,
      "advancePaise": 0, "pfPaise": 0, "esiPaise": 0, "ptPaise": 0, "otherDeductionPaise": 0, "netPaise": 2200000, "adjustments": [] },
    { "staffId": "6ae336059e995146b4148bcc", "staffName": "Sameer Khan", "paidDays": 31,
      "salaryPaise": 3500000, "commissionPaise": 14500, "overtimePaise": 0, "tipsPaise": 0, "incentivesPaise": 0,
      "advancePaise": 0, "pfPaise": 0, "esiPaise": 0, "ptPaise": 0, "otherDeductionPaise": 0, "netPaise": 3514500, "adjustments": [] }
  ]
}
```

Each line also has its own `_id`. A bad month → `400 {"fields":{"month":"month must be YYYY-MM"}}`; a future month → `422`; a locked month → `409 PAYROLL_LOCKED "Payroll for 2026-10 is already locked"`.

**`GET /branches/:branchId/payroll-runs?year=2026`** lists the runs, newest month first, **without lines** (`_id`, `month`, `status`, `totals`, `generatedAt`, plus `lockedAt` once locked). **`GET /payroll-runs/:id`** returns the full run with lines. Another branch's run is a 404 for a manager.

**`PATCH /payroll-runs/:id/adjust-line`**:

```json
{ "staffId": "6ae336059e995146b4148bcc", "field": "incentivesPaise", "deltaPaise": 100000, "reason": "Diwali bonus" }
```

- **`field`:** one of `salaryPaise`, `commissionPaise`, `overtimePaise`, `tipsPaise`, `incentivesPaise`, `advancePaise`, `pfPaise`, `esiPaise`, `ptPaise` or `otherDeductionPaise`.
- **`deltaPaise`:** non-zero and signed; the field can't go below 0 (422).
- **200:** the run, with totals updated and the change added to the line's `adjustments`, e.g. `{ "field": "incentivesPaise", "deltaPaise": 100000, "reason": "Diwali bonus", "by": "<userId>", "at": "2026-10-29T12:03:19.829Z" }`. Sameer's net went from 3514500 to 3614500.
- **Locked or paid run** → `422`.

**`POST /payroll-runs/:id/lock`**:
- **Stale check:** if any bill or attendance of that branch and month changed after `generatedAt`, the lock is refused with `409 {"error":{"code":"PAYROLL_STALE","message":"Bills changed after this draft was generated. Regenerate the draft, then lock it."}}` (the message says "Attendance" instead when attendance changed). Regenerate the draft (POST again), then lock.
- **On lock:** advances are marked recovered, and the month's **bills are frozen**: editing or cancelling them returns `409 PAYROLL_LOCKED`. Refunds still work.

**`POST /payroll-runs/:id/mark-paid`**:

```json
{ "staffIds": ["6ae336059e995146b4148bcc"], "mode": "upi", "date": "2026-10-31" }
```

- **Fields:** leave out `staffIds` to pay everyone left. `mode` is `bank` (the default), `cash`, `upi` or `cheque`. `date` is required.
- **Result:** each paid line gets `"paid": { "mode": "upi", "date": "2026-10-31" }`. The run stays `locked` until every line is paid, then becomes `paid`.
- **Not locked** → `422 "Lock the run before marking it paid"`; already paid → `422 "This run is already paid"`.

### 24.4 Payslips

- **`POST /payroll-runs/:id/payslips`** (reviewed, locked or paid; a draft → `422 "Review the run before generating payslips"`) generates every payslip. Each record also has `pdfKey`, `businessId` and timestamps:

```json
[{ "_id": "6ae33607561a688cfc007aeb", "runId": "6ae336069e995146b4148d3e", "staffId": "6ae336069e995146b4148bea", "staffName": "Neha Joshi", "month": "2026-10", "netPaise": 2200000, "downloadPath": "/payroll-runs/6ae336069e995146b4148d3e/payslips/6ae336069e995146b4148bea/pdf" }]
```

- **`GET /payroll-runs/:id/payslips/:staffId/pdf`** returns the payslip PDF (`Content-Disposition: inline; filename="payslip-2026-10-Sameer-Khan.pdf"`). It is generated from the run, so it always matches its current figures:
  - **Contents:** business and branch, employee details (designation, joining date, bank last 4 digits), paid days, earnings, deductions, gross, net, payment date and mode, and adjustments with reasons.
  - **Before the lock:** stamped **PROVISIONAL**.
  - **Fetching it:** `api.get(path, { responseType: 'blob' })`.
- **Sending payslips** on WhatsApp comes with the WhatsApp phase.

### 24.5 Payroll screen flow

1. Pick a branch and month. `GET /branches/:id/payroll-runs?year=` shows the status per month, and **Generate** calls the POST.
2. Show the lines as a table (staff × earnings and deductions, with net) and the totals.
3. **Adjust:** each row gets an "Adjust" action with a field, amount and reason.
4. **Review**, then **Payslips** (preview a PDF), then **Lock** (owner).
5. On `PAYROLL_STALE`, offer "Regenerate", which calls the POST again and keeps the run's id.
6. **Mark paid:** tick the staff paid, choose a mode and date, and save. Repeat until the run shows `paid`.

### 24.6 React snippets

```ts
export const insightsApi = {
  dashboard: (branchId?: string) => get('/dashboard', { branchId }),
  report: (name: string, params: { branchId?: string; from: string; to: string }) => get(`/reports/${name}`, params),
  exportReport: (name: string, params: object) => api.get(`/reports/${name}/export`, { params, responseType: 'blob' }).then((r) => r.data as Blob),
  auditLogs: (params: object) => get('/audit-logs', params),
  exportAudit: (params: object) => api.get('/audit-logs/export', { params, responseType: 'blob' }).then((r) => r.data as Blob),

  payrollRuns: (branchId: string, year?: string) => get(`/branches/${branchId}/payroll-runs`, { year }),
  payrollRun: (id: string) => get(`/payroll-runs/${id}`),
  generatePayroll: (branchId: string, month: string) => post(`/branches/${branchId}/payroll-runs`, { month }),
  adjustLine: (id: string, body: { staffId: string; field: string; deltaPaise: number; reason: string }) => patch(`/payroll-runs/${id}/adjust-line`, body),
  reviewPayroll: (id: string) => post(`/payroll-runs/${id}/review`),
  lockPayroll: (id: string) => post(`/payroll-runs/${id}/lock`),
  markPaid: (id: string, body: { staffIds?: string[]; mode: 'bank' | 'cash' | 'upi' | 'cheque'; date: string }) => post(`/payroll-runs/${id}/mark-paid`, body),
  generatePayslips: (id: string) => post(`/payroll-runs/${id}/payslips`),
  payslipPdf: (path: string) => api.get(path, { responseType: 'blob' }).then((r) => r.data as Blob),
};

// Save any Blob (Excel export, PDF) with a filename
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```

Cache invalidation:
- **Bills, refunds, expenses:** `['dashboard']` and the open report.
- **Any payroll action:** `['payroll-run', id]` and `['payroll-runs', branchId]`.
- **Lock:** also `['bills', branchId]` (those bills are now frozen).

---

## 25. Backend changes for Phase 4 (2026-10-29)

| Area | Change |
| --- | --- |
| Dashboard | Computed from the bills themselves: today and MTD sales, collections by mode, appointments by status (they used to be queried by a field that doesn't exist), pending approvals, open dues, low stock, a 7-day trend, top services. Branch scope for managers and branch logins |
| Reports | All 13 rebuilt from the source data. The date range is honoured (it used to be ignored), branch scope added (manager → 403 for other branches), service and product margins include commission and cost, staff performance credits split shares, membership liability includes packages and vouchers, stock value uses cost per use unit, P&L includes product cost, consumables, commission, salaries and expenses (expenses used to be dropped by the `deletedAt` bug), GSTR-1 has B2C-by-rate and HSN summaries and refuses GST-off businesses, unknown report → 404, range ≤ 366 days |
| Excel exports | A Summary sheet plus one sheet per table, money in rupees with readable headers, a filename with the date range |
| Audit log | Append-only at the model level; the export is a real `.xlsx` (it was mislabelled as CSV) |
| Payroll | The create and mark-paid APIs work (#8); statutory deductions follow business settings (PF ceiling, ESI ceiling, PT slabs); paid days honour joining and exit dates and unpaid leave; stale detection uses the generation time and also covers attendance; regenerating keeps the run; a locked month freezes its bills (`PAYROLL_LOCKED`); adjust-line fields are validated and can't go negative; partial mark-paid; branch scoping; run totals (gross, deductions, net). New: real payslip PDFs and `GET /payroll-runs/:id/payslips/:staffId/pdf` |

Tests: [tests/integration/insights-payroll.test.ts](../tests/integration/insights-payroll.test.ts) (20), plus all earlier report and payroll spec tests. Full suite: **652 of 700 passing**. The remaining 48 are Leads and WhatsApp (23), background workers (13), change polling, uploads and API hardening (6), and auth hardening (6), all outside the owner screens built so far.

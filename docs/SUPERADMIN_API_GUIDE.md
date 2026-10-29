# Glox Salon — Super Admin Panel APIs (Frontend Integration Guide)

Everything the Super Admin panel needs, screen by screen, with **real responses** recorded from the running backend. Login, refresh, logout, the axios client and role routing are in [AUTH_API_GUIDE.md](AUTH_API_GUIDE.md). This guide builds on that.

- **Base URL:** `VITE_API_URL` (e.g. `http://localhost:4000`). There is no `/api/v1` prefix.
- **Auth:** every `/admin/*` call needs `Authorization: Bearer <Super Admin accessToken>`.
  - No token or an expired token → `401 UNAUTHENTICATED`.
  - A salon login (owner, manager, branch) → `403 FORBIDDEN`.
- **Test login:** `superadmin@glox.test` / `Test@1234`.
- **Responses** are plain JSON (no `{ data }` wrapper). Errors are always `{ "error": { "code", "message", "fields?" } }`. For `VALIDATION_ERROR`, `fields` maps each input path (e.g. `"business.gst.gstin"`) to its message.
- **Money and percentages are integers:** `rateBps: 1800` = 18 %, `pettyCashFloatPaise: 500000` = ₹5,000.

---

## 1. Screens → endpoints

| Screen | Endpoints |
| --- | --- |
| Dashboard | `GET /admin/stats` |
| Businesses list | `GET /admin/businesses?page&limit&q&status` |
| Create business (onboarding wizard) | `POST /admin/businesses` |
| Business detail: Overview | `GET /admin/businesses/:id`, `PATCH /admin/businesses/:id` (edit, suspend, reactivate) |
| Business detail: Branches | (branches come with the detail) `POST /admin/businesses/:id/branches`, `PATCH /admin/businesses/:id/branches/:branchId/deactivate` |
| Business detail: Users | `GET /admin/businesses/:id/users?role`, `POST /admin/users/:id/password`, `POST /admin/users/:id/status` |
| Business detail: Activity | `GET /admin/audit-logs?businessId=:id` |
| Branch requests | `GET /admin/branch-requests?status`, `POST /admin/branch-requests/:id/decide` |
| Audit log (platform-wide) | `GET /admin/audit-logs` |

Build them in this order: Dashboard → Businesses list → Create business → Business detail tabs → Branch requests → Audit log.

---

## 2. Dashboard

### `GET /admin/stats`

**200**

```json
{
  "businesses": { "total": 1, "active": 1, "suspended": 0 },
  "branches": { "total": 2, "active": 2 },
  "users": { "owners": 1, "managers": 0, "branchLogins": 2 },
  "pendingBranchRequests": 0
}
```

- `branches.total` includes deactivated branches; `active` excludes them and branches with a pending deletion request.
- Use `pendingBranchRequests` for the badge on the "Branch requests" menu item.

---

## 3. Businesses list

### `GET /admin/businesses`

| Query | Type | Default | Notes |
| --- | --- | --- | --- |
| `page` | int ≥ 1 | 1 | |
| `limit` | int 1–100 | 25 | `> 100` → 400 |
| `q` | string | — | Case-insensitive "contains" search on business name, matched as plain text |
| `status` | `active` \| `suspended` | — | Anything else → 400 |

Sorted newest first. **200** (business object shortened, see §5 for the full shape):

```json
{
  "businesses": [
    {
      "_id": "6ae20ac7182a65824e091d9d",
      "name": "Glamour Studio",
      "address": { "line1": "12 MG Road", "city": "Surat", "state": "Gujarat", "pincode": "395007" },
      "gst": { "enabled": true, "gstin": "24AAAAA0000A1Z5", "pan": "AAAAA0000A", "rateBps": 1800, "sac": "9983", "pricesInclusive": false },
      "ownerWhatsappPhone": "+919800000001",
      "status": "active",
      "headBranchId": "6ae20ac7182a65824e091d9f",
      "createdAt": "2026-10-28T14:46:31.023Z",
      "owner": { "_id": "6ae20ac7182a65824e091da9", "name": "Olivia Shah", "email": "olivia@glamour.in", "phone": "+919800000011", "status": "active" },
      "branchCount": 2
    }
  ],
  "total": 1
}
```

- `branchCount` counts branches that are not deactivated.
- `owner` is `null` if a business has no owner.
- Pages: `Math.ceil(total / limit)`.

---

## 4. Create business (onboarding)

### `POST /admin/businesses`

Creates the business, its head branch, the owner login and the head branch's login in **one transaction**. If any step fails, nothing is saved, so the form can simply be resubmitted.

**Request**

```json
{
  "business": {
    "name": "Glamour Studio",
    "address": { "line1": "12 MG Road", "line2": "Near City Mall", "city": "Surat", "state": "Gujarat", "pincode": "395007" },
    "gst": { "enabled": true, "gstin": "24AAAAA0000A1Z5", "pan": "AAAAA0000A", "rateBps": 1800, "sac": "9983", "pricesInclusive": false },
    "fyStartMonth": 4,
    "discountLimits": { "managerBps": 2000, "branchBps": 1000, "ownerAlertBps": 2500 },
    "dayEndReportTime": "23:00",
    "ownerWhatsappPhone": "+919800000001"
  },
  "owner": { "name": "Olivia Shah", "email": "olivia@glamour.in", "phone": "+919800000011", "password": "Owner@123" },
  "headBranch": {
    "name": "Vesu", "code": "SRT1", "invoicePrefix": "SRT1",
    "address": { "line1": "12 MG Road", "city": "Surat", "state": "Gujarat", "pincode": "395007" },
    "phone": "+919800000002",
    "loginEmail": "vesu@glamour.in", "loginPassword": "Branch@123"
  }
}
```

| Field | Rule |
| --- | --- |
| `business.address.pincode` | exactly 6 characters |
| `business.gst` | required object. `gstin` is required when `enabled: true`. `rateBps`, `sac` and `pricesInclusive` default to 1800, `"9983"` and `false` |
| `business.discountLimits` | required object (may be `{}`). Defaults 2000 / 1000 / 2500 bps |
| `business.fyStartMonth` | 1–12, default 4 (April) |
| `business.dayEndReportTime` | `HH:mm`, default `"23:00"` |
| `business.ownerWhatsappPhone` | min 10 characters |
| `owner.password`, `headBranch.loginPassword` | min 8 characters |
| `headBranch.code`, `invoicePrefix` | upper-cased by the server |
| `headBranch.phone` | min 10 characters |
| emails | `owner.email` ≠ `headBranch.loginEmail`, and both must be unused by any login on the platform |

**201** (shortened; full objects as in §5):

```json
{
  "business": { "_id": "6ae20ac7182a65824e091d9d", "name": "Glamour Studio", "status": "active", "headBranchId": "6ae20ac7182a65824e091d9f", "...": "..." },
  "owner": { "_id": "6ae20ac7182a65824e091da9", "role": "owner", "name": "Olivia Shah", "email": "olivia@glamour.in", "businessId": "6ae20ac7182a65824e091d9d", "status": "active" },
  "branch": { "_id": "6ae20ac7182a65824e091d9f", "name": "Vesu", "code": "SRT1", "invoicePrefix": "SRT1", "status": "active", "stations": 4, "hours": [ { "day": 0, "open": "10:00", "close": "20:00", "closed": false } ] },
  "branchLogin": { "_id": "6ae20ac7182a65824e091dab", "role": "branch", "email": "vesu@glamour.in", "branchLoginFor": "6ae20ac7182a65824e091d9f" }
}
```

No password hashes are ever returned. After success, navigate to `/admin/businesses/{business._id}`.

**Errors**

| Status | Body | Show |
| --- | --- | --- |
| 400 | `{"error":{"code":"VALIDATION_ERROR","message":"Validation failed","fields":{"business.gst.gstin":"GSTIN is required when GST is enabled"}}}` | Message under the matching input (`fields` key = input path) |
| 400 | `{"error":{"code":"VALIDATION_ERROR","message":"Owner email and branch login email must be different"}}` | Form-level error |
| 409 | `{"error":{"code":"DUPLICATE_EMAIL","message":"Email olivia@glamour.in is already in use"}}` | Under the email that the message names |
| 409 | `{"error":{"code":"ALREADY_EXISTS","message":"A record with this email already exists", ...}}` | Same as above (rare: an email in use by a login created before the fix) |

---

## 5. Business detail

### `GET /admin/businesses/:id`

**200**

```json
{
  "business": {
    "_id": "6ae20ac7182a65824e091d9d",
    "name": "Glamour Studio",
    "address": { "line1": "12 MG Road", "city": "Surat", "state": "Gujarat", "pincode": "395007" },
    "gst": { "enabled": true, "gstin": "24AAAAA0000A1Z5", "pan": "AAAAA0000A", "rateBps": 1800, "sac": "9983", "pricesInclusive": false },
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
    "headBranchId": "6ae20ac7182a65824e091d9f",
    "createdAt": "2026-10-28T14:46:31.023Z",
    "updatedAt": "2026-10-28T14:46:31.026Z",
    "__v": 0
  },
  "owner": {
    "_id": "6ae20ac7182a65824e091da9", "role": "owner", "name": "Olivia Shah", "email": "olivia@glamour.in", "phone": "+919800000011",
    "branchIds": [], "flags": { "manageStaff": false, "approvePO": false, "viewPayroll": false, "editBranchPrices": false, "markAttendance": false },
    "status": "active", "sessionVersion": 0, "failedLogins": 0, "businessId": "6ae20ac7182a65824e091d9d",
    "createdAt": "2026-10-28T14:46:31.195Z", "updatedAt": "2026-10-28T14:46:31.195Z"
  },
  "branches": [
    {
      "_id": "6ae20ac7182a65824e091d9f", "name": "Vesu", "code": "SRT1", "invoicePrefix": "SRT1",
      "address": { "line1": "12 MG Road", "city": "Surat", "state": "Gujarat", "pincode": "395007" },
      "phone": "+919800000002", "stations": 4, "pettyCashFloatPaise": 0, "status": "active",
      "hours": [ { "_id": "6ae20ac7182a65824e091da0", "day": 0, "open": "10:00", "close": "20:00", "closed": false } ],
      "holidays": [], "businessId": "6ae20ac7182a65824e091d9d", "createdAt": "2026-10-28T14:46:31.040Z"
    }
  ],
  "counts": { "managers": 0, "branchLogins": 2 }
}
```

- `branches` is ordered by creation, so the head branch comes first. Mark it using `branch._id === business.headBranchId`.
- Branch `status` is one of `active`, `deactivation_requested` or `deactivated`.
- `hours` has one entry per weekday (`day` 0 = Sunday).
- Errors: unknown id → `404 NOT_FOUND`; malformed id → `400 VALIDATION_ERROR`.

### `PATCH /admin/businesses/:id` — edit, suspend, reactivate

Send only the fields that change. It accepts the same fields as the owner's settings (`name`, `logoUrl`, `address`, `gst`, `fyStartMonth`, `discountLimits`, `dayEndReportTime`, `loyalty`, `payroll`, `automationGuards`, `ownerWhatsappPhone`) plus `status`.

```json
{ "name": "Glamour Studio & Spa" }
```

```json
{ "status": "suspended" }
```

**200**: the full business object (same shape as `business` above) with the new values.

- **Suspending** logs every user of that business out immediately (their next request returns `401 SESSION_REVOKED`). New logins get:
  `403 {"error":{"code":"ACCOUNT_INACTIVE","message":"Business account is suspended or inactive"}}`.
- **Reactivating** (`{ "status": "active" }`) lets them log in again.
- ⚠️ Nested objects are **replaced**, not merged. To change only the GST rate, send the whole `gst` object: `{ "gst": { ...business.gst, "rateBps": 500 } }`.
- Ask for confirmation before suspending.

### `POST /admin/businesses/:id/branches` — add a branch

```json
{
  "name": "Adajan", "code": "SRT2", "invoicePrefix": "SRT2",
  "address": { "line1": "5 Ring Road", "city": "Surat", "state": "Gujarat", "pincode": "395009" },
  "phone": "+919800000003",
  "loginEmail": "adajan@glamour.in", "loginPassword": "Branch@123",
  "stations": 6, "pettyCashFloatPaise": 500000
}
```

`stations` (default 4) and `pettyCashFloatPaise` (default 0) are optional.

**201**

```json
{
  "branch": { "_id": "6ae20ac7182a65824e091db5", "name": "Adajan", "code": "SRT2", "invoicePrefix": "SRT2", "status": "active", "stations": 4, "pettyCashFloatPaise": 0, "businessId": "6ae20ac7182a65824e091d9d", "hours": ["..."], "holidays": [] },
  "branchLogin": { "_id": "6ae20ac7182a65824e091dbe", "role": "branch", "name": "Adajan", "email": "adajan@glamour.in", "branchIds": ["6ae20ac7182a65824e091db5"], "branchLoginFor": "6ae20ac7182a65824e091db5", "status": "active" }
}
```

Errors:
- `404` unknown business.
- `409 DUPLICATE_EMAIL` if the login email is taken.
- `409 VERSION_CONFLICT` with `"Branch code or invoice prefix is already taken in this business"`. Show it under `code`.

### `PATCH /admin/businesses/:id/branches/:branchId/deactivate`

```json
{ "reason": "Lease ended" }
```

**200**: the branch with `"status": "deactivated"`. Its branch login is set to inactive and logged out.

The head branch can't be deactivated:
`403 {"error":{"code":"FORBIDDEN","message":"Head branch cannot be deactivated"}}`. Hide or disable the button for the head branch.

There is no "reactivate branch" endpoint yet.

### `GET /admin/businesses/:id/users` — Users tab

Optional `?role=owner|manager|branch`. **200**: an array, ordered by role (`branch`, `manager`, `owner`), then by creation.

```json
[
  {
    "_id": "6ae20ac7182a65824e091dab", "role": "branch", "name": "Vesu", "email": "vesu@glamour.in", "phone": "+919800000002",
    "branchIds": ["6ae20ac7182a65824e091d9f"], "branchLoginFor": "6ae20ac7182a65824e091d9f",
    "flags": { "markAttendance": false, "manageStaff": false, "approvePO": false, "viewPayroll": false, "editBranchPrices": false },
    "status": "active", "sessionVersion": 0, "failedLogins": 0,
    "businessId": "6ae20ac7182a65824e091d9d", "createdAt": "2026-10-28T14:46:31.357Z"
  },
  { "_id": "6ae20ac7182a65824e091da9", "role": "owner", "name": "Olivia Shah", "email": "olivia@glamour.in", "status": "active", "...": "..." }
]
```

- Useful columns: name, email, role, branch (match `branchLoginFor` or `branchIds` against the detail's `branches`), status, `lastLoginAt` (appears once they have logged in).
- `lockedUntil` in the future means the account is locked after 5 wrong passwords. Resetting the password does not clear the lock; it expires 15 minutes after the 5th attempt.

### `POST /admin/users/:id/password` — reset password

```json
{ "password": "NewPass123" }
```

**204** (empty body).

- All of that user's sessions are revoked. Tell the Super Admin to share the new password with the user.
- Rules: 8–64 characters, with at least one letter and one number. Otherwise:
  `400 {"error":{"code":"VALIDATION_ERROR","message":"Validation failed","fields":{"password":"Password must contain at least one letter and one number"}}}`.
- Unknown user → `404`.

### `POST /admin/users/:id/status` — activate or deactivate a login

```json
{ "status": "inactive" }
```

**200**: the user, without the password hash.

```json
{
  "_id": "6ae20ac7182a65824e091dbe", "role": "branch", "name": "Adajan", "email": "adajan@glamour.in",
  "status": "inactive", "sessionVersion": 1, "businessId": "6ae20ac7182a65824e091d9d", "branchLoginFor": "6ae20ac7182a65824e091db5", "...": "..."
}
```

- `inactive` logs the user out immediately; their login attempts then get `403 ACCOUNT_INACTIVE`. `active` restores access.
- The login of a deactivated branch can't be reactivated:
  `409 {"error":{"code":"BRANCH_INACTIVE","message":"Branch is deactivated; its login cannot be reactivated"}}`.
- `status` other than `active`/`inactive` → `400`.

---

## 6. Branch requests

Owners raise these from their panel (`POST /business/branch-requests`): add a new branch, or delete an existing one.

### `GET /admin/branch-requests?status=pending`

`status` can be `pending` (the default), `approved` or `rejected`. **200**:

```json
[
  {
    "_id": "6ae1e39af8b81d31daaaf3a3",
    "type": "add",
    "payload": { "name": "City Light", "address": { "line1": "3 Station Rd", "city": "Surat", "state": "Gujarat", "pincode": "395003" } },
    "reason": "Expansion",
    "status": "pending",
    "businessId": { "_id": "6ae1e39af8b81d31daaaf2b9", "name": "Glamour Studio" },
    "createdAt": "2026-10-28T11:59:22.404Z"
  },
  {
    "_id": "6ae1e39af8b81d31daaaf3b0",
    "type": "delete",
    "branchId": "6ae1e39af8b81d31daaaf2c4",
    "reason": "Lease ended",
    "status": "pending",
    "businessId": { "_id": "6ae1e39af8b81d31daaaf2b9", "name": "Glamour Studio" },
    "createdAt": "2026-10-28T12:03:10.112Z"
  }
]
```

`businessId` comes back as an object (`{ _id, name }`), not a plain id.

### `POST /admin/branch-requests/:id/decide`

`decision` must be exactly `"approve"` or `"reject"`; anything else → `400`.

| Case | Body | 200 response |
| --- | --- | --- |
| Reject | `{ "decision": "reject", "note": { "reason": "Please call us first" } }` | the request: `{ "status": "rejected", "rejectReason": "Please call us first", ... }`. For a delete request, the branch goes back to `active` |
| Approve delete | `{ "decision": "approve" }` | the request with `"status": "approved"`. The branch and its login are deactivated |
| Approve add | `{ "decision": "approve", "note": { "code": "SRT3", "invoicePrefix": "SRT3", "phone": "9800000020", "loginEmail": "citylight@glamour.in", "loginPassword": "Branch@123" } }` | `{ "request": {...}, "branch": {...}, "branchLogin": {...} }`. Name and address come from the owner's request |

- **Approving an add request:** show a small form (code, invoice prefix, phone, login email, login password). Missing or invalid fields return
  `400 {"error":{"code":"VALIDATION_ERROR","message":"Branch details are required to approve an add request","fields":{"note.code":"Required", ...}}}`.
  The same `409` errors as "add a branch" can also occur.
- **Already decided** → `409 VERSION_CONFLICT "Request has already been decided"`. Refresh the list.

Note that the two response shapes differ: approving an add returns `{ request, branch, branchLogin }`; the other cases return the request itself.

---

## 7. Audit log

### `GET /admin/audit-logs`

| Query | Notes |
| --- | --- |
| `businessId` | One business (use on the business detail "Activity" tab). Omit for the whole platform |
| `branchId`, `userId` (the actor), `action`, `entity`, `entityId` | Exact-match filters |
| `from`, `to` | `YYYY-MM-DD` |
| `page`, `limit` | `limit` max 100, default 25 |

**200**, newest first:

```json
{
  "logs": [
    {
      "_id": "6ae20ac7182a65824e091e1b",
      "actor": { "kind": "platform", "id": "6ae20ac5182a65824e091d96", "role": "super_admin", "name": "Glox Admin" },
      "businessId": "6ae20ac7182a65824e091d9d",
      "branchId": "6ae20ac7182a65824e091db5",
      "action": "branch.deactivate",
      "entity": "branch",
      "entityId": "6ae20ac7182a65824e091db5",
      "reason": "Lease ended",
      "ip": "127.0.0.1",
      "at": "2026-10-28T14:46:31.985Z"
    },
    {
      "_id": "6ae20ac7182a65824e091e00",
      "actor": { "kind": "platform", "id": "6ae20ac5182a65824e091d96", "role": "super_admin", "name": "Glox Admin" },
      "businessId": "6ae20ac7182a65824e091d9d",
      "action": "user.status_update",
      "entity": "user",
      "entityId": "6ae20ac7182a65824e091dbe",
      "before": { "status": "active" },
      "after": { "status": "inactive" },
      "at": "2026-10-28T14:46:31.965Z"
    }
  ],
  "total": 7
}
```

Super Admin actions you will see:

| `action` | Meaning |
| --- | --- |
| `business.update` | Business edited or suspended/reactivated (`after` holds the changed fields) |
| `branch.create` | Branch added |
| `branch.deactivate` | Branch deactivated (`reason`) |
| `user.status_update` | Login activated/deactivated (`before`/`after`) |
| `user.password_set` | Password reset |

---

## 8. React integration

This uses the `api` axios client from [AUTH_API_GUIDE.md §6.2](AUTH_API_GUIDE.md#62-api-client-with-automatic-refresh-axios), which already attaches the token and refreshes it.

### 8.1 API module: `src/api/admin.ts`

```ts
import { api } from './client';

export type BusinessStatus = 'active' | 'suspended';
export type UserRole = 'owner' | 'manager' | 'branch';

export interface Address { line1: string; line2?: string; city: string; state: string; pincode: string }
export interface Business {
  _id: string; name: string; address: Address; status: BusinessStatus; headBranchId?: string;
  gst: { enabled: boolean; gstin?: string; pan?: string; rateBps: number; sac: string; pricesInclusive: boolean };
  ownerWhatsappPhone: string; createdAt: string; [k: string]: unknown;
}
export interface Branch {
  _id: string; name: string; code: string; invoicePrefix: string; phone: string; address: Address;
  status: 'active' | 'deactivation_requested' | 'deactivated'; stations: number; pettyCashFloatPaise: number;
}
export interface SalonUser {
  _id: string; role: UserRole; name: string; email: string; phone?: string; status: 'active' | 'inactive';
  branchIds: string[]; branchLoginFor?: string; lastLoginAt?: string; lockedUntil?: string;
}
export interface BusinessRow extends Business {
  owner: Pick<SalonUser, '_id' | 'name' | 'email' | 'phone' | 'status'> | null;
  branchCount: number;
}

export const adminApi = {
  stats: () => api.get('/admin/stats').then((r) => r.data),

  listBusinesses: (params: { page?: number; limit?: number; q?: string; status?: BusinessStatus }) =>
    api.get<{ businesses: BusinessRow[]; total: number }>('/admin/businesses', { params }).then((r) => r.data),

  createBusiness: (body: unknown) => api.post('/admin/businesses', body).then((r) => r.data),

  getBusiness: (id: string) =>
    api.get<{ business: Business; owner: SalonUser | null; branches: Branch[]; counts: { managers: number; branchLogins: number } }>(
      `/admin/businesses/${id}`
    ).then((r) => r.data),

  updateBusiness: (id: string, patch: Partial<Business>) =>
    api.patch<Business>(`/admin/businesses/${id}`, patch).then((r) => r.data),

  addBranch: (id: string, body: unknown) => api.post(`/admin/businesses/${id}/branches`, body).then((r) => r.data),

  deactivateBranch: (id: string, branchId: string, reason: string) =>
    api.patch<Branch>(`/admin/businesses/${id}/branches/${branchId}/deactivate`, { reason }).then((r) => r.data),

  listUsers: (id: string, role?: UserRole) =>
    api.get<SalonUser[]>(`/admin/businesses/${id}/users`, { params: { role } }).then((r) => r.data),

  resetPassword: (userId: string, password: string) => api.post(`/admin/users/${userId}/password`, { password }),

  setUserStatus: (userId: string, status: 'active' | 'inactive') =>
    api.post<SalonUser>(`/admin/users/${userId}/status`, { status }).then((r) => r.data),

  branchRequests: (status: 'pending' | 'approved' | 'rejected' = 'pending') =>
    api.get('/admin/branch-requests', { params: { status } }).then((r) => r.data),

  decide: (id: string, decision: 'approve' | 'reject', note?: Record<string, unknown>) =>
    api.post(`/admin/branch-requests/${id}/decide`, { decision, note }).then((r) => r.data),

  auditLogs: (params: Record<string, string | number | undefined>) =>
    api.get('/admin/audit-logs', { params }).then((r) => r.data),
};
```

### 8.2 Mapping server errors onto form fields

`fields` keys are dot paths matching the request body (`business.gst.gstin`, `owner.email`, `note.code`). With react-hook-form, name the inputs the same way and the mapping is one loop:

```ts
import { AxiosError } from 'axios';
import { UseFormSetError, FieldValues, Path } from 'react-hook-form';

export function applyServerErrors<T extends FieldValues>(err: unknown, setError: UseFormSetError<T>): string | null {
  const e = (err as AxiosError<any>).response?.data?.error;
  if (!e) return 'Network error. Please try again.';
  if (e.fields) {
    for (const [path, message] of Object.entries(e.fields)) setError(path as Path<T>, { message: String(message) });
    return null;
  }
  if (e.code === 'DUPLICATE_EMAIL') {
    // message: "Email x@y is already in use" → put it under whichever email matches
    return e.message;
  }
  return e.message;
}
```

### 8.3 Businesses list page (TanStack Query)

```tsx
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useState } from 'react';
import { adminApi, BusinessStatus } from '../api/admin';

export function BusinessesPage() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<BusinessStatus | ''>('');
  const limit = 20;

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'businesses', { page, q, status }],
    queryFn: () => adminApi.listBusinesses({ page, limit, q: q || undefined, status: status || undefined }),
    placeholderData: keepPreviousData,
  });

  const pages = data ? Math.max(1, Math.ceil(data.total / limit)) : 1;

  return (
    <>
      <input placeholder="Search name" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
      <select value={status} onChange={(e) => { setStatus(e.target.value as BusinessStatus | ''); setPage(1); }}>
        <option value="">All</option><option value="active">Active</option><option value="suspended">Suspended</option>
      </select>
      {isLoading ? <p>Loading…</p> : (
        <table>
          <thead><tr><th>Business</th><th>Owner</th><th>City</th><th>Branches</th><th>Status</th></tr></thead>
          <tbody>
            {data!.businesses.map((b) => (
              <tr key={b._id}>
                <td><a href={`/admin/businesses/${b._id}`}>{b.name}</a></td>
                <td>{b.owner ? `${b.owner.name} · ${b.owner.email}` : '—'}</td>
                <td>{b.address.city}</td>
                <td>{b.branchCount}</td>
                <td>{b.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>
      <span>{page} / {pages}</span>
      <button disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
    </>
  );
}
```

Debounce `q` (about 300 ms) before it goes into the query key.

### 8.4 Mutations: refresh what changed

| After | Invalidate |
| --- | --- |
| create business | `['admin','businesses']`, `['admin','stats']` |
| update / suspend business | `['admin','business',id]`, `['admin','businesses']`, `['admin','stats']` |
| add / deactivate branch | `['admin','business',id]`, `['admin','stats']` |
| user status / password | `['admin','users',id]` |
| decide request | `['admin','branch-requests']`, `['admin','stats']`, and the business if the request was approved |

### 8.5 UI rules that match the backend

- Disable "Deactivate" for the head branch (`branch._id === business.headBranchId`) and for branches already `deactivated`.
- Disable "Activate" on a branch login whose branch is `deactivated`.
- Confirm before suspending a business: it logs out every user there immediately.
- After a password reset, show the new password once so the Super Admin can share it. There is no email sending.
- On onboarding, offer a "same as business address" checkbox for the head branch address.

---

## 9. Not available yet

| Feature | Status |
| --- | --- |
| Create or manage other Super Admin accounts | No API. Seed them in the DB (`scripts/seed-test-logins.ts` shows how) |
| Reactivate a deactivated branch | No API |
| WhatsApp number setup (`POST /admin/businesses/:id/wa-config`) | Exists, not covered here yet (later phase) |
| Data import jobs (`/admin/businesses/:id/import-jobs`, `/admin/import-jobs/:id/confirm`) | Exist, not covered here yet (later phase) |
| Failed background jobs and retry | No API |
| Platform revenue metrics | Not in `GET /admin/stats` yet |
| Super Admin token on salon routes (e.g. `/customers`) | Returns `500` instead of `403` (report #4/#11). The panel should not call salon routes |

---

## 10. Backend changes made for this panel (2026-10-28)

| Change | Where |
| --- | --- |
| Login no longer 500s when Redis is offline at startup; the server now really uses Redis when it's running | `src/server.ts`, `src/services/auth.service.ts` |
| Transactions are enabled on replica sets (Atlas, tests); standalone `mongod` still works without them | `src/config/db.ts` (report #2) |
| Onboarding, add branch, approve "add" request and create manager work (the email registry got `accountId` but needs `userId` + `businessId`) | `src/services/business.service.ts` (report #9) |
| Onboarding requires a GSTIN when GST is enabled | `src/validations/business.schema.ts` |
| Onboarding / add-branch responses no longer include `passwordHash` | `business.service.ts` |
| Add branch → 404 for an unknown business (it used to create an orphan branch) | `business.service.ts` |
| `PATCH /admin/businesses/:id` accepts `status` (it was silently dropped, so suspending never worked) | `business.schema.ts` |
| New: `GET /admin/stats`, `GET /admin/businesses`, `GET /admin/businesses/:id`, `GET /admin/businesses/:id/users`, `POST /admin/users/:id/password`, `POST /admin/users/:id/status` | `admin.routes.ts`, `admin.controller.ts`, `business.service.ts` |
| Super Admin password reset works (role string `super_admin` was not recognised) | `auth.service.ts` (report: auth.admin) |
| `decide` validates `decision`; approving an "add" request validates the branch details (400, not 500) | `business.schema.ts`, `business.service.ts` (AUTH guide #16) |
| Audit log: `?businessId=` filter for Super Admin; admin actions now record the business they affect | `audit.service.ts`, `business.service.ts` |

Tests: [tests/integration/admin.panel.test.ts](../tests/integration/admin.panel.test.ts) (26 tests) and the onboarding block in [admin-catalogue-customer.test.ts](../tests/integration/admin-catalogue-customer.test.ts) (8 tests) all pass. Run them with `npx jest tests/integration/admin`.

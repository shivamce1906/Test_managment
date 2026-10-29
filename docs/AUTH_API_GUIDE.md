# Glox Salon — Auth & Account APIs (Frontend Integration Guide)

**Audience:** frontend developer building the React web app.
**Status:** describes how the backend behaves **today** (verified against the running API on 2026-10-28). Anything broken or missing is marked ⚠️ or ❌ — see [Section 7](#7-issues-to-fix-before-relying-on-this) before building on it.

---

## 1. The four logins at a glance

| Role | Who | `kind` | Created by | Can see |
| --- | --- | --- | --- | --- |
| **Super Admin** | Glox team | `platform` | Seeded directly in DB (no API) | Only `/admin/*` routes |
| **Owner** | Salon owner (1 per business) | `tenant` | Super Admin, when onboarding the business | All branches of their business |
| **Manager** | Staff member with a login | `tenant` | Owner | Only branches in `branchIds`, plus permission `flags` |
| **Branch login** | Shared reception login (1 per branch) | `tenant` | Super Admin, with each branch | Only its own branch (`branchId`) |

Everyone logs in through the **same** endpoint with email + password. The response tells you the role.

```
Super Admin ──creates──► Business + Owner + Head branch + Branch login
     │                                    │
     └──creates──► More branches          └── Owner ──creates──► Managers
                   (each with a branch login)        └──sets──► Branch login flags
```

---

## 2. Basics

### Base URL

```
http://localhost:4000          (local)
```

> ⚠️ Routes are mounted at the root (`/auth/login`), **not** under `/api/v1` as the Backend SRS says. Keep the base URL in one env variable (`VITE_API_URL`) so it is a one-line change if `/api/v1` is added later.

### Headers

| Header | When |
| --- | --- |
| `Content-Type: application/json` | Every request with a body |
| `Authorization: Bearer <accessToken>` | Every protected request |

Every response carries `x-request-id` — show it in error toasts / send it with bug reports.

### Tokens

| Token | Lifetime | Where it comes from | Use |
| --- | --- | --- | --- |
| `accessToken` (JWT) | **15 minutes** | `login`, `refresh` | `Authorization` header |
| `refreshToken` (opaque string) | Super Admin 12 h · Owner/Manager 30 days · Branch 7 days | `login` (field `refreshToken`), `refresh` (field **`newRefreshToken`**) | Get a new access token |

- Refresh tokens are **single-use**: every refresh returns a new one and the old one dies.
- Re-using an old refresh token revokes **all** sessions of that user (theft protection) → every request returns `401 SESSION_REVOKED`.
- ⚠️ The refresh token is returned **in the JSON body**, not as an httpOnly cookie (the SRS intends a cookie). See [Section 6.1](#61-where-to-store-tokens).

### Error format (all endpoints)

```json
{
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "Invalid email or password",
    "fields": { "email": "Invalid email address" },
    "details": { "until": "2026-10-28T12:14:21.648Z" }
  }
}
```

Always branch on `error.code`, never on `message`. `fields` appears on validation errors, `details` on some errors.

| HTTP | `code` | Meaning for the UI |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Show `fields[path]` under each input |
| 401 | `UNAUTHENTICATED` | Token missing/expired/invalid → try refresh once, else go to login |
| 401 | `INVALID_CREDENTIALS` | "Wrong email or password" (same for unknown email) |
| 401 | `SESSION_REVOKED` | Logged out remotely (password/role/branch change, deactivation, token reuse) → clear storage, go to login |
| 403 | `ACCOUNT_LOCKED` | 5 wrong passwords → locked 15 min; show time from `details.until` |
| 403 | `ACCOUNT_INACTIVE` | User, branch or business deactivated/suspended |
| 403 | `FORBIDDEN` | Role/branch/permission not allowed — hide the action |
| 404 | `NOT_FOUND` | Missing, or belongs to another business |
| 409 | `DUPLICATE_EMAIL` | Email already used by any login |
| 429 | `RATE_LIMITED` | Too many requests; `Retry-After` header |
| 500 | `INTERNAL` / `TENANT_SCOPE_MISSING` | Server bug — show generic error + `x-request-id` |

---

## 3. Session endpoints (all roles)

### Quick reference

| Method | Path | Auth | Status |
| --- | --- | --- | --- |
| POST | `/auth/login` | public | ✅ |
| POST | `/auth/refresh` | public (refresh token in body) | ✅ (field name differs from SRS) |
| POST | `/auth/logout` | Bearer | ✅ |
| GET | `/auth/me` | Bearer | ✅ |

### 3.1 `POST /auth/login`

**Request**

```json
{
  "email": "owner@glamour.in",
  "password": "Secret123"
}
```

- `email` is trimmed and lower-cased by the server; must be a valid email.
- Rate limit: 30 attempts / 15 min per IP (then `429`).
- 5 consecutive wrong passwords lock the account for 15 minutes (a correct password resets the counter).

**Response `200` — Owner**

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "6ae1e398f8b81d31daaaf2cd.2f9c...e1.8a7b...",
  "user": {
    "id": "6ae1e398f8b81d31daaaf2cd",
    "name": "Owner Olivia",
    "email": "owner@glamour.in",
    "role": "owner",
    "kind": "tenant",
    "businessId": "6ae1e398f8b81d31daaaf2b9",
    "branchIds": [],
    "flags": { "manageStaff": false, "approvePO": false, "viewPayroll": false, "editBranchPrices": false, "markAttendance": false }
  }
}
```

**Response `200` — Manager**

```json
{
  "accessToken": "eyJ...",
  "refreshToken": "6ae1...",
  "user": {
    "id": "6ae1e398f8b81d31daaaf2d0",
    "name": "Manager Meera",
    "email": "meera@glamour.in",
    "role": "manager",
    "kind": "tenant",
    "businessId": "6ae1e398f8b81d31daaaf2b9",
    "branchIds": ["6ae1e398f8b81d31daaaf2bb"],
    "flags": { "manageStaff": true, "approvePO": true, "viewPayroll": true, "editBranchPrices": true, "markAttendance": false }
  }
}
```

**Response `200` — Branch login**

```json
{
  "accessToken": "eyJ...",
  "refreshToken": "6ae1...",
  "user": {
    "id": "6ae1e398f8b81d31daaaf2d3",
    "name": "Vesu Login",
    "email": "vesu@glamour.in",
    "role": "branch",
    "kind": "tenant",
    "businessId": "6ae1e398f8b81d31daaaf2b9",
    "branchIds": ["6ae1e398f8b81d31daaaf2bb"],
    "flags": { "markAttendance": false, "manageStaff": false, "approvePO": false, "viewPayroll": false, "editBranchPrices": false }
  }
}
```

**Response `200` — Super Admin**

```json
{
  "accessToken": "eyJ...",
  "refreshToken": "6ae1...",
  "user": {
    "id": "6ae1e398f8b81d31daaaf302",
    "name": "Glox Admin",
    "email": "admin@glox.in",
    "role": "superadmin",
    "kind": "platform"
  }
}
```

> ⚠️ Login says `"role": "superadmin"` but `/auth/me` says `"role": "super_admin"`. Use `user.kind === 'platform'` to detect Super Admin — it is consistent.

**Errors**

| Case | Status | Body |
| --- | --- | --- |
| Bad email format | 400 | `{"error":{"code":"VALIDATION_ERROR","message":"Validation failed","fields":{"email":"Invalid email address"}}}` |
| Wrong password / unknown email | 401 | `{"error":{"code":"INVALID_CREDENTIALS","message":"Invalid email or password"}}` |
| Locked | 403 | `{"error":{"code":"ACCOUNT_LOCKED","message":"Account is locked due to 5 failed logins","details":{"until":"2026-10-28T12:14:21.648Z"}}}` |
| User inactive / business suspended / branch deactivated | 403 | `{"error":{"code":"ACCOUNT_INACTIVE","message":"..."}}` |
| Too many attempts from this IP | 429 | `{"error":{"code":"RATE_LIMITED",...}}` |

### 3.2 `POST /auth/refresh`

**Request**

```json
{ "refreshToken": "6ae1e398f8b81d31daaaf2cd.2f9c...e1.8a7b..." }
```

**Response `200`**

```json
{
  "accessToken": "eyJ...",
  "newRefreshToken": "6ae1e398f8b81d31daaaf2cd.91d0...77.c3e1..."
}
```

> ⚠️ The new refresh token is in **`newRefreshToken`** (login uses `refreshToken`). Save it — the one you sent is now dead.

**Errors**

| Case | Status | `code` |
| --- | --- | --- |
| Malformed token | 401 | `UNAUTHENTICATED` |
| Expired, already used, or logged out | 401 | `SESSION_REVOKED` (and **all** sessions of the user are revoked) |
| User became inactive | 403 | `ACCOUNT_INACTIVE` |

### 3.3 `POST /auth/logout`

**Headers:** `Authorization: Bearer <accessToken>`

**Request**

```json
{ "refreshToken": "6ae1..." }
```

**Response `200`**

```json
{ "success": true, "message": "Logged out successfully" }
```

Only the given refresh token is killed. The access token stays valid until it expires (≤ 15 min) — always clear it from the client.

### 3.4 `GET /auth/me`

**Headers:** `Authorization: Bearer <accessToken>`

Call on app start / page reload to rebuild the session.

**Response `200` — Branch login** (note `branchId`, only branch logins get it)

```json
{
  "user": {
    "id": "6ae1e398f8b81d31daaaf2d3",
    "name": "Vesu Login",
    "email": "vesu@glamour.in",
    "role": "branch",
    "kind": "tenant",
    "businessId": "6ae1e398f8b81d31daaaf2b9",
    "branchId": "6ae1e398f8b81d31daaaf2bb",
    "branchIds": ["6ae1e398f8b81d31daaaf2bb"],
    "flags": { "markAttendance": false, "manageStaff": false, "approvePO": false, "viewPayroll": false, "editBranchPrices": false }
  }
}
```

**Response `200` — Super Admin**

```json
{
  "user": {
    "id": "6ae1e398f8b81d31daaaf302",
    "name": "Glox Admin",
    "email": "admin@glox.in",
    "role": "super_admin",
    "kind": "platform",
    "branchIds": []
  }
}
```

Owner and Manager look like their login `user` object.

> ⚠️ `/auth/me` returns only the user. It does **not** return business name, branch names, or GST settings (the SRS promises `{user, role, business, branches[], flags}`). Fetch branches separately with `GET /business/branches`.

### 3.5 What each role's session means for the UI

| Field | Super Admin | Owner | Manager | Branch |
| --- | --- | --- | --- | --- |
| `kind` | `platform` | `tenant` | `tenant` | `tenant` |
| `role` | `superadmin` (login) / `super_admin` (me) | `owner` | `manager` | `branch` |
| `businessId` | — | ✓ | ✓ | ✓ |
| `branchIds` | `[]` | `[]` = **all branches** | assigned branches | exactly one |
| `branchId` | — | — | — | own branch (in `/auth/me` only) |
| `flags` that matter | — | ignore (owner can do everything) | `manageStaff`, `approvePO`, `viewPayroll`, `editBranchPrices`, `maxDiscountBps` | `markAttendance` |
| Landing screen | Admin panel | Owner dashboard | Branch picker / dashboard | Calendar of own branch |
| Branch switcher | — | all branches | `branchIds` only | hidden |

---

## 4. Super Admin — account setup endpoints

> ✅ **Updated 2026-10-28:** all of these now work. The current request/response details for the whole Super Admin panel are in **[SUPERADMIN_API_GUIDE.md](SUPERADMIN_API_GUIDE.md)**, which supersedes 4.1–4.5 below (they describe the old, broken behaviour).

All require a **Super Admin** access token. Owners/managers get `403 FORBIDDEN`.

| Method | Path | Purpose | Status |
| --- | --- | --- | --- |
| POST | `/admin/businesses` | Onboard business + owner + head branch + branch login | ✅ fixed |
| PATCH | `/admin/businesses/:id` | Update business / suspend | ✅ fixed (suspend now logs users out) |
| POST | `/admin/businesses/:id/branches` | Add branch + its branch login | ✅ fixed |
| PATCH | `/admin/businesses/:id/branches/:branchId/deactivate` | Deactivate branch (+ its login) | ✅ |
| GET | `/admin/branch-requests` | Owner requests waiting | ✅ |
| POST | `/admin/branch-requests/:id/decide` | Approve / reject a request | ✅ fixed |
| POST | `/admin/users/:id/password` | Reset any password | ✅ new |
| POST | `/admin/users/:id/status` | Activate / deactivate a login | ✅ new |
| — | Create a Super Admin | — | ❌ no API (seed in DB) |

### 4.1 `POST /admin/businesses` — onboard a salon ❌

**Request**

```json
{
  "business": {
    "name": "Glamour Studio",
    "address": { "line1": "12 MG Road", "city": "Surat", "state": "Gujarat", "pincode": "395007" },
    "gst": { "enabled": true, "gstin": "24AAAAA0000A1Z5", "pan": "AAAAA0000A", "rateBps": 1800, "sac": "9983", "pricesInclusive": false },
    "fyStartMonth": 4,
    "discountLimits": { "managerBps": 2000, "branchBps": 1000, "ownerAlertBps": 2500 },
    "dayEndReportTime": "23:00",
    "ownerWhatsappPhone": "9800000001"
  },
  "owner": { "name": "Neha Shah", "email": "neha@glamour.in", "phone": "9800000001", "password": "Secret123" },
  "headBranch": {
    "name": "Vesu", "code": "SRT1", "invoicePrefix": "SRT1",
    "address": { "line1": "12 MG Road", "city": "Surat", "state": "Gujarat", "pincode": "395007" },
    "phone": "9800000002",
    "loginEmail": "vesu@glamour.in", "loginPassword": "Secret123"
  }
}
```

Rules: `pincode` 6 chars; `dayEndReportTime` `HH:mm`; owner/branch passwords min 8; `code` and `invoicePrefix` are upper-cased; owner email ≠ branch login email. Money/percent are integers: `rateBps: 1800` = 18 %.

**Intended response `201`**

```json
{ "business": { "_id": "...", "name": "Glamour Studio", "headBranchId": "..." }, "owner": { "_id": "...", "role": "owner" }, "branch": { "_id": "...", "code": "SRT1" }, "branchLogin": { "_id": "...", "role": "branch" } }
```

**Actual response today `400`**

```json
{"error":{"code":"VALIDATION_ERROR","message":"emailRegistry validation failed: userId: Path `userId` is required.","fields":{"userId":"Path `userId` is required."}}}
```

> ❌ Every onboarding fails, **and** it leaves a half-created business, branch and two users in the DB. Do not wire the "Create business" screen until fix #1 is in. Other errors: `409 DUPLICATE_EMAIL`, `400` if owner email = branch email.

### 4.2 `POST /admin/businesses/:id/branches` — add a branch ❌

```json
{
  "name": "Adajan", "code": "SRT2", "invoicePrefix": "SRT2",
  "address": { "line1": "5 Ring Road", "city": "Surat", "state": "Gujarat", "pincode": "395009" },
  "phone": "9800000013",
  "loginEmail": "adajan@glamour.in", "loginPassword": "Secret123",
  "stations": 6, "pettyCashFloatPaise": 500000
}
```

Intended `201`: `{ "branch": {...}, "branchLogin": {...} }`. Today: same `400 emailRegistry` error as 4.1. Duplicate `code`/`invoicePrefix` → `409`.

### 4.3 `PATCH /admin/businesses/:id` — update / suspend business ✅

```json
{ "status": "suspended" }
```

Accepts any field of business settings (name, address, gst, discountLimits, …). Response `200`: the full business object.

> ⚠️ Suspending blocks **new** logins, but users already logged in keep working until their access token expires and refresh fails.

### 4.4 `PATCH /admin/businesses/:id/branches/:branchId/deactivate` ✅

```json
{ "reason": "Branch closed" }
```

Response `200`: the branch with `"status": "deactivated"`. Its branch login is set inactive and logged out. Head branch → `403 "Head branch cannot be deactivated"`.

### 4.5 Branch requests ✅

`GET /admin/branch-requests` → array (pending only):

```json
[{ "_id": "6ae1e39af8b81d31daaaf3a3", "type": "delete", "branchId": "6ae1...f2c4", "reason": "Lease ended", "status": "pending",
   "businessId": { "_id": "6ae1...f2b9", "name": "Glamour Studio" }, "createdAt": "2026-10-28T11:59:22.404Z" }]
```

`POST /admin/branch-requests/:id/decide`

```json
{ "decision": "reject", "note": { "reason": "Please call us first" } }
```

```json
{ "decision": "approve" }
```

For an **add** request the new branch details go in `note`:

```json
{ "decision": "approve", "note": { "code": "SRT3", "invoicePrefix": "SRT3", "phone": "9800000020", "loginEmail": "citylight@glamour.in", "loginPassword": "Secret123" } }
```

Response `200`: the request with `status` `approved`/`rejected` (`rejectReason` on reject). Already decided → `409`.
> ❌ Approving an **add** request fails like 4.2. ⚠️ Any `decision` other than `"reject"` is treated as approve — send exactly `"approve"` or `"reject"`.

---

## 5. Owner (and Manager) — account endpoints

| Method | Path | Who | Purpose | Status |
| --- | --- | --- | --- | --- |
| GET | `/business/branches` | Owner, Manager, Branch | Branches visible to the user | ✅ |
| POST | `/business/managers` | Owner | Create manager login | ❌ fails (400) |
| GET | `/business/managers` | Owner | List managers | ✅ |
| PATCH | `/business/managers/:id` | Owner | Change branches / flags / status | ✅ ⚠️ leaks password hash |
| GET | `/business/branch-logins` | Owner | List branch logins | ✅ |
| PATCH | `/business/branch-logins/:id` | Owner | Allow branch login to mark attendance | ✅ (special body) ⚠️ leaks hash |
| POST | `/business/branch-requests` | Owner | Ask Glox to add/delete a branch | ✅ |
| POST | `/business/users/:id/password` | Owner | Set manager/branch password | ❌ does not exist |

### 5.1 `GET /business/branches` ✅

Owner gets all branches, manager the assigned ones, branch login its own. Response: array of branches.

```json
[{ "_id": "6ae1e398f8b81d31daaaf2bb", "name": "Vesu", "code": "SRT1", "invoicePrefix": "SRT1", "phone": "+919800000002", "stations": 4,
   "address": { "line1": "12 MG Road", "city": "Surat", "state": "Gujarat", "pincode": "395007" },
   "hours": [{ "day": 0, "open": "10:00", "close": "20:00", "closed": false }], "holidays": [], "status": "active" }]
```

Use this right after login to fill the branch switcher and show branch names.

### 5.2 `POST /business/managers` ❌

```json
{
  "name": "Ravi Patel",
  "email": "ravi@glamour.in",
  "phone": "9800000014",
  "password": "Secret123",
  "branchIds": ["6ae1e398f8b81d31daaaf2bb"],
  "flags": { "manageStaff": true, "approvePO": false, "viewPayroll": true, "editBranchPrices": false, "maxDiscountBps": 1500 },
  "staffId": "6ae1e398f8b81d31daaaf2e0"
}
```

`branchIds` needs at least one id; `staffId` optional (links to the manager's payroll record). Intended `201`: the manager user. Today `400` with the same `emailRegistry … userId` error. Duplicate email → `409 DUPLICATE_EMAIL`.

### 5.3 `GET /business/managers` ✅

```json
[{ "_id": "6ae1e398f8b81d31daaaf2d0", "role": "manager", "name": "Manager Meera", "email": "meera@glamour.in",
   "branchIds": ["6ae1e398f8b81d31daaaf2bb"], "status": "active",
   "flags": { "manageStaff": true, "approvePO": true, "viewPayroll": true, "editBranchPrices": true, "markAttendance": false },
   "lastLoginAt": "2026-10-28T11:59:20.784Z", "failedLogins": 0 }]
```

`lockedUntil` in the future → show "Locked".

### 5.4 `PATCH /business/managers/:id` ✅ ⚠️

Send only what changes:

```json
{ "branchIds": ["6ae1...f2bb", "6ae1...f2c4"], "flags": { "approvePO": true } }
```

```json
{ "status": "inactive" }
```

`flags` are merged with existing flags. Any update **logs the manager out everywhere** (`SESSION_REVOKED` on their next call). Response `200`: the manager — ⚠️ **includes `passwordHash`**; never render or log it (fix #5).

### 5.5 Branch logins ✅ ⚠️

`GET /business/branch-logins` → array of branch users (`flags.markAttendance`, `status`, `lastLoginAt`).

`PATCH /business/branch-logins/:id` — the body must be wrapped in `flags`:

```json
{ "flags": { "markAttendance": true } }
```

> ⚠️ The SRS body `{ "markAttendance": true }` returns **500**. Response `200` includes `passwordHash` (fix #5). Only the owner can call it today (SRS also allows managers).

### 5.6 `POST /business/branch-requests` ✅

```json
{ "type": "delete", "branchId": "6ae1e398f8b81d31daaaf2c4", "reason": "Lease ended" }
```

```json
{ "type": "add", "payload": { "name": "City Light", "address": { "line1": "3 VIP Road", "city": "Surat", "state": "Gujarat", "pincode": "395007" } }, "reason": "New outlet" }
```

Response `201`: `{ "_id": "...", "type": "delete", "status": "pending", ... }`. Head branch delete → `403`.

### 5.7 Password management ❌

No endpoint exists to change or reset a password (`/business/users/:id/password`, `/admin/users/:id/password` → 404/403). Users who forget a password cannot be helped from the app yet. Hide "Reset password" buttons until fix #4.

---

## 6. Integrating in React

### 6.1 Where to store tokens

Until the backend moves the refresh token into an httpOnly cookie (fix #8):

- **Access token** → memory only (a module variable / React state). Never `localStorage`.
- **Refresh token** → `localStorage` (needed to survive reload). This is XSS-exposed: keep a strict CSP, no `dangerouslySetInnerHTML` with user data.
- On reload: read refresh token → call `/auth/refresh` → then `/auth/me`.

When the cookie fix lands, delete the `localStorage` code and add `withCredentials: true`.

### 6.2 API client with automatic refresh (axios)

```ts
// src/api/client.ts
import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';

const RT_KEY = 'glox.rt';
let accessToken: string | null = null;
let refreshing: Promise<string> | null = null; // single-flight: one refresh for many 401s
let onLogout: () => void = () => {};

export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL });

export const tokenStore = {
  set(at: string, rt?: string) {
    accessToken = at;
    if (rt) localStorage.setItem(RT_KEY, rt);
  },
  clear() {
    accessToken = null;
    localStorage.removeItem(RT_KEY);
  },
  refreshToken: () => localStorage.getItem(RT_KEY),
  onLogout(fn: () => void) {
    onLogout = fn;
  },
};

api.interceptors.request.use((cfg) => {
  if (accessToken) cfg.headers.Authorization = `Bearer ${accessToken}`;
  return cfg;
});

async function refreshAccessToken(): Promise<string> {
  const rt = tokenStore.refreshToken();
  if (!rt) throw new Error('no refresh token');
  // plain axios: must not go through the interceptor
  const { data } = await axios.post(`${import.meta.env.VITE_API_URL}/auth/refresh`, { refreshToken: rt });
  // NOTE: backend returns `newRefreshToken` (falls back to `refreshToken` once fixed)
  tokenStore.set(data.accessToken, data.newRefreshToken ?? data.refreshToken);
  return data.accessToken;
}

api.interceptors.response.use(
  (r) => r,
  async (err: AxiosError<any>) => {
    const original = err.config as InternalAxiosRequestConfig & { _retried?: boolean };
    const code = err.response?.data?.error?.code;

    if (err.response?.status === 401 && code === 'UNAUTHENTICATED' && !original._retried && tokenStore.refreshToken()) {
      original._retried = true;
      try {
        refreshing ??= refreshAccessToken().finally(() => (refreshing = null));
        const at = await refreshing;
        original.headers.Authorization = `Bearer ${at}`;
        return api(original);
      } catch {
        tokenStore.clear();
        onLogout();
      }
    } else if (code === 'SESSION_REVOKED' || code === 'ACCOUNT_INACTIVE') {
      tokenStore.clear();
      onLogout();
    }
    return Promise.reject(err);
  }
);
```

Why single-flight matters: refresh tokens are single-use. If two requests refresh at the same time, the second uses a dead token and the server **revokes every session** of that user.

### 6.3 Auth service

```ts
// src/api/auth.ts
import { api, tokenStore } from './client';

export type Role = 'superadmin' | 'super_admin' | 'owner' | 'manager' | 'branch';
export interface SessionUser {
  id: string; name: string; email: string; role: Role; kind: 'platform' | 'tenant';
  businessId?: string; branchId?: string; branchIds: string[];
  flags?: { manageStaff?: boolean; approvePO?: boolean; viewPayroll?: boolean; editBranchPrices?: boolean; markAttendance?: boolean; maxDiscountBps?: number };
}

export async function login(email: string, password: string): Promise<SessionUser> {
  const { data } = await api.post('/auth/login', { email, password });
  tokenStore.set(data.accessToken, data.refreshToken);
  return me(); // /auth/me also gives branchId for branch logins
}

export async function me(): Promise<SessionUser> {
  const { data } = await api.get('/auth/me');
  return data.user;
}

export async function logout() {
  try {
    await api.post('/auth/logout', { refreshToken: tokenStore.refreshToken() });
  } finally {
    tokenStore.clear();
  }
}

/** Normalised role: hides the superadmin / super_admin mismatch. */
export const roleOf = (u: SessionUser) => (u.kind === 'platform' ? 'superadmin' : u.role) as 'superadmin' | 'owner' | 'manager' | 'branch';
```

### 6.4 Auth context + restoring the session on reload

```tsx
// src/auth/AuthProvider.tsx
import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { tokenStore } from '../api/client';
import * as auth from '../api/auth';
import axios from 'axios';

const Ctx = createContext<{ user: auth.SessionUser | null; loading: boolean; signIn: typeof auth.login; signOut: () => Promise<void> } | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<auth.SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    tokenStore.onLogout(() => setUser(null));
    const rt = tokenStore.refreshToken();
    if (!rt) return setLoading(false);
    axios
      .post(`${import.meta.env.VITE_API_URL}/auth/refresh`, { refreshToken: rt })
      .then(({ data }) => {
        tokenStore.set(data.accessToken, data.newRefreshToken ?? data.refreshToken);
        return auth.me();
      })
      .then(setUser)
      .catch(() => tokenStore.clear())
      .finally(() => setLoading(false));
  }, []);

  const signIn = async (email: string, password: string) => {
    const u = await auth.login(email, password);
    setUser(u);
    return u;
  };
  const signOut = async () => {
    await auth.logout();
    setUser(null);
  };

  return <Ctx.Provider value={{ user, loading, signIn, signOut }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx)!;
```

> React 18 StrictMode runs effects twice in dev → two refresh calls with the same token → session revoked. Guard the effect with a `useRef` flag, or reuse the single-flight `refreshing` promise from the client.

### 6.5 Login form error handling

```tsx
async function onSubmit(email: string, password: string) {
  try {
    const u = await signIn(email, password);
    navigate(homeFor(u));
  } catch (e: any) {
    const err = e.response?.data?.error;
    switch (err?.code) {
      case 'VALIDATION_ERROR': setFieldErrors(err.fields); break;
      case 'INVALID_CREDENTIALS': setMessage('Wrong email or password'); break;
      case 'ACCOUNT_LOCKED': setMessage(`Too many attempts. Try again after ${new Date(err.details.until).toLocaleTimeString('en-IN')}`); break;
      case 'ACCOUNT_INACTIVE': setMessage('This account, branch or salon is inactive. Contact your owner or Glox support.'); break;
      case 'RATE_LIMITED': setMessage('Too many attempts from this device. Please wait a few minutes.'); break;
      default: setMessage(`Something went wrong (ref ${e.response?.headers?.['x-request-id'] ?? 'n/a'})`);
    }
  }
}
```

### 6.6 Role-based routing and permissions

```tsx
// src/auth/access.ts
import { SessionUser, roleOf } from '../api/auth';

export const homeFor = (u: SessionUser) =>
  ({ superadmin: '/admin', owner: '/dashboard', manager: '/dashboard', branch: `/branches/${u.branchId}/calendar` })[roleOf(u)];

type Flag = 'manageStaff' | 'approvePO' | 'viewPayroll' | 'editBranchPrices' | 'markAttendance';

/** Owner can do everything; managers/branch need the flag. */
export const can = (u: SessionUser, flag: Flag) => roleOf(u) === 'owner' || !!u.flags?.[flag];

/** Branches the user may switch between ([] for owner means "all" — use GET /business/branches). */
export const canUseBranch = (u: SessionUser, branchId: string) =>
  roleOf(u) === 'owner' || u.branchIds.includes(branchId);
```

```tsx
// src/auth/RequireRole.tsx
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { roleOf } from '../api/auth';

export function RequireRole({ roles }: { roles: Array<'superadmin' | 'owner' | 'manager' | 'branch'> }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return roles.includes(roleOf(user)) ? <Outlet /> : <Navigate to="/403" replace />;
}
```

```tsx
<Routes>
  <Route path="/login" element={<Login />} />
  <Route element={<RequireRole roles={['superadmin']} />}>
    <Route path="/admin/*" element={<AdminApp />} />
  </Route>
  <Route element={<RequireRole roles={['owner', 'manager']} />}>
    <Route path="/dashboard" element={<Dashboard />} />
    <Route path="/settings/managers" element={<Managers />} /> {/* page itself checks owner */}
  </Route>
  <Route element={<RequireRole roles={['owner', 'manager', 'branch']} />}>
    <Route path="/branches/:branchId/*" element={<BranchApp />} />
  </Route>
</Routes>
```

Front-end checks are only for UX — the server enforces permissions. Still handle `403 FORBIDDEN` everywhere.

### 6.7 Role-specific notes

- **Super Admin:** never call salon routes (`/customers`, `/branches/...`) with a platform token — they crash with `500 TENANT_SCOPE_MISSING` instead of 403. Keep the admin app fully separate.
- **Owner:** `branchIds` is empty → load the branch list from `GET /business/branches`.
- **Manager:** after the owner changes their branches or flags they are logged out on the next request → show "Your access was updated, please log in again."
- **Branch login:** shared by all receptionists. Every bill needs a **Billed by** receptionist (`GET /staff/branches/:branchId/billed-by`). Ask "Who is billing?" before the bill screen, keep it in state, and send it as `billedByStaffId`. Short 7-day refresh → expect weekly re-login.

---

## 7. Issues to fix before relying on this

Ordered by how much they block the frontend. ❌ = feature unusable, ⚠️ = works with a workaround.

| # | Issue | Impact on frontend | Where | Fix |
| --- | --- | --- | --- | --- |
| 1 | ✅ **Fixed 2026-10-28.** ~~Creating any login fails: email registry gets `accountId` but the model requires `userId`~~ | Super Admin cannot onboard salons or add branches; owner cannot create managers | [business.service.ts:124](../src/services/business.service.ts#L124) (also branch & manager create) | Write `userId` (or rename the model field to `accountId` as in the DB design) |
| 2 | ✅ **Fixed 2026-10-28** (on replica sets/Atlas). ~~Failed onboarding leaves half-created business/branch/users (transactions disabled)~~ | Retrying creates duplicates | [db.ts:59](../src/config/db.ts#L59) | Re-enable `session.withTransaction` (needs replica set) |
| 3 | ❌ Router middleware leaks: `payrollRouter.use(requireRole(...))` and `auditRouter.use(...)` run for every later route | Branch logins get 403 on stock, day-end, inbox, notifications; managers get 403 on notifications; Super Admin gets 403 on unknown `/admin/*` paths | [payroll.routes.ts:15](../src/routes/payroll.routes.ts#L15), [audit.routes.ts:8](../src/routes/audit.routes.ts#L8) | Mount each router on its own prefix or put guards on each route |
| 4 | ⚠️ Super Admin part fixed 2026-10-28 (`POST /admin/users/:id/password`); owner endpoint still missing. No password set/reset endpoints; `setPassword` checks `'superadmin'` but the middleware sets `'super_admin'` | No "reset password" feature for any role | [auth.service.ts:323](../src/services/auth.service.ts#L323) | Add `POST /business/users/:id/password` and `POST /admin/users/:id/password`; fix role string |
| 5 | ⚠️ `passwordHash` returned by `PATCH /business/managers/:id` and `PATCH /business/branch-logins/:id` | Security leak in browser devtools/logs | business.service.ts `updateManager`, `updateBranchLoginFlags` | Add a `toJSON` transform on the User schema that removes `passwordHash` |
| 6 | ⚠️ Forged refresh token `<anyUserId>.x.y` logs that user out everywhere | Anyone can force-logout any user | [auth.service.ts:87](../src/services/auth.service.ts#L87) | Only revoke when the token id exists in a "used tokens" set, or verify a signature first |
| 7 | ⚠️ Suspending a business / deactivating a branch does not block live access tokens | Users keep working ≤ 15 min and refresh keeps succeeding for suspended businesses | auth.middleware.ts | Check business/branch status in `authenticate` (cache in Redis) and on refresh |
| 8 | ⚠️ Refresh token in JSON body, not httpOnly cookie | Must store it in `localStorage` (XSS risk) | auth.controller.ts | Set cookie `HttpOnly; Secure; SameSite=Strict; Path=/auth` |
| 9 | ⚠️ Field/role naming: refresh returns `newRefreshToken`; login role `superadmin` vs me `super_admin` | Extra mapping code (already handled in 6.2/6.3) | auth.controller.ts, auth.middleware.ts | Return `refreshToken`; use one role string |
| 10 | ⚠️ `PATCH /business/branch-logins/:id` needs `{flags:{markAttendance}}`; `{markAttendance}` → 500; manager not allowed | Use wrapped body; manager screen can't toggle | [business.controller.ts:88](../src/controllers/business.controller.ts#L88), business.routes.ts | Read `req.body.markAttendance`, validate with the existing schema, allow managers of that branch |
| 11 | ⚠️ Platform token on tenant routes → 500 instead of 403 | Confusing errors if admin UI calls salon APIs | auth/role middleware | Add `requireKind('tenant')` to tenant routers |
| 12 | ⚠️ `/auth/me` lacks business and branches | One extra call (`GET /business/branches`) after login | auth.controller.ts | Return `{ user, business, branches }` as in the SRS |
| 13 | ⚠️ Login rate limit 30/15 min, SRS says 5/min | None for UI; weaker brute-force protection | rateLimiter.ts | Align limits; use Redis store for multiple servers |
| 14 | ⚠️ CORS allows any origin (`origin: true`) | None for UI; security | [app.ts:34](../src/app.ts#L34) | Use `env.APP_ORIGINS` |
| 15 | ⚠️ No `/api/v1` prefix | Base URL will change later | app.ts | Mount all routers under `/api/v1` |
| 16 | ✅ **Fixed 2026-10-28.** ~~`decide` treats any value except `"reject"` as approve~~ | Typos approve requests | admin.controller.ts | Validate `decision` with Zod enum |

**Safe to build now:** login screen, refresh/logout handling, session restore, role routing, managers list/edit, branch list, branch-login list, branch requests, Super Admin requests/deactivate.
**Wait for fixes:** owner password reset (#4), branch login screens beyond billing/calendar (#3). Onboarding, create manager and Super Admin password reset now work.

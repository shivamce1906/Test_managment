# Glox Salon Management System — API Documentation

This document provides a comprehensive reference of all REST API endpoints implemented in the Glox Salon Management System backend.

---

## 1. Authentication & Common Headers

All protected endpoints require a Bearer token in the `Authorization` header:
```http
Authorization: Bearer <access_token>
```
Standard Response Headers returned:
- `x-request-id`: Unique UUIDv4 assigned to each HTTP request.

Standard Error Format:
```json
{
  "error": {
    "code": "SLOT_CLASH",
    "message": "Staff Leo is already booked for another appointment during this time",
    "details": {}
  }
}
```

---

## 2. Authentication (`/auth`)

### `POST /auth/login`
- **Access**: Public
- **Body**:
  ```json
  {
    "email": "owner@salon.com",
    "password": "SecurePassword123"
  }
  ```
- **Response** (200 OK):
  ```json
  {
    "accessToken": "eyJhbG...",
    "refreshToken": "c928b...",
    "user": {
      "id": "671...",
      "name": "Jane Owner",
      "email": "owner@salon.com",
      "role": "owner",
      "businessId": "671...",
      "branches": ["671..."]
    }
  }
  ```
- **Rules**: Enforces BR-09 (5 failed login attempts trigger 15-minute account lockout).

### `POST /auth/refresh`
- **Access**: Public
- **Body**: `{ "refreshToken": "c928b..." }`
- **Response** (200 OK): `{ "accessToken": "...", "refreshToken": "..." }`
- **Rules**: Rotates refresh tokens on every call; detects token reuse and invalidates the entire session family.

### `POST /auth/logout`
- **Access**: Authenticated
- **Body**: `{ "refreshToken": "c928b..." }`
- **Response** (200 OK): `{ "success": true }`

---

## 3. Platform Administration (`/admin`)

- **Role Required**: `super_admin`
- `GET /admin/businesses`: List all salon businesses on the platform with pagination and status filters.
- `POST /admin/businesses`: Provision a new salon tenant and root owner account.
- `GET /admin/businesses/:id`: Retrieve business details, subscription status, and branch summary.
- `PATCH /admin/businesses/:id/status`: Update business status (`active`, `suspended`, `cancelled`).
- `GET /admin/metrics`: Platform-wide aggregate metrics (total tenants, revenue volume, active users).

---

## 4. Business & Branch Management (`/business`)

- **Role Required**: `owner`
- `GET /business`: Retrieve current tenant profile, GST settings, and feature flags.
- `PATCH /business`: Update tenant settings (name, address, owner WhatsApp phone, GST rates).
- `GET /business/branches`: List all branches belonging to the tenant.
- `POST /business/branches`: Create a new branch (name, code, address, invoicePrefix, pettyCashFloatPaise).
- `PATCH /business/branches/:id`: Update branch operating hours, float amount, or contact details.

---

## 5. Catalogue Management

- **Roles**: `owner`, `manager` (read access open to all tenant staff)
- `GET /categories`, `POST /categories`: Service categories.
- `GET /services`, `POST /services`, `PATCH /services/:id`: Services catalogue with duration, base price, branch overrides, consumables, and commission rules.
- `GET /products`, `POST /products`, `PATCH /products/:id`: Retail and consumable products master with purchase/use units, MRP, and selling price.
- `GET /vendors`, `POST /vendors`, `PATCH /vendors/:id`: Vendor directory.

---

## 6. Appointments & Slot Management

- **Roles**: `owner`, `manager`, `branch`
- `POST /branches/:branchId/appointments`: Book an appointment.
  - **Body**:
    ```json
    {
      "customerId": "671...",
      "businessDate": "2026-10-27",
      "start": "2026-10-27T10:00:00.000Z",
      "end": "2026-10-27T11:00:00.000Z",
      "source": "phone",
      "lines": [
        {
          "serviceId": "671...",
          "staffId": "671...",
          "start": "2026-10-27T10:00:00.000Z",
          "end": "2026-10-27T11:00:00.000Z"
        }
      ]
    }
    ```
  - **Rules**: Enforces BR-04 (Slot clash prevention against branch hours, staff roster, leaves, and blocks).
- `POST /branches/:branchId/walk-in`: Quick walk-in appointment creation with automatic 5-minute time alignment.
- `GET /branches/:branchId/appointments`: Retrieve appointments with `from`, `to`, `staffId`, and `status` filters.
- `PATCH /appointments/:id/status`: Update status lifecycle (`booked` -> `confirmed` -> `arrived` -> `in_service` -> `completed` -> `billed` or `cancelled`/`no_show`).
- `POST /branches/:branchId/staff-blocks`: Create a staff block (lunch, training, emergency).

---

## 7. Customer Management (`/customers`)

- **Roles**: `owner`, `manager`, `branch`
- `GET /customers`: List/search customers by name, phone, or tags.
- `POST /customers`: Create a new customer profile.
- `GET /customers/:id`: Retrieve customer details including wallet balance, loyalty points, dues, and package balances.
- `PATCH /customers/:id`: Update customer profile.
- `GET /customers/:id/timeline`: Comprehensive audit timeline of appointments, bills, notes, and communications.
- `GET /customers/:id/wallet/ledger`: Complete ledger of wallet top-ups, debits, and refunds.

---

## 8. Billing & Invoicing

- **Roles**: `owner`, `manager`, `branch`
- `POST /branches/:branchId/bills/preview`: Preview bill calculation with GST, discounts, and approval checks.
- `POST /branches/:branchId/bills`: Create a bill and issue invoice.
  - **Rules**: Enforces BR-01 (Integer paise math), BR-02 (Staff commissions on pre-tax net), BR-03 (Split payments), BR-07 (Automatic stock deduction from retail pool), and BR-08 (Atomic invoice numbering with branch code and FY).
- `POST /bills/:id/cancel`: Cancel an unpaid or erroneous bill; restores deducted inventory back to stock (BR-07).
- `POST /bills/:id/refund`: Issue partial or full refund on a paid bill with mode and mandatory reason.
- `PATCH /bills/:id`: Edit bill details; creates a versioned snapshot (`BillVersion`).
- `POST /branches/:branchId/due-receipts`: Collect pending customer dues against outstanding bills.
- `GET /approvals`: List bills pending discount or partial payment approval.
- `POST /bills/:id/decide`: Approve or reject a bill pending approval.

---

## 9. Prepaid, Packages & Loyalty (`/prepaid`)

- **Roles**: `owner`, `manager`, `branch`
- `GET /plans`, `POST /plans`: Manage Membership, Package, Wallet, and Voucher plan master templates.
- `POST /branches/:branchId/plans/sell`: Sell a prepaid plan/package to a customer.
- `POST /customers/:customerId/wallet/topup`: Manual wallet credit with payment reference.
- `GET /customers/:customerId/plans`: List active memberships and packages with remaining session balances.

---

## 10. Staff, Attendance & Rostering (`/staff`)

- **Roles**: `owner`, `manager`
- `GET /staff`, `POST /staff`, `PATCH /staff/:id`: Manage staff master profiles and compensation.
- `POST /branches/:branchId/attendance`: Mark staff check-in / check-out.
- `GET /branches/:branchId/attendance`: View daily attendance register.
- `POST /staff/:id/leave`: Submit leave request.
- `PATCH /staff/leave/:id`: Approve or reject leave.
- `GET /branches/:branchId/roster`, `PUT /branches/:branchId/roster`: Manage weekly shifts and date overrides.

---

## 11. Payroll (`/payroll`)

- **Roles**: `owner`, `manager` (with `viewPayroll` permission)
- `POST /payroll/generate`: Generate monthly payroll run with salary, overtime (BR-05), commissions (BR-02), advances, and statutory deductions.
- `GET /payroll/runs`: View past payroll runs and disbursement records.
- `POST /payroll/advances`: Issue salary advance to staff member.

---

## 12. Inventory, Transfers & Audits

- **Roles**: `owner`, `manager`
- `GET /branches/:branchId/stock`: View stock balance across retail and consumable pools.
- `POST /branches/:branchId/stock/adjust`: Manually adjust stock with mandatory reason and movement ledger.
- `POST /purchase-orders`: Create PO for vendor.
- `POST /purchase-orders/:id/decide`: Approve or reject PO.
- `POST /purchase-orders/:id/receive`: Receive PO items into branch stock balance.
- `POST /purchase-orders/:id/bill`: Record vendor invoice and payment status.
- `POST /transfers`: Request inter-branch stock transfer.
- `POST /transfers/:id/approve`: Approve transfer.
- `POST /transfers/:id/dispatch`: Dispatch transfer (deducts stock from source branch).
- `POST /transfers/:id/receive`: Receive transfer (increments stock in destination branch).
- `POST /branches/:branchId/stock-audits`: Initiate physical stock audit.
- `PUT /stock-audits/:id/counts`: Enter physical counted quantities.
- `POST /stock-audits/:id/approve`: Approve audit and post variance adjustments.

---

## 13. Leads & CRM (`/leads`)

- **Roles**: `owner`, `manager`, `branch`
- `GET /leads`: List leads with stage filters (`new`, `contacted`, `trial_booked`, `converted`, `lost`).
- `POST /leads`: Create lead.
- `PATCH /leads/:id`: Update lead status or assign staff owner.
- `POST /leads/:id/notes`: Add follow-up note.

---

## 14. WhatsApp Messaging (`/whatsapp`)

- **Roles**: `owner`, `manager`, `branch`
- `POST /whatsapp/send`: Enqueue transactional WhatsApp message via AiSensy.
- `GET /whatsapp/messages`: Message log and delivery status.
- `POST /whatsapp/webhooks/status`: AiSensy webhook endpoint for real-time delivery and read receipts.

---

## 15. Day-End Closure & Petty Cash (`/dayend`)

- **Roles**: `owner`, `manager`, `branch`
- `POST /branches/:branchId/expenses`: Record till/petty cash expense (tea, cleaning, supplies).
- `GET /branches/:branchId/expenses`: List expenses for business date.
- `POST /branches/:branchId/closures`: Submit day-end till closure with physical cash count.
- `POST /closures/:id/approve`: Approve day closure (locks business day, BR-06).
- `POST /closures/:id/reopen`: Owner-only reopen of an approved day closure with audit reason.

---

## 16. Reports & Analytics (`/reports`)

- **Roles**: `owner`, `manager`
- `GET /reports/daily-summary`: Daily revenue, payment mode splits, discounts, and till reconciliations.
- `GET /reports/sales`: Multi-day sales report grouped by branch, category, or payment mode.
- `GET /reports/staff-performance`: Staff bill count, revenue generated, and commission earned.
- `GET /reports/gst`: GSTR-1 compliant tax report with taxable values, CGST, and SGST breakdowns.
- `GET /reports/inventory-valuation`: Closing stock count and valuation in paise.

---

## 17. Audit Logs & Real-Time Change Notifications

- `GET /audit-logs`: Query immutable audit trail filtered by actor, entity, action, and date range.
- `GET /notifications/cursor`: Polling endpoint returning monotonic timestamp cursors for calendar, bills, and stock updates.

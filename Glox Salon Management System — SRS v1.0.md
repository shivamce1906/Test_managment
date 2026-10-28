# Glox Salon Management System — SRS v1.0

Oct 26, 2026 · @Jagdish Kumawat

## 1. Introduction

This SRS turns the approved PRD (Glox Salon Management System — PRD v1.0) into testable software requirements for the Glox Salon Management System. Where the two differ, this document governs build and test.

**Purpose:** give the frontend developer, backend developer and testers one reference for what to build, how each rule calculates, and how each requirement is verified.

**Scope:** a free, multi-tenant, responsive web application for salons. One business runs many branches; Glox Super Admin provisions businesses, branches and WhatsApp. All modules from P1 to P3 are specified here and built together. Spa, clinic, payment gateway, Reserve with Google, native apps and self-serve import are out of scope.

**Requirement IDs:** `FR-<MODULE>-<nn>` for functional, `BR-<nn>` for business rules, `NFR-<nn>` for non-functional. Priority: **M** = must have for launch, **S** = should have, **C** = could have.

**Definitions**

| Term | Meaning |
| --- | --- |
| Business | One salon brand (tenant); owns branches, customers, services, staff |
| Branch | One physical outlet of a business |
| Branch login | Shared credential used by a branch's receptionists |
| Staff | Employee record (stylist, receptionist, manager); no login of its own |
| Billed by | Receptionist name chosen on each bill from the branch's staff with designation Receptionist |
| Consumable | Product used up in services, deducted automatically |
| Retail | Product sold to customers on a bill |
| Day-end closure | Daily cash and digital reconciliation per branch |
| Paise | Money unit stored in the database; ₹1 = 100 paise |
| AiSensy | WhatsApp Business API provider used for all messaging |
| BSP | Business Solution Provider for WhatsApp (AiSensy) |

## 2. Overall description

The system is a standalone SaaS, separate from the Glox marketplace apps, serving four kinds of user through one responsive web app plus a Super Admin panel.

**User classes**

| User | How they log in | Typical device | Main jobs |
| --- | --- | --- | --- |
| Glox Super Admin | Email + password; same app, \`/admin\` area | Laptop | Create businesses, owners, branches, branch logins; AiSensy setup; data migration; branch deactivation |
| Owner | Email + password | Mobile, laptop | Monitor all branches, approve, configure, payroll, campaigns |
| Manager | Email + password | Mobile, tablet | Run assigned branches, staff, approvals, bill edits |
| Branch login | Branch email + password (set by Super Admin) | Tablet or desktop at reception | Calendar, customers, billing, stock, day-end |

**Operating environment**

- Frontend: React + TypeScript single-page app, responsive at 360 px (phone), 768 px (reception tablet) and 1280 px+ (desktop); installable as a PWA; live screens refresh by polling.
- Backend: Node.js + Express REST API in TypeScript, Mongoose ODM, Zod validation.
- Database: MongoDB Atlas replica set (needed for multi-document transactions).
- Cache and queues: Redis (sessions, rate limits, BullMQ job queues).
- File storage: AWS S3 (or Cloudinary) for logos, receipts, ID documents, PDFs.
- Hosting: AWS, Mumbai region (ap-south-1) for latency and data residency.

**Constraints**

- Online-only: every write needs a live server; no offline mode.
- No payment gateway: payment modes are recorded, not processed.
- No hardware integration (no biometric, no barcode printer drivers beyond browser print).
- English only; currency ₹; time zone IST (Asia/Kolkata) for all business dates.
- Team of 2 developers: the design favours one codebase, one database and few external services.
- Free product: infrastructure cost per salon must stay low (NFR section).

**Assumptions**

- Each salon has a stable internet connection and a modern browser at reception.
- Owners create and recharge their own AiSensy accounts; Glox configures them.
- All branches of a GST business sit in one state, so one GSTIN and CGST + SGST apply.

## 3. System architecture

One React app serves every role (Super Admin under \`/admin\`) and talks to one Node.js API; the API owns every rule and every database write, and slow work runs in background workers.

&#91;embedded content: system architecture · 2 apps, 1 API, 3 stores, 3 external services\]

The API enqueues jobs in Redis; workers pick them up, write results to MongoDB and S3, and send WhatsApp messages. The API receives AiSensy webhooks and answers the screens' polling change-checks from Redis. Both run as stateless containers behind a load balancer, so either can scale out independently.

## 4. Authentication and access control

Every API request is authenticated, scoped to one business, and checked against the user's role, assigned branches and permission flags on the server; the frontend only hides what the server already blocks.

**Authentication requirements**

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-AUTH-01 | All users (Super Admin, owner, manager, branch login) sign in with email + password on one login screen. No OTP, no SMS, no sign-up, no self-service password reset. | M |
| FR-AUTH-02 | Super Admin creates owner and branch login credentials; the owner creates manager credentials. Login emails are unique across the platform and need not be real inboxes. | M |
| FR-AUTH-03 | Super Admin accounts are stored separately from salon users and use the same app under `/admin`. | M |
| FR-AUTH-04 | Access token (JWT, 15 min) + refresh token (httpOnly secure cookie): Super Admin 12 h, owner and manager 30 days, branch login 7 days. Refresh tokens rotate on use and are stored hashed in Redis. | M |
| FR-AUTH-05 | Passwords hashed with bcrypt (cost 12); 8–64 characters with at least one letter and one number. 5 failed attempts lock the account for 15 minutes. | M |
| FR-AUTH-06 | No user changes their own password. The owner sets new passwords for managers and branch logins; Super Admin sets the owner's password and can reset any login. Every change is audited. | M |
| FR-AUTH-07 | Owner can sign out all sessions of any manager or branch login; Super Admin can do this for any user. | S |
| FR-AUTH-08 | Setting a password, deactivating a user, branch or business, or changing a user's role or branches revokes that user's sessions immediately. | M |

**Authorisation model.** The token carries `userId`, `role`, `businessId`. On each request the server loads the user's `branchIds` and `permissionFlags` from cache and applies three checks in order:

1. **Tenant check:** every query is filtered by `businessId` through a Mongoose plugin; a query without it throws an error.
2. **Role check:** the route declares the roles allowed (from the PRD permission matrix).
3. **Branch check:** for manager and branch login, the `branchId` in the request must be in the user's branches; list endpoints filter by those branches automatically.

**Permission flags (owner sets per manager):** can manage staff, can approve POs and transfers, can view payroll, can edit branch prices, maximum discount %.

**Permission flags (manager sets per branch login):** can mark attendance.

**Customer phone masking (FR-AUTH-09, M):** the API returns masked phone and email (`98XXXXXX21`) to branch login and manager on list, search and report endpoints. The full value is returned only by the customer-detail endpoint called from the booking or billing screen, and each such call writes a `phone_reveal` audit entry. Exports are owner-only.

## 5. Functional requirements

Each module below lists its requirements with an ID and priority; the PRD section of the same name gives the user-facing context.

### 5.1 Super Admin panel (SA)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-SA-01 | Create a business with name, logo, GST on/off, GSTIN, PAN, address, financial year start, invoice prefix rules. | M |
| FR-SA-02 | Create the owner account (name, phone, email, temporary password) when creating the business. | M |
| FR-SA-03 | Create branches for a business (name, code, address, phone, invoice prefix) and set each branch's login code and password. | M |
| FR-SA-04 | Process owner requests to add or delete a branch: approve, reject with reason. Delete = deactivate; data stays read-only. | M |
| FR-SA-05 | Configure AiSensy per business (API key, project ID, WhatsApp number) and optionally per branch; verify connection; sync templates. | M |
| FR-SA-06 | Run data migration imports for a business from Excel/CSV templates, with validation preview and confirmation. | M |
| FR-SA-07 | Suspend or reactivate a business; suspended businesses cannot log in but keep data. | M |
| FR-SA-08 | Platform dashboard: active businesses, branches, daily bills, WhatsApp sends, error rates. | S |
| FR-SA-09 | Reset any branch or owner password; view audit log of any business. | M |

### 5.2 Organisation and users (ORG)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-ORG-01 | Owner edits business settings: name, logo, GST on/off, GSTIN, GST rate, financial year, discount limits, discount alert threshold, day-end report time. | M |
| FR-ORG-02 | Owner raises a request to add or delete a branch; sees request status. | M |
| FR-ORG-03 | Owner or manager edits branch working hours per weekday, holidays and station count. | M |
| FR-ORG-04 | Owner creates, edits and deactivates managers; assigns one or more branches; sets permission flags. | M |
| FR-ORG-05 | Manager grants or revokes the branch login's "can mark attendance" flag for assigned branches. | M |
| FR-ORG-06 | A user can switch between their assigned branches from a header selector; owner can choose "All branches" for dashboards and reports. | M |

### 5.3 Services and categories (SVC)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-SVC-01 | Owner creates two-level categories with gender, order and active flag. | M |
| FR-SVC-02 | Owner creates a service with name, category, gender, base price, duration (required) and consumables, rebooking cycle, eligible staff, commission (optional). | M |
| FR-SVC-03 | Owner sets a price per branch; manager sets prices for assigned branches only; blank = base price. | M |
| FR-SVC-04 | Owner or manager activates or deactivates a service per branch. | M |
| FR-SVC-05 | Bulk price change by % for a category, optionally for one branch, with preview. | S |
| FR-SVC-06 | Every price, commission or consumable change writes an audit entry with before and after values. | M |
| FR-SVC-07 | A service with past bills cannot be deleted, only deactivated. | M |

### 5.4 Appointments and calendar (APT)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-APT-01 | Day view with one column per working staff member and 15-minute rows for the selected branch; week and list views. | M |
| FR-APT-02 | Create an appointment: find or quick-create customer (name + phone), add one or more services, each with staff (or "any available") and start time. | M |
| FR-APT-03 | Block a booking that overlaps the staff member's other bookings, roster off-time, leave, branch holidays or hours; show the reason. | M |
| FR-APT-04 | Only eligible staff are offered for a service; blank eligibility = all staff of the branch. | M |
| FR-APT-05 | Walk-in: one action creates an appointment starting now with the first free eligible staff member. | M |
| FR-APT-06 | Drag and drop to change time or staff, with the same clash checks. | M |
| FR-APT-07 | Status changes follow the lifecycle in section 7; cancel and no-show need a reason. | M |
| FR-APT-08 | Block time for a staff member (lunch, training) with a note. | S |
| FR-APT-09 | Waitlist entries per day; notify the branch when a matching slot frees. | C |
| FR-APT-10 | "Convert to bill" on an appointment pre-fills a bill with its customer, services and staff. | M |
| FR-APT-11 | Booking source recorded: Walk-in, Phone, WhatsApp. | M |
| FR-APT-12 | Create, reschedule and cancel trigger WhatsApp messages when that automation is on. | S |

### 5.5 Customer CRM (CRM)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-CRM-01 | Customer belongs to the business; phone is unique per business (normalised to +91 10-digit). | M |
| FR-CRM-02 | Profile fields: name, phone, alternate phone, email, gender, DOB, anniversary, address, source, referred by, tags, WhatsApp opt-in, do-not-message, notes. | M |
| FR-CRM-03 | Per-visit service notes, including hair colour formula and product preferences. | S |
| FR-CRM-04 | Profile shows visits, bills, appointments, memberships, packages, wallet ledger, loyalty points, feedback and WhatsApp history. | M |
| FR-CRM-05 | Computed stats updated on each bill: first visit, last visit, visits, total spend, average bill, no-shows, favourite service and staff. | M |
| FR-CRM-06 | Saved segments (new, regular, lapsed 60+ days, high spenders, birthday this month, membership holders, by service, by branch) usable in campaigns. | S |
| FR-CRM-07 | Owner or manager merges two duplicate profiles; bills, ledgers and history move to the kept profile; audit entry written. | S |
| FR-CRM-08 | Phone masking per FR-AUTH-09; owner-only export to Excel. | M |

### 5.6 Billing and invoices (BIL)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-BIL-01 | Branch login, manager and owner create bills with service, product, membership, package, voucher and wallet top-up lines. | M |
| FR-BIL-02 | "Billed by" is required on every bill created by a branch login, chosen from the branch's staff with designation Receptionist. | M |
| FR-BIL-03 | Service lines take one or more staff with % split (total 100%); product lines take the selling staff member. | M |
| FR-BIL-04 | Line discounts and bill discount in ₹ or %; a discount above the user's limit needs manager or owner approval before the bill can be saved. | M |
| FR-BIL-05 | Redeem package sessions, membership discount, loyalty points and wallet balance in the order of BR-01. | M |
| FR-BIL-06 | GST is calculated only when the business has GST on (BR-02). | M |
| FR-BIL-07 | Tips per staff member, each marked "Paid in cash today" or "Add to payroll"; tips are outside sales and GST. | M |
| FR-BIL-08 | Payments in Cash, UPI, Card, Wallet or a split; a fully paid bill needs no approval; a partly paid bill (shortfall becomes customer due) needs manager or owner approval; cash shows change to return. | M |
| FR-BIL-09 | Invoice number from a per-branch, per-financial-year counter, e.g. `SRT1/2026-27/000123`, assigned atomically on save. | M |
| FR-BIL-10 | Tax invoice layout when GST on; plain bill layout when off; A4 and 80 mm thermal print; PDF download. | M |
| FR-BIL-11 | Send bill PDF on WhatsApp through an approved AiSensy template. | S |
| FR-BIL-12 | Only manager (assigned branches) and owner can edit, cancel or refund a bill; reason mandatory. | M |
| FR-BIL-13 | Edit creates a new bill version; the previous version is kept read-only. | M |
| FR-BIL-14 | Cancel reverses stock, wallet, package sessions, loyalty points, commission and tips; the bill stays with status Cancelled. | M |
| FR-BIL-15 | Refund records amount, mode and reason; it reduces that day's collection. | M |
| FR-BIL-16 | Bills on a closed day can be edited or cancelled only by the owner. | M |
| FR-BIL-17 | Collect a customer's pending due on a later bill or as a standalone receipt. | M |
| FR-BIL-18 | Saving a bill is one database transaction covering bill, counter, wallet, stock, packages and audit entry; a failure saves nothing. | M |

### 5.7 Memberships, packages, wallet and loyalty (MEM)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-MEM-01 | Owner defines membership plans: fee, validity days, discount % on services and/or products, branch scope. | M |
| FR-MEM-02 | Owner defines packages: services and session counts, price, validity, branch scope. | M |
| FR-MEM-03 | Owner defines wallet top-up offers: pay amount, credit amount. | M |
| FR-MEM-04 | Selling any of these is a bill line with GST (when on) and commission. | M |
| FR-MEM-05 | Wallet balance is the sum of an append-only ledger; manual adjustments are owner-only with reason. | M |
| FR-MEM-06 | Owner or manager can extend validity, freeze or transfer a package; each action is logged. | S |
| FR-MEM-07 | Expiry reminder on WhatsApp 7 days before; expired value moves to an "expired" ledger entry, never deleted. | S |
| FR-MEM-08 | Loyalty points switched on by owner or manager: earn rate per ₹100, redeem value per point, minimum redemption, expiry days. | C |
| FR-MEM-09 | Gift vouchers with unique code, value, expiry; redeemable once. | C |

### 5.8 Staff, attendance and roster (STF)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-STF-01 | Owner or manager (with flag) creates staff records: name, phone, branch, designation, joining date, services, salary, commission rules, statutory flags, bank reference, documents. | M |
| FR-STF-02 | Designations include Receptionist and Manager; receptionists feed the "Billed by" list; a manager user can link to their staff record. | M |
| FR-STF-03 | Weekly roster per staff member with day overrides. | M |
| FR-STF-04 | Owner or manager marks attendance with in and out times; branch login can mark only if the flag is on. | M |
| FR-STF-05 | Status calculated from roster and times: Present, Late, Half day, Absent; plus Leave, Week off, Holiday. | M |
| FR-STF-06 | Editing past attendance needs a reason and writes an audit entry. | M |
| FR-STF-07 | Leave entered and approved by owner or manager; approved leave blocks the calendar. | M |
| FR-STF-08 | Exiting a staff member keeps all history; they disappear from calendar and billing lists. | M |

### 5.9 Commission and payroll (PAY)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-PAY-01 | Commission rules per staff: service % or ₹, monthly slabs, product sales %, overtime ₹ per hour. Service-level commission overrides the staff default. | M |
| FR-PAY-02 | Commission is calculated per bill line per BR-03 and stored on the line at save time. | M |
| FR-PAY-03 | Monthly payroll run per branch builds a draft per BR-05. | M |
| FR-PAY-04 | PF, ESI and Professional Tax are optional per business and per staff member; rates configurable. | M |
| FR-PAY-05 | Advances and loans recorded with recovery schedule; recovered automatically in runs. | M |
| FR-PAY-06 | Manager adjusts draft lines with reason; owner locks the run; a locked run cannot change. | M |
| FR-PAY-07 | Payslip PDF per staff member; send on WhatsApp. | S |
| FR-PAY-08 | Record payout as paid with mode and date. | M |

### 5.10 Inventory (INV)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-INV-01 | Product master: name, brand, category, type (Retail, Consumable, Both), SKU, purchase and use units with conversion, MRP, selling price, purchase price, HSN, GST %, reorder level per branch. | M |
| FR-INV-02 | Stock is held per branch in two pools (retail, consumable); every change is a stock movement row. | M |
| FR-INV-03 | Billing a service deducts its consumables (per BR-07); billing a product deducts retail stock; cancellation reverses both. | M |
| FR-INV-04 | Stock may go negative; negative stock raises an alert instead of blocking a bill. | M |
| FR-INV-05 | Vendors; purchase orders raised by branch login or manager, approved by owner (or manager with flag); full or partial receipt with batch and expiry. | M |
| FR-INV-06 | Inter-branch transfer: request, approve, dispatch, receive, with mismatch recorded. | M |
| FR-INV-07 | Stock adjustment and internal use with reason; stock audit with variance approval. | M |
| FR-INV-08 | Alerts: low stock, near expiry (30 days), negative stock. | S |

### 5.11 Leads (LED)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-LED-01 | An inbound WhatsApp message from a number not in the CRM creates a lead linked to the conversation. | M |
| FR-LED-02 | Branch login, manager or owner adds a walk-in or phone lead manually. | M |
| FR-LED-03 | Lead stages New, Contacted, Interested, Booked, Lost (reason); assignment and follow-up date. | M |
| FR-LED-04 | Converting a lead creates the customer and opens a new appointment. | M |
| FR-LED-05 | Follow-up reminders in the notification centre on the due date. | S |

### 5.12 WhatsApp (WA)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-WA-01 | One AiSensy number per business by default; a branch may have its own number, set by Super Admin. | M |
| FR-WA-02 | Inbound messages arrive by AiSensy webhook, are matched to customer or lead, and appear in the branch's shared inbox within 10 seconds (polling). | M |
| FR-WA-03 | Free-form replies allowed only inside the 24-hour service window; outside it only approved templates. | M |
| FR-WA-04 | Inbox shows customer panel (last visit, next appointment, wallet) and quick actions: create lead, book, send bill. | S |
| FR-WA-05 | Owner creates campaigns: template, audience (segment, upload, selection), variables, send now or schedule. Opted-out customers are excluded. | M |
| FR-WA-06 | Delivery status (sent, delivered, read, failed) is updated from AiSensy callbacks and shown per message and per campaign. | M |
| FR-WA-07 | Each message stores an estimated cost by category so the owner can see spend per campaign and automation. | S |
| FR-WA-08 | If AiSensy rejects for low balance, sending pauses and the owner is notified to recharge. | M |

### 5.13 Marketing automation (AUT)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-AUT-01 | Owner switches each automation on or off and picks its template and send time: booking confirmation, reminders (24 h, 2 h), rebooking nudge, birthday, anniversary, win-back (60 days), feedback, Google review push, membership expiry, package last session. | M |
| FR-AUT-02 | Feedback replies of 4–5 trigger the Google review link; 1–3 alert owner and manager instead. | S |
| FR-AUT-03 | Guards: max one marketing message per customer per day; quiet hours 21:00–09:00; opt-outs skipped. Transactional messages ignore the daily cap. | M |

### 5.14 Expenses and day-end closure (DAY)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-DAY-01 | Record expenses with category, amount, mode, paid-from (petty cash or bank), note and receipt photo; recurring monthly expenses. | M |
| FR-DAY-02 | Petty cash float per branch with top-ups and cash expenses. | M |
| FR-DAY-03 | Branch login submits closure: counted cash by denomination, UPI and card totals; system shows expected values per BR-06 and differences; difference needs a reason. | M |
| FR-DAY-04 | Manager approves; the day locks (BR-06). | M |
| FR-DAY-05 | At the business's report time the day-end report goes to the owner only on WhatsApp and is stored as PDF; an unclosed branch is reported as "Not closed" with system figures. | M |
| FR-DAY-06 | Owner can reopen a closed day with reason. | S |

### 5.15 Reports and dashboards (RPT)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-RPT-01 | Owner dashboard: today's sales, collection by mode, appointments, branch-wise sales, open closures, alerts, 30-day sales trend. | M |
| FR-RPT-02 | Reports listed in the PRD (sales, branch comparison, service and product profitability, new vs returning, membership liability, staff performance, attendance and payroll, inventory, discounts and cancellations, expenses and P&L, day-end, leads, WhatsApp, GST) with date range and branch filters. | M |
| FR-RPT-03 | Sales reports can group by billed by. | M |
| FR-RPT-04 | GST reports appear only for GST businesses; GSTR-1 export in the government Excel format. | M |
| FR-RPT-05 | Excel and PDF export for owner and managers with payroll or report permission; exports are logged. | M |
| FR-RPT-06 | Reports read pre-aggregated daily summaries; a 12-month report returns in under 3 seconds. | M |

### 5.16 Audit log and notifications (AUD, NOT)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-AUD-01 | Append-only audit entries for every event listed in the PRD audit section, with user, role, branch, billed by, entity, action, before, after, reason, IP, device, time. | M |
| FR-AUD-02 | No API exists to edit or delete audit entries; retention 3 years. | M |
| FR-AUD-03 | Owner and Super Admin search and export; managers view their branches. | M |
| FR-NOT-01 | In-app notification centre with unread count, per user. | M |
| FR-NOT-02 | Notification bell refreshes its unread count by polling every 15 seconds; no browser push. | S |
| FR-NOT-03 | WhatsApp alerts to the owner for large discounts, bill edits or cancels, and branch not closed. | M |
| FR-NOT-04 | Users mute non-critical categories. | C |

### 5.17 Data migration (MIG)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-MIG-01 | Super Admin downloads templates for customers, services, products and opening stock, staff, memberships, packages and wallet balances. | M |
| FR-MIG-02 | Upload shows row-level errors and duplicates before import; import runs as a background job with a summary. | M |
| FR-MIG-03 | Opening balances post as ledger entries marked Imported; owner confirms the summary before go-live. | M |

## 6. Business rules and calculations

All money is computed in integer paise; rounding happens once per line and once on the bill total, never mid-calculation.

**BR-01 Bill calculation order.** For each line: gross = unit price × quantity; minus line discount; minus membership discount (if eligible). Then the bill discount is split across lines in proportion to their value. Package sessions zero the line price. Loyalty points reduce taxable value like a discount. GST (BR-02) is applied to the resulting taxable value per line. Wallet and payments settle the final total.

```latex
\text{Total} = \sum_{\text{lines}} \big(\text{Taxable}_i + \text{GST}_i\big) + \text{Round-off}
```

**BR-02 GST.** Applies only when the business has GST on. Prices are GST-exclusive by default (owner may switch to inclusive). Services use the business GST rate (default 18%, SAC 9983); products use their own HSN rate. Tax per line is split equally into CGST and SGST, each rounded to the paisa. Tips, wallet top-ups and due collections carry no GST. Wallet redemption is a payment mode, so it does not reduce GST.

**BR-03 Commission.** Calculated per line on the taxable value (after all discounts, before GST), never including GST, for GST and non-GST businesses alike. Example: ₹1,000 service + ₹180 GST at 10% = ₹100. Order of precedence: service-level rule, else the staff member's default rule. Monthly slabs apply to the staff member's total service taxable value for the month, recalculated at payroll. Split lines divide commission by the split %. Package redemptions pay commission on the package's per-session value. Cancelled bills reverse commission.

**BR-04 Bill approval.** If any line or bill discount % exceeds the creating user's limit, or payments are less than the total (partly paid), the bill is held as "Awaiting approval" until a manager (assigned branch) or owner approves in-app. Discounts above the owner's alert threshold notify the owner even when approved.

**BR-05 Payroll.**

```latex
\text{Net pay} = \text{Salary}\times\frac{\text{Paid days}}{\text{Days in month}} + \text{Commission} + \text{Overtime} + \text{Incentives} + \text{Tips}_{\text{payroll}} - \text{Advances} - \text{PF} - \text{ESI} - \text{PT} - \text{Other deductions}
```

Paid days = Present + Late + Leave (paid) + Week off + Holiday + 0.5 × Half day. Overtime hours = clock-out time beyond rostered end, in 30-minute blocks. PF, ESI and PT apply only where switched on, using the rates stored in business settings.

**BR-06 Day-end.** Expected cash = opening float + cash received + cash due collections − cash refunds − cash expenses − tips paid in cash − cash deposited. Expected UPI and card = sums of those payment modes for the day. Once approved, the business date is locked for that branch: no new bills for that date; edits and cancels on it need the owner.

**BR-07 Consumable deduction.** For each billed service line, each consumable's quantity (in use units) × line quantity is deducted from the branch consumable pool at bill save. Stock is held in use units; purchases convert with the product's conversion factor (e.g. 1 bottle = 1,000 ml).

**BR-08 Metrics**

| Metric | Formula |
| --- | --- |
| Utilisation % | Booked service minutes ÷ rostered minutes, per staff per period |
| Rebooking rate | Customers served by a staff member who return to that staff member within the service's rebooking cycle ÷ customers served |
| Average bill value | Net sales ÷ bills (excluding cancelled) |
| New customer | First ever bill in the business falls in the period |
| Returning customer | Has a bill in the period and at least one earlier bill |
| Lapsed customer | No bill for 60+ days |
| Membership liability | Wallet balances + (unused package sessions × per-session value) on the report date |
| Service margin | Taxable service value − consumable cost (purchase price × quantity used) |

**BR-09 Numbering and dates.** Financial year runs 1 April to 31 March. Invoice numbers are `<branch prefix>/<FY>/<6-digit sequence>`, reset each financial year, never reused, including for cancelled bills. Business date = IST calendar date.

**BR-10 Due amounts.** A partly paid bill creates a customer due. Dues are settled oldest first when collected.

## 7. Status lifecycles

The server rejects any status change not listed here with error `INVALID_TRANSITION`; every transition is stamped with user and time.

**Appointment**

| From | To | Who | Condition |
| --- | --- | --- | --- |
| — | Booked | Branch, manager, owner | Passes clash checks |
| Booked | Confirmed | Branch, manager, owner, or customer WhatsApp reply | — |
| Booked, Confirmed | Arrived | Branch, manager, owner | Appointment date is today |
| Arrived | In service | Branch, manager, owner | — |
| In service | Completed | Branch, manager, owner | — |
| Completed | Billed | System | Bill saved from this appointment |
| Booked, Confirmed | Cancelled | Branch, manager, owner | Reason required |
| Booked, Confirmed | No-show | Branch, manager, owner | After start time; reason optional |

**Bill**

| From | To | Who | Condition |
| --- | --- | --- | --- |
| — | Awaiting approval | System | Discount above creator's limit, or payments < total (BR-04) |
| Awaiting approval | Paid or Partly paid | Manager, owner | Approved |
| Awaiting approval | Rejected | Manager, owner | Reason required; no stock or ledger effect |
| — | Paid | Creator | Payments = total |
| — | Partly paid | Creator | Owner only, payments < total; due created (others go to Awaiting approval) |
| Partly paid | Paid | Branch, manager, owner | Due collected |
| Paid, Partly paid | Edited (new version) | Manager, owner | Reason; owner only on closed day |
| Paid, Partly paid | Cancelled | Manager, owner | Reason; reversals per FR-BIL-14 |
| Paid | Refunded or Partly refunded | Manager, owner | Reason, mode |

**Other entities**

| Entity | States in order | Side exits |
| --- | --- | --- |
| Purchase order | Draft → Pending approval → Approved → Partly received → Received | Rejected, Cancelled |
| Stock transfer | Requested → Approved → Dispatched → Received (with mismatch noted) | Rejected, Cancelled |
| Day closure | Open → Submitted → Approved (locked) | Reopened by owner → Submitted |
| Payroll run | Draft → Reviewed → Locked → Paid | — |
| Lead | New → Contacted → Interested → Booked | Lost (reason) |
| Leave | Requested → Approved | Rejected |
| Customer plan | Active → Expired or Used up | Frozen ↔ Active, Transferred |
| Branch | Active → Deactivation requested → Deactivated (read-only) | Request rejected → Active |
| Campaign | Draft → Scheduled → Sending → Completed | Paused (low balance), Cancelled |

## 8. Data requirements

Data lives in one MongoDB Atlas cluster, shared by all businesses, with `businessId` on every tenant document and MongoDB's default `_id` (ObjectId) as the key. The full field-level ERD is a separate deliverable; this section fixes the rules it must follow.

**Modelling rules**

| ID | Rule |
| --- | --- |
| DR-01 | Embed what is always read and written together and is bounded in size: bill lines, payments, tips and taxes inside a bill; working hours and holidays inside a branch; settings inside a business. |
| DR-02 | Reference (separate collection) what grows without limit or is queried alone: wallet ledger, stock movements, audit logs, attendance, WhatsApp messages, bill versions. |
| DR-03 | Bill lines snapshot service or product name, price, GST rate, HSN/SAC and staff name, so later edits never change old invoices. |
| DR-04 | Money fields are integers in paise; quantities in integer use units (ml, g, pieces). |
| DR-05 | Every document has `createdAt`, `updatedAt`, `createdBy`, `updatedBy`; soft delete uses `deletedAt`. Bills, ledgers, stock movements and audit logs are never deleted. |
| DR-06 | Ledgers are append-only; balances (`stockBalances`, wallet balance on customer) are caches rebuilt from the ledger by a nightly check job. |
| DR-07 | Multi-collection writes (bill save, cancel, refund, transfer receipt, payroll lock, day closure) run in a MongoDB transaction. |
| DR-08 | Readable numbers (invoice, PO, transfer) come from a `counters` collection updated with atomic `$inc` inside the same transaction. |
| DR-09 | A Mongoose plugin adds `businessId` to every query and rejects queries without it; branch-scoped queries also require `branchId`. |
| DR-10 | Dates of business events store both a UTC timestamp and an IST `businessDate` string (`YYYY-MM-DD`) for daily grouping. |

**Collections**

| Group | Collections |
| --- | --- |
| Platform | platformAdmins, businesses, branches, branchRequests, counters |
| People | users, staff, customers |
| Catalogue | categories, services, products, vendors |
| Operations | appointments, bills, billVersions, dues, expenses, pettyCash, dayClosures |
| Prepaid | plans, customerPlans, walletLedger, loyaltyLedger, giftVouchers |
| Stock | stockMovements, stockBalances, purchaseOrders, transfers, stockAudits |
| Staff | attendance, rosters, leaves, advances, payrollRuns, payslips |
| Growth | leads, waNumbers, waTemplates, waConversations, waMessages, campaigns, automations, feedback |
| System | auditLogs, notifications, dailySummaries, importJobs |

**Retention:** bills, ledgers and payroll kept for 8 years (Indian tax record rules); audit logs 3 years; WhatsApp messages 2 years; notifications 90 days (TTL index).

## 9. External interfaces

The system depends on two external services (AiSensy and AWS S3) plus an internal PDF service; each sits behind one internal adapter so it can be swapped without touching business code.

| Interface | Used for | Direction | Failure behaviour |
| --- | --- | --- | --- |
| AiSensy API | Send templates and session messages, sync templates | Outbound, per business API key | Retry 3 times with backoff; then mark failed and notify owner |
| AiSensy webhooks | Inbound messages, delivery and read status | Inbound, signed callback URL per business | Store raw payload first, process in a queue; duplicates ignored by message ID |
| AWS S3 | Logos, receipts, ID documents, generated PDFs | Signed upload and download URLs, 15-minute expiry | Upload error shown; record saved without file |
| PDF generation | Invoices, payslips, day-end reports | Internal service (headless Chrome or PDFKit) in a job queue | Retry; on failure the bill stays valid, PDF regenerated on demand |
|  |  |  |  |

**User interface requirements**

- Layout: left navigation on desktop, bottom navigation on phone; branch selector in the header.
- Reception screens (calendar, new bill, customer search) are usable at 768 px with touch targets of 44 px or more.
- Keyboard shortcuts on desktop: new bill, new appointment, customer search.
- Every list has search, filters, pagination of 25/50/100 and an empty state.
- Destructive or financial actions (cancel bill, lock payroll, approve closure) need a confirm dialog that repeats the amount.
- Printing: browser print with dedicated A4 and 80 mm stylesheets; no printer drivers.

## 10. API conventions

The backend is a REST API at `/api/v1`, JSON only, with the same conventions for every endpoint so the two developers can work in parallel.

**Conventions**

- Resources are plural nouns: `/branches/{id}/appointments`, `/bills/{id}/cancel`. Actions that change status are `POST` sub-routes.
- Branch-scoped routes take `branchId` in the path; the server checks it against the user (section 4).
- Requests validated with Zod schemas shared with the frontend; unknown fields rejected.
- Responses: `{ data, meta }` on success; `{ error: { code, message, fields } }` on failure with standard HTTP codes (400, 401, 403, 404, 409 for clashes and version conflicts, 422 for rule failures, 429, 500).
- Lists: `?page=&limit=&sort=&q=` plus filters; `meta.total` returned.
- Money in paise as integers; dates as ISO 8601 UTC, business dates as `YYYY-MM-DD`.
- Writes that may be retried (bill save, payment) accept an `Idempotency-Key` header; a repeat returns the first result.
- Optimistic concurrency on edits: client sends the document version; mismatch returns 409.
- No sockets: live screens poll \`GET /changes\` (open chat 5 s; inbox list and bills 10 s; calendar and notification bell 15 s) and refetch only when a change is reported.

**Endpoint groups**

| Group | Base path | Main operations |
| --- | --- | --- |
| Auth | `/auth` | login, refresh, logout, me |
| Super Admin | `/admin` | businesses, owners, branches, branch-requests, whatsapp-config, imports |
| Business | `/business` | settings, managers, permissions, branch-requests |
| Branches | `/branches/{id}` | hours, holidays, staff list, dashboard |
| Services | `/categories`, `/services` | CRUD, branch prices, bulk price |
| Appointments | `/branches/{id}/appointments` | CRUD, move, status, waitlist |
| Customers | `/customers` | CRUD, search, merge, history, segments |
| Bills | `/branches/{id}/bills` | create, approve, edit, cancel, refund, pdf, send, dues |
| Plans | `/plans`, `/customers/{id}/plans`, `/customers/{id}/wallet` | define, sell, redeem, ledger, adjust |
| Staff | `/staff`, `/branches/{id}/attendance`, `/rosters`, `/leaves` | CRUD, mark, approve |
| Payroll | `/branches/{id}/payroll-runs` | create, adjust, lock, payslips, mark-paid |
| Inventory | `/products`, `/vendors`, `/branches/{id}/stock`, `/purchase-orders`, `/transfers` | CRUD, movements, approve, receive, audit |
| Leads | `/leads` | CRUD, stage, convert |
| WhatsApp | `/whatsapp` | conversations, messages, templates, campaigns, automations, webhooks |
| Day-end | `/branches/{id}/expenses`, `/branches/{id}/closures` | create, submit, approve, reopen |
| Reports | `/reports/{name}` | query, export |
| Audit and notifications | `/audit-logs`, `/notifications` | search, export, mark read |

## 11. Background jobs and schedulers

All slow or scheduled work runs in BullMQ queues on Redis, outside the request path; each job is idempotent so a retry never sends twice or posts twice.

| Job | Trigger | What it does |
| --- | --- | --- |
| whatsapp-send | Enqueued by billing, automation, campaigns | Calls AiSensy, stores status and cost; 3 retries with backoff |
| whatsapp-webhook | AiSensy callback | Matches number to customer or lead, stores message, bumps the inbox change counter |
| automation-scan | Every 15 minutes | Finds due reminders, rebooking nudges, birthdays, win-backs, expiries; enqueues sends respecting guards |
| day-end-report | Per business at report time | Builds report for each branch (closed or not), sends to owner, stores PDF |
| daily-summary | On bill save, cancel, edit; full rebuild nightly at 02:00 IST | Updates `dailySummaries` per branch per date |
| ledger-check | Nightly 03:00 IST | Rebuilds wallet and stock balances from ledgers; alerts Glox on mismatch |
| pdf-generate | On request | Renders invoice, payslip, report PDF to S3 |
| stock-alerts | After stock movement; nightly expiry scan | Low, negative and near-expiry alerts |
| plan-expiry | Nightly 00:30 IST | Expires memberships, packages, vouchers, loyalty points; posts expiry ledger entries |
| payroll-draft | Owner or manager starts a run | Computes BR-05 for every staff member of the branch |
| import | Super Admin upload | Validates, then imports in batches of 500 rows |
| campaign-send | Scheduled time | Splits audience into batches respecting AiSensy rate limits |
|  |  |  |

**Monitoring:** failed jobs are kept 7 days and visible in the Super Admin panel; more than 1% failures in an hour alerts Glox.

## 12. Non-functional requirements

The system must serve 12,000 businesses in its first year from one shared deployment, with response times that keep a reception desk moving.

| ID | Area | Requirement |
| --- | --- | --- |
| NFR-01 | Performance | Calendar day view and new-bill screen load in < 2 s at p95; bill save < 1 s at p95; search results < 500 ms. |
| NFR-02 | Performance | Reports over 12 months return in < 3 s using daily summaries. |
| NFR-03 | Scale | Designed for 12,000 businesses, \~30,000 branches, 1.5 million bills per month and about 1,500 requests per second at peak (evening hours), most of them lightweight polling change-checks answered from Redis. |
| NFR-04 | Availability | 99.5% monthly uptime; planned maintenance only 01:00–05:00 IST with 24 h notice. |
| NFR-05 | Backup | Atlas continuous backup with point-in-time restore for 7 days; daily snapshots kept 30 days; restore tested quarterly. |
| NFR-06 | Security | HTTPS only (TLS 1.2+); Helmet headers; CORS limited to app domains; rate limits (login 5 per minute per IP, API 300 per minute per user). |
| NFR-07 | Security | AiSensy keys and bank references encrypted at rest with a key in AWS KMS; never returned to the frontend. |
| NFR-08 | Security | Tenant isolation tested by automated tests that try cross-business and cross-branch access on every endpoint. |
| NFR-09 | Privacy | Follows the Digital Personal Data Protection Act 2023: WhatsApp consent stored per customer, owner can export or delete a customer's personal data on request (bills kept with name anonymised). |
| NFR-10 | Auditability | Every financial change traceable to user, time and reason (section 5.16). |
| NFR-11 | Usability | A new receptionist can create an appointment and a bill without training in under 2 minutes in a usability test. |
| NFR-12 | Compatibility | Latest two versions of Chrome, Edge, Safari, Firefox; Android 10+ Chrome; iOS 16+ Safari. |
| NFR-13 | Observability | Structured JSON logs with request ID, user, business; error tracking (e.g. Sentry); uptime and latency dashboards. |
| NFR-14 | Maintainability | TypeScript strict mode; shared Zod types between frontend and backend; 70%+ unit test coverage on billing, payroll and stock rules. |
| NFR-15 | Cost | Target infrastructure under ₹2 per active branch per month at 12,000 businesses; PDFs generated on demand, images compressed to under 300 KB, logs archived after 90 days. |
| NFR-16 | Deployment | CI/CD with automated tests; staging environment mirroring production; zero-downtime deploys. |

## 13. Acceptance criteria and test plan

A release is accepted when every M requirement passes its test and the end-to-end salon day below runs clean on staging with real AiSensy messages.

**Test levels**

| Level | Scope | Tool |
| --- | --- | --- |
| Unit | BR-01 to BR-10 calculations, status transitions, permission checks | Jest |
| API integration | Every endpoint: happy path, validation, role, branch and tenant isolation | Jest + Supertest on a test MongoDB replica set |
| End-to-end | Key user journeys in the browser at 360, 768 and 1280 px | Playwright |
| Load | NFR-01 to NFR-03 targets | k6 |
| User acceptance | Pilot salons run real days | Manual, with checklist |

**Key acceptance scenarios**

1. **Full salon day:** branch login books 3 appointments, converts one walk-in, raises bills with a split payment, a tip and a package redemption; manager approves an over-limit discount; branch closes the day; owner receives the WhatsApp report at the set time with matching totals.
2. **GST off vs on:** the same bill in a non-GST business prints a plain bill with no tax lines; in a GST business it prints a tax invoice with CGST and SGST that match BR-02 to the paisa.
3. **Commission:** a ₹1,000 + GST service at 10% commission gives ₹100 commission in both GST and non-GST businesses.
4. **Cancel reversal:** cancelling a bill restores consumable and retail stock, wallet balance, package session, loyalty points, commission and tips, and the audit log shows before and after.
5. **Isolation:** a manager of Branch A gets 403 for any Branch B record; a user of Business X gets 404 for any Business Y record.
6. **Masking:** branch login sees masked numbers in customer list and reports, full number in the billing screen, and the reveal is audited.
7. **Closed day:** after approval, the branch cannot bill for that date; a manager cannot edit a bill on it; the owner can, with reason.
8. **Payroll:** a staff member with salary, absences, overtime, commission slab, payroll tips, an advance and PF on produces a payslip matching BR-05 by hand calculation.
9. **Inventory:** billing a service with 30 ml consumable deducts 30 ml; receiving a PO of 2 bottles of 1,000 ml adds 2,000 ml; a transfer with a mismatch records the difference.
10. **WhatsApp:** inbound message from a new number creates a lead; reply outside 24 h is blocked except templates; low AiSensy balance pauses a campaign and notifies the owner.
11. **Concurrency:** two receptionists saving bills in the same second get consecutive invoice numbers with no gap or duplicate.
12. **Branch deactivation:** after Super Admin deactivates a branch, its login stops working and its data stays visible read-only to the owner.

## 14. Assumptions and open items

All earlier assumptions were confirmed or corrected on 26 Oct 2026; only the launch date remains open.

| Topic | Decision |
| --- | --- |
| Login | Email + password for every role; no OTP, no SMS, no email service |
| Password changes | Owner sets manager and branch passwords; Super Admin sets owner passwords; no self-service |
| App | One web app for all roles; Super Admin under `/admin` |
| Live updates | Polling, no Socket.IO: open chat 5 s, inbox list and bills 10 s, calendar and bell 15 s |
| Push notifications | None (no Firebase); in-app bell and WhatsApp alerts to owner |
| Bill approval | Fully paid bills need none; partly paid bills and over-limit discounts need manager or owner |
| Backend | Mongoose with TypeScript |
| Prices | GST-exclusive by default, owner can switch to inclusive |
| Branch session | 7 days |
| Day-end report | 23:00 IST by default |
| Retention, scale and cost targets | Accepted as written |
| Launch date | Not set; phases follow the PRD release plan |

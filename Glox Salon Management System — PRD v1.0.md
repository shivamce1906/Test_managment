# Glox Salon Management System — PRD v1.0

Oct 26, 2026 · @Jagdish Kumawat

## 1. Product overview

Glox Salon Manager is a free, multi-branch salon operating system: one owner login runs every branch's appointments, billing, staff, stock, customers and WhatsApp from a single responsive web dashboard.

**Problem.** Indian multi-branch salon owners lose money to untracked discounts, deleted bills, stock leakage and staff they cannot measure. Most run on registers, Excel or tools built for single outlets.

**Goals for v1**

- Every rupee billed in any branch is visible to the owner the same day, with an audit trail.
- A receptionist can book an appointment in under 30 seconds and raise a bill in under 60 seconds.
- Owners re-engage customers automatically on WhatsApp (reminders, rebooking, birthdays, win-back).
- Payroll, commission and stock run from the system, not Excel.

**Fixed product decisions**

| Decision | Value |
| --- | --- |
| Product | Separate SaaS, not linked to the Glox marketplace booking flow |
| Vertical | Salon only (spa and clinic later) |
| Platform | Responsive web only (desktop, tablet, mobile browser) |
| Connectivity | Online-only; no offline mode |
| Pricing | Completely free; Glox sets up AiSensy, owner pays WhatsApp registration and per-message costs |
| Payments | No gateway; bill records cash, UPI, card or a split |
| GST | Optional per business; when on, one common GSTIN (head branch) for all branches |
| Roles | Four fixed roles: Super Admin (Glox), Owner, Manager, Branch login |
| Hardware | None; attendance is marked in the web app |
| Language | English only |
| Scale target | 12,000 salons in year one |
| Team | 2 developers (1 frontend, 1 backend) |

**Out of scope for v1:** spa and clinic modules, payment gateway, Glox marketplace integration, offline billing, custom roles, hardware integrations, regional languages, native mobile apps, Reserve with Google, self-serve data import (Glox migrates data manually).

## 2. Release plan

Nothing is built yet and the launch date is open, so the plan uses relative months from the start of development (2 developers, existing Glox Node.js, MongoDB and React stack). Month 1 starts when development starts.

| Module | Phase | Target |
| --- | --- | --- |
| Super Admin panel (businesses, owners, branches, branch logins, AiSensy setup) | P1 MVP | Month 1–3 |
| Owner, managers and permissions | P1 MVP | Month 1–3 |
| Services and categories (branch-wise prices) | P1 MVP | Month 1–3 |
| Appointments and calendar | P1 MVP | Month 1–3 |
| Customer CRM (with phone masking) | P1 MVP | Month 1–3 |
| Billing and invoices (GST optional, split payment, tips, billed by) | P1 MVP | Month 1–3 |
| Audit log | P1 MVP | Month 1–3 |
| Expenses and day-end closure | P1 MVP | Month 1–3 |
| Core reports (sales, branch comparison, day-end) | P1 MVP | Month 1–3 |
| Memberships, packages and wallet | P2 | Month 4–5 |
| Inventory (retail, consumables, transfers, POs) | P2 | Month 4–5 |
| Staff, attendance, roster, commission | P2 | Month 4–5 |
| WhatsApp inbox and campaigns (AiSensy) | P2 | Month 4–5 |
| Notifications centre | P2 | Month 4–5 |
| Full payroll (tips, optional PF, ESI, PT) | P3 | Month 6–7 |
| Leads | P3 | Month 6–7 |
| Marketing automation | P3 | Month 6–7 |
| Staff performance and advanced reports (GSTR-1, profitability, liability) | P3 | Month 6–7 |

The MVP rule: a salon must be able to run a full day (book, serve, bill, close the day) before any growth feature ships. Billing, audit log and day-end closure come before WhatsApp because they are the owner's main reason to adopt.

## 3. Organisation, branches and roles

The system has four fixed roles. Glox Super Admin controls businesses and branches; the owner runs the business; managers run assigned branches; each branch has one shared login used by its receptionists. Stylists and other staff are records, not users.

**Hierarchy and who creates what**

- **Super Admin (Glox):** creates the business, the owner account, every branch and each branch's login credentials; sets up AiSensy; runs data migration; deactivates branches on the owner's request.
- **Owner:** cannot create or delete branches; requests a new branch or a branch deletion from Super Admin. Creates managers, assigns each one or more branches, and switches individual manager permissions on or off.
- **Manager:** works only in assigned branches; adds and edits staff records; can grant the branch login extra permissions (for example, marking attendance).
- **Branch login:** one credential per branch, shared by that branch's receptionists; access to that branch only, never other branches.

**Branch deletion:** the owner raises a request; Super Admin deactivates the branch. Its bills, customers and reports stay available read-only to the owner; nothing is erased.

**Business settings (owner):** business name, logo, GST on/off, GSTIN and PAN (if GST on), registered address, financial year, discount limits, day-end report time. Invoice prefix and WhatsApp numbers are set by Super Admin.

**Branch settings (owner or manager):** working hours per weekday, holiday list, chairs/stations count, receptionist names for the "Billed by" list. Name, address and login are managed by Super Admin.

**Permission matrix** (Full = create, edit, delete; Branch = full but only in assigned branches; Create = add new records only; View = read only; None = hidden)

| Module | Super Admin | Owner | Manager | Branch login |
| --- | --- | --- | --- | --- |
| Businesses, owners, branches, branch logins | Full | Request only | None | None |
| Business settings | Full | Full | None | None |
| Managers and their permissions | View | Full | None | None |
| Staff records | View | Full | Branch | None |
| Services and categories | None | Full | View | View |
| Branch-wise service prices | None | Full | Branch | None |
| Appointments | None | Full | Branch | Full (own branch) |
| Customers (CRM) | None | Full | Branch | Create and edit, masked lists |
| Create bill | None | Full | Branch | Create |
| Edit, cancel or refund bill | None | Full | Branch, reason required | None |
| Discounts | None | Unlimited | Up to owner-set % | Up to owner-set % |
| Memberships, packages, wallet | None | Full | Branch | Sell and redeem |
| Inventory stock and usage | None | Full | Branch | Branch |
| Purchase orders and transfers | None | Approve | Branch (raise, approve if allowed) | Raise and receive |
| Attendance | None | Full | Branch | Only if manager allows |
| Roster and leave | None | Full | Branch | View |
| Payroll | None | Full | Branch (draft) | None |
| Expenses | None | Full | Branch | Add |
| Day-end closure | None | Full | Branch (approve) | Submit |
| Leads | None | Full | Branch | Full (own branch) |
| WhatsApp inbox | Setup only | Full | Branch | Full (own branch) |
| WhatsApp campaigns and automation | Setup only | Full | View | None |
| Reports | Platform usage | All branches | Assigned branches | Own day summary |
| Audit log | Full | Full | Branch (view) | None |

**Customer phone masking.** The branch login sees full numbers only inside the booking and billing screens; customer lists, reports and searches show "98XXXXXX21". Only the owner can export customer data. Every reveal of a full number is written to the audit log.

## 4. Services and categories

The owner maintains one service catalogue for the business; each branch can have its own price for any service.

**Category:** name, parent category (two levels, e.g. Hair → Colour), gender (Men, Women, Unisex), display order, active flag.

**Service fields**

| Field | Required | Notes |
| --- | --- | --- |
| Name | Yes |  |
| Category | Yes |  |
| Gender | Yes | Men, Women, Unisex |
| Base price (₹) | Yes | Default price for every branch |
| Duration (min) | Yes | Drives calendar slot length |
| Consumables used | No | Product + quantity per service, for auto-deduction (section 10) |
| Rebooking cycle (days) | No | Triggers rebooking nudge (section 13) |
| Eligible staff | No | Which staff can perform it; blank = all |
| Staff commission | No | Fixed ₹ or % of service value; overrides the staff member's default rate |

**Branch-wise prices:** each branch can override the base price. The owner can set prices for any branch; a manager can set prices for assigned branches only; the branch login cannot change prices. Blank override = base price. Every price change is written to the audit log.

**GST on services:** when GST is on for the business, services use one GST rate set in business settings (default 18%); when off, no tax is applied.

**Bulk actions:** bulk price change by % per category or branch, duplicate service, activate or deactivate per branch.

## 5. Appointments and calendar

The calendar is the receptionist's home screen: one column per stylist, one row per 15 minutes, for the selected branch and day.

**Views:** day (stylist columns), week, list. Filters: branch, stylist, status. On mobile the day view collapses to one stylist at a time with swipe.

**Booking an appointment**

1. Search customer by name or phone, or create a new one inline (name + phone is enough).
2. Pick one or more services; each line takes a stylist (or "Any available") and a start time.
3. System checks the stylist's roster, existing bookings and service duration, and blocks clashes.
4. Save; a WhatsApp confirmation goes to the customer if automation is on.

**Statuses:** Booked → Confirmed → Arrived → In service → Completed → Billed. Side exits: Cancelled (reason required), No-show.

**Other features**

- Walk-ins: one tap creates an appointment starting now with the first free eligible stylist.
- Drag and drop to move time or stylist; reschedule sends an updated WhatsApp message.
- Blocked time per stylist (lunch, training, personal).
- Waitlist for a fully booked day; receptionist is notified when a slot frees.
- Customer notes and last visit shown in the booking drawer.
- "Convert to bill" on a completed appointment pre-fills the bill.
- Booking source recorded: Walk-in, Phone, WhatsApp.

**Rules:** appointments cannot be created outside branch hours or on branch holidays; stylists on leave are hidden for that day; no-show count is stored on the customer profile.

## 6. Customer CRM

Customers belong to the business, not a branch, so a client served in any branch has one profile and one history.

**Profile:** name, phone (unique per business), alternate phone, email, gender, date of birth, anniversary, address, source (Walk-in, Phone, WhatsApp, Referral), referred by, tags (VIP, Bride, Regular…), WhatsApp opt-in flag, notes.

**Service notes:** free-text notes per visit plus structured fields for hair colour formula, skin type and product preferences; shown in the booking drawer and on the bill screen.

**Profile tabs:** visits and bills, appointments (upcoming and past), memberships and packages, wallet balance and ledger, loyalty points, feedback given, WhatsApp chat history, audit of changes.

**Computed fields:** first visit, last visit, total visits, total spend, average bill value, favourite service, favourite stylist, no-show count, days since last visit.

**Segments (saved filters)** used by campaigns and automation: new (1 visit), regular (3+ visits in 90 days), lapsed (no visit in 60+ days), high spenders (top 10% by spend), birthday this month, membership holders, by service taken, by branch visited.

**Rules:** duplicate check on phone at creation; merge two profiles (owner and manager only, logged); masking per section 3; customer can be marked "Do not message".

## 7. Billing and invoices

A bill records services, products and membership sales against one customer, applies discounts and redemptions, adds tips, and closes with one or more payment modes; no payment gateway is involved. The branch login can only create bills; editing, cancelling and refunding are for the manager or owner.

**Bill header:** branch, date, customer, and **Billed by** (receptionist name picked from the branch's list). Billed by is honour-based, not a separate login, and is used in reports and the audit log.

**Bill lines:** services (with staff member), retail products (with selling staff), memberships, packages, gift/wallet top-ups. A service line can carry more than one staff member with a % split for commission.

**Adjustments, applied in this order:**

1. Line discounts (₹ or %).
2. Bill discount (₹ or %).
3. Package or membership redemption.
4. Loyalty point redemption (if enabled).
5. GST on the post-discount value, only if GST is on for the business.
6. Wallet redemption, then payment.

**Discount limits:** the owner sets a maximum discount % for managers and for the branch login. Above it, the bill needs manager or owner approval in-app; any discount above the owner's alert threshold notifies the owner.

**Tips:** entered on the bill against one or more staff members. Tips are not part of sales, carry no GST and no commission. Each tip is marked either "Paid in cash today" or "Add to payroll"; payroll picks up the second kind.

**Payment:** Cash, UPI, Card, Wallet, or any split of these. Partial payment creates a due amount on the customer, collected on a later bill. Cash entered against amount payable shows change to return.

**Invoice format depends on GST setting**

| Business setting | Document | Contents |
| --- | --- | --- |
| GST on | Tax invoice | Business GSTIN (common for all branches), branch address, invoice number, date, customer name and phone (and GSTIN if given), SAC/HSN per line, taxable value, CGST and SGST, total in figures and words |
| GST off | Bill | Business and branch details, bill number, date, customer, lines, discounts, total; no tax lines or GSTIN |

Numbering: one sequence per branch per financial year, e.g. `SRT1/2026-27/000123`.

**Delivery:** A4 and 80 mm thermal print layouts, PDF download, and WhatsApp send via AiSensy template.

**Edit, cancel and refund (manager or owner only)**

- A reason is mandatory for every edit, cancel or refund.
- Editing creates a new version; the original stays viewable.
- Cancelling never deletes; the bill is marked Cancelled, its stock, commission and tips reverse, and it appears in the cancelled-bills report.
- Refunds are recorded with mode and reason and reduce that day's collection.
- Bills from a closed day (section 14) can be edited only by the owner.

Every create, edit, cancel and refund is written to the audit log with before and after values and the Billed by name.

## 8. Memberships, packages and wallet

Three prepaid instruments, all valid across every branch of the business unless the owner restricts them to selected branches.

| Instrument | What the customer buys | How it is used | Example |
| --- | --- | --- | --- |
| Membership | A plan for a fee and validity period | Flat % discount on services and/or products for the validity period | ₹2,000 for 12 months, 20% off all services |
| Package | A fixed set of service sessions | Each visit redeems one or more sessions | 6 facials for ₹9,000, valid 6 months |
| Wallet | Prepaid balance, often with bonus | Deducted on any bill like cash | Pay ₹10,000, get ₹12,000 credit |

**Common rules**

- Each has validity (days), branch scope, and an expiry reminder on WhatsApp 7 days before.
- Sale is a bill line, so it carries GST (when on) and staff commission like any sale.
- Owner can extend validity, freeze (pause) a membership, or transfer a package to another customer; each action is logged.
- Expired unused value is reported, not silently deleted.

**Wallet ledger:** every credit (top-up, bonus, refund) and debit (redemption, expiry, manual adjustment) is a ledger row with bill reference, user and timestamp. Balance = sum of the ledger, never an editable field.

**Loyalty points (optional, switched on by owner or manager):** earn X points per ₹100 spent, redeem at a set ₹ value per point, minimum redemption, expiry in days.

**Gift vouchers:** fixed-value code sold on a bill, redeemable once by any customer before expiry.

## 9. Staff: attendance, roster, commission and payroll

Staff are records managed by the owner and managers; they have no login. Staff records drive the calendar (who can work when), commission (what they earned) and payroll (what they are paid).

**Staff record:** name, phone, branch, joining date, designation (Senior Stylist, Beautician…), services they can perform, salary type and amount, default commission rates, statutory flags (PF, ESI, PT), bank details for payout reference, ID document upload, emergency contact, active/exited.

**Attendance**

- Marked by the owner or a manager. A manager can allow the branch login to mark attendance for that branch.
- Each entry records clock-in and clock-out time, so late marks and overtime come from it.
- Statuses: Present, Late, Half day, Absent, Leave, Week off, Holiday. Late and half-day thresholds set per branch.
- Edits to past attendance need a reason and are logged.

**Roster:** weekly shift template per staff member (e.g. 10:00–20:00, Tuesday off) with day-level overrides, set by owner or manager. Leave is entered and approved by the owner or manager; approved leave blocks the calendar.

**Earnings.** Four sources, each configurable per staff member:

| Source | Basis | Example setting |
| --- | --- | --- |
| Service commission | % or ₹ per service, or slab on monthly service sales | 10% up to ₹50,000; 15% above |
| Product sales | % of retail product value sold | 5% of product sales |
| Overtime | ₹ per hour beyond rostered shift, from attendance | ₹100 per hour |
| Tips | Amount entered on bills | Passed through in full |

**Commission basis:** always calculated on the post-discount value before GST. No GST is ever added to commission, whether or not the salon has GST. Example: ₹1,000 service + ₹180 GST at 10% = ₹100 commission. Commission reverses automatically when a bill is cancelled.

**Payroll (monthly run)**

1. System builds a draft per staff member: fixed salary prorated by attendance, plus commission, overtime, incentives and tips marked "Add to payroll", minus advances, loan instalments and other deductions.
2. PF, ESI and Professional Tax are optional: off by default, switched on per business and per staff member.
3. Manager reviews the draft for assigned branches and adjusts lines with a reason.
4. Owner locks the payroll and generates payslips (PDF), which can be sent to each staff member on WhatsApp.
5. Payment is recorded as paid with mode and date (no payout integration).

**Advances:** recorded with date and amount, recovered in one or several payroll runs.

**Staff performance (dashboard and report):** leaderboard by revenue, utilisation % (booked hours ÷ rostered hours), rebooking rate (customers who return to the same staff member within the service cycle), average bill value, product sales, tips, feedback rating.

## 10. Inventory

Stock is tracked per branch in two separate pools: retail (sold to customers) and consumables (used in services and deducted automatically).

**Product master (business level):** name, brand, category, type (Retail, Consumable, or Both), SKU/barcode, unit of purchase and unit of use (e.g. 1 bottle = 1,000 ml), MRP, selling price, purchase price, HSN code, GST %, reorder level per branch.

**Stock movements.** Every change is a movement row, so stock = sum of movements:

| Movement | Trigger | Effect |
| --- | --- | --- |
| Purchase receipt | Goods received against a PO | + branch stock |
| Retail sale | Product line on a bill | − retail stock |
| Service consumption | Service completed and billed | − consumable stock, per service recipe |
| Transfer out / in | Approved inter-branch transfer | − sender, + receiver on receipt |
| Adjustment | Damage, expiry, audit correction (reason required) | ± stock |
| Bill cancellation | Cancelled bill | Reverses sale and consumption |
| Internal use | Manually issued for salon use | − consumable stock |

**Auto-deduction:** each service (and variant) lists consumables with quantity in unit of use. On billing, those quantities are deducted from the branch's consumable pool. Stock may go negative; negative stock is flagged on the dashboard instead of blocking a bill.

**Vendors and purchase orders**

1. Branch login or manager raises a PO: vendor, branch, items, quantity, rate.
2. Owner (or manager, if allowed) approves.
3. Goods received fully or partially against the PO, with batch and expiry date if applicable.
4. Vendor bill amount and payment status recorded (paid, partly paid, due).

**Inter-branch transfer:** request → approve (owner or manager of sending branch) → dispatch → receive, with quantity mismatch recorded on receipt.

**Stock audit:** physical count sheet per branch; system shows variance and posts adjustments after approval.

**Alerts:** low stock (below reorder level), near-expiry (30 days), negative stock.

## 11. Leads

Leads are enquiries that have not yet become a booking; v1 captures them from WhatsApp and from walk-in or phone enquiries.

**Capture**

- WhatsApp: a new number messaging the business creates a lead automatically, linked to the chat.
- Walk-in or phone: receptionist adds a lead manually (name, phone, interested service, notes).

**Lead fields:** name, phone, source, branch, interested services, budget (optional), assigned to, stage, follow-up date, notes.

**Stages:** New → Contacted → Interested → Booked (converted) or Lost (reason required).

**Workflow:** follow-up reminders appear in the notification centre on the due date. Converting a lead creates the customer and opens the booking drawer. The lead report shows count by source, conversion rate and average days to convert per branch.

## 12. WhatsApp (via AiSensy)

Glox connects each business's WhatsApp Business number through AiSensy; the owner recharges their own AiSensy account for registration and per-message charges.

**Numbers:** one number for the whole business by default. On the owner's request, Glox links a separate number to any branch; messages from that branch's customers then go through the branch number.

**Setup flow (Glox Super Admin only):** Glox creates the AiSensy account for the owner → enters API key and project details in the Super Admin panel → system verifies the connection → approved templates sync into the business dashboard. The owner never handles API keys.

**Shared inbox**

- All conversations for the branch (or business) in one list, with unread count and assignment to a user.
- Customer profile panel beside the chat: last visit, upcoming appointment, wallet balance.
- Quick actions from chat: create lead, book appointment, send bill PDF.
- Free-form replies only inside WhatsApp's 24-hour service window; outside it, only approved templates can be sent.

**Campaigns (bulk)**

1. Pick an approved template.
2. Pick an audience: a CRM segment, an uploaded list, or selected customers. Customers marked "Do not message" or without opt-in are excluded automatically.
3. Fill template variables (name, offer, date).
4. Send now or schedule.
5. Track sent, delivered, read, replied and failed counts.

**Transactional messages** (used by billing and automation): booking confirmation, reminder, reschedule, cancellation, bill PDF, feedback request, membership expiry.

All WhatsApp traffic is stored against the customer profile.

## 13. Marketing automation

Automations are owner-controlled WhatsApp rules that run on a schedule; each can be switched on or off and edited per business, with a template and send time.

| Automation | Trigger | Default timing | Message |
| --- | --- | --- | --- |
| Booking confirmation | Appointment created or rescheduled | Immediately | Date, time, branch, stylist |
| Appointment reminder | Upcoming appointment | 24 h and 2 h before | Reminder with confirm / reschedule reply |
| Rebooking nudge | Days since service ≥ service's rebooking cycle | 10:00 on due day | "Time for your root touch-up" |
| Birthday offer | Customer birthday | 09:00, 3 days before | Offer code valid 15 days |
| Anniversary offer | Customer anniversary | 09:00, 3 days before | Offer code |
| Win-back | No visit for 60 days | Once, 10:00 | Comeback offer |
| Post-service feedback | Bill closed | 2 h after | Rating 1–5 |
| Google review push | Feedback rating 4 or 5 | Immediately after rating | Link to branch's Google review page |
| Low rating alert | Feedback rating 1–3 | Immediately | Internal alert to owner and manager, not to customer |
| Membership expiry | 7 days before expiry | 10:00 | Renew reminder |
| Package sessions left | Last session remaining | After bill | Renew reminder |

**Guards:** maximum one marketing message per customer per day; no sends between 21:00 and 09:00; opted-out customers skipped; every send logged with cost estimate so the owner sees WhatsApp spend per automation.

## 14. Expenses and day-end closure

Each branch closes every business day by reconciling counted cash and digital collections against the system; the final report goes to the owner only, on WhatsApp, at a set time.

**Expenses:** date, branch, category (Rent, Electricity, Salary advance, Tea and snacks, Repairs, Marketing, Other), amount, payment mode, paid from (petty cash or bank), note, receipt photo. Recurring expenses (rent, internet) can be scheduled monthly.

**Petty cash:** each branch has an opening float; expenses paid in cash reduce it; top-ups are recorded by the manager.

**Day-end closure flow**

1. The branch login opens "Close day". System shows expected cash = opening cash + cash collections − cash refunds − cash expenses − tips paid in cash.
2. The branch enters counted cash by denomination, plus UPI and card totals from the machine or app.
3. System shows the difference per mode; any difference needs a reason.
4. Manager approves. The day locks: new bills for that date are blocked and edits need the owner.
5. At the owner-set time (default 22:00), the day-end report is sent to the owner on WhatsApp and stored as PDF. If the branch has not closed by then, the report is still sent, marked "Not closed", using system figures.

**Day-end report contents:** total sales, collection by mode, bills count, average bill, services vs products, new vs returning customers, discounts given (and by whom), cancelled or edited bills, expenses, cash difference, top stylist, tomorrow's appointment count.

## 15. Reports and analytics

The owner sees every report across all branches or for one branch; managers see only their assigned branches. Every report has a date-range picker, branch filter, and Excel/PDF export (owner and allowed managers only).

**Owner home dashboard:** today's sales, collections by mode, appointments today, branch-wise sales today, open day-end closures, low-stock count, alerts. Period trend chart (sales by day) and branch ranking.

| Report | Key measures |
| --- | --- |
| Sales summary | Gross sales, discounts, net sales, GST, collections by mode, by day / branch / billed by |
| Branch comparison | Net sales, bills, average bill, new customers, utilisation, expenses, profit per branch |
| Service performance | Count, revenue, discount, consumable cost and margin per service |
| Product performance | Units, revenue, purchase cost and margin per product |
| Customer: new vs returning | New, returning and lapsed customers per period and branch |
| Membership liability | Unused wallet balance, unredeemed package sessions (₹ value), active memberships |
| Staff performance | Leaderboard, utilisation %, rebooking rate, average bill value, commission earned |
| Attendance and payroll | Present/late/absent days, overtime hours, tips, payroll cost |
| Inventory | Stock on hand, valuation, consumption per service, low stock, expiry, variance |
| Discounts and cancellations | Discount by user and branch, cancelled and edited bills with reasons |
| Expenses and P&L | Expenses by category, simple P&L (net sales − product cost − expenses − payroll) |
| Day-end closures | Closure status and cash differences per branch and day |
| Leads | By source, stage, conversion rate |
| WhatsApp | Messages sent, delivered, read, cost estimate per campaign and automation |
| GST (GSTR-1 ready; GST businesses only) | B2B and B2C invoices, HSN/SAC summary, document summary, credit notes; Excel in GSTR-1 format |

Reports read from pre-aggregated daily summaries (section 18) so they load in under 3 seconds for a year of data.

## 16. Audit log and notifications centre

**Audit log.** An append-only record that nobody, including the owner, can edit or delete.

- Logged events: bill create, edit, cancel, refund; discount above limit and its approver; price or commission change; stock adjustment; wallet manual adjustment; attendance marked or edited; payroll edit and lock; day-end closure and reopen; customer merge, export, phone reveal; user created, role or branch changed; login from new device.
- Each row: timestamp, user, role, branch, entity and ID, action, before value, after value, reason, IP and device.
- Filters by date, branch, user, action; owner can export. Actions by a branch login are recorded against the branch, with the Billed by name on bills.

**Notifications centre**

| Alert | Who receives it | Channels |
| --- | --- | --- |
| Low or negative stock | Owner, manager, branch login | In-app, push |
| New lead | Assigned user, manager | In-app, push |
| Appointment cancelled or no-show | Branch login, manager | In-app, push |
| Discount above alert threshold | Owner | In-app, push, WhatsApp |
| Bill edited or cancelled | Owner | In-app, push, WhatsApp |
| Branch not closed at report time | Owner | Push, WhatsApp |
| Day-end report | Owner | WhatsApp |
| Low feedback rating | Owner, manager | In-app, push |
| Leave request, PO or transfer awaiting approval | Approver | In-app, push |
| Lead follow-up due | Assigned user | In-app |

Push is browser web push. On iPhone it works only after the user adds the site to the home screen (PWA), so onboarding must prompt for that. Each user can mute categories except owner-critical alerts.

## 17. Data migration

The Glox team migrates each new salon's existing data manually; there is no self-serve import screen for owners.

**Migrated by Glox:** customers (with wallet balance and DOB), services and categories with branch prices, products with opening stock per branch, staff records, active memberships and packages with remaining value or sessions.

**Internal tooling (Super Admin only):** Excel/CSV templates, a validation step that lists row-level errors and duplicates, and a background import job. Opening balances (wallet, packages) are posted as ledger entries marked "Imported" and written to the audit log. The owner checks a summary and confirms before the salon goes live.

## 18. Non-functional requirements

The system must support 12,000 businesses in year one on shared infrastructure, with every query scoped by business ID.

| Area | Requirement |
| --- | --- |
| Multi-tenancy | Every collection carries `businessId` (and `branchId` where relevant); enforced in middleware, never trusted from the client |
| Performance | Calendar and billing screens load in < 2 s; reports in < 3 s for 12 months of data |
| Reporting | Daily summary documents per branch built on bill close and day-end, so reports never scan raw bills |
| Background jobs | Queue (e.g. BullMQ on Redis) for WhatsApp sends, automations, imports, PDFs, payroll runs |
| Availability | 99.5% monthly uptime; daily automated MongoDB backups, 30-day retention, point-in-time recovery |
| Security | JWT with refresh tokens, OTP login, role and branch checks on every API, rate limiting, HTTPS only, encrypted AiSensy keys |
| Data privacy | Phone masking (section 3), owner-only export, audit of reveals; follows India's DPDP Act 2023 requirements for consent and deletion requests |
| Browser support | Latest Chrome, Edge, Safari, Firefox; tablet layout for reception; mobile layout for owner and staff |
| Time zone and money | IST, ₹, amounts stored in paise as integers to avoid rounding errors |
| Responsiveness | Calendar and bill screens usable at 768 px width (reception tablet) |

**Cost note:** the product is free, so infrastructure cost per salon must stay low. Store PDFs on demand rather than generating every invoice, keep images compressed, and archive raw logs older than 12 months.

## 19. Data model outline (MongoDB)

All collections except `businesses` carry `businessId`; branch-level data also carries `branchId`. Ledgers (stock, wallet, audit) are append-only.

| Collection | Key fields | Main indexes |
| --- | --- | --- |
| businesses | name, gstEnabled, gstin, gstRate, pan, invoiceSettings, discountLimits, dayEndReportTime, whatsappConfig (encrypted), flags | — |
| branches | businessId, name, address, hours\[\], holidays\[\], invoicePrefix, whatsappNumberId, billedByNames\[\], status (active, deactivated) | businessId |
| users | businessId, role (superadmin, owner, manager, branch), name, phone or username, branchIds\[\], permissionFlags, status | businessId+role |
| branchRequests | businessId, type (create, delete), branchId, status, handledBy | businessId+status |
| staff | businessId, branchId, name, phone, designation, serviceIds\[\], salary, commissionRules, roster, statutoryFlags, status | branchId |
| categories | businessId, name, parentId, gender, order | businessId |
| services | businessId, categoryId, name, gender, basePrice, duration, consumables\[\], rebookDays, eligibleStaffIds\[\], commission, branchPrices\[{branchId, price}\] | businessId+categoryId |
| customers | businessId, name, phone, dob, anniversary, tags\[\], optIn, stats{visits, spend, lastVisit}, notes | businessId+phone (unique), businessId+stats.lastVisit |
| appointments | businessId, branchId, customerId, lines\[{serviceId, staffId, start, end}\], status, source | branchId+date, staffId+start |
| bills | businessId, branchId, invoiceNo, billedBy, customerId, lines\[\], discounts, gstApplied, taxes, tips\[{staffId, amount, payout}\], payments\[\], status, version, dayClosed | branchId+date, businessId+invoiceNo (unique), customerId |
| billVersions | billId, version, snapshot, editedBy, reason | billId |
| plans | businessId, type (membership, package, voucher), rules, validityDays, branchScope | businessId |
| customerPlans | customerId, planId, balanceSessions, validTill, status | customerId, validTill |
| walletLedger | customerId, type, amount, billId, by, at | customerId+at |
| products | businessId, name, type, units, prices, hsn, gstPct, reorderLevels{} | businessId |
| stockMovements | branchId, productId, pool, qty, type, refId, by, at | branchId+productId |
| stockBalances | branchId, productId, pool, qty (cached) | branchId+productId (unique) |
| vendors, purchaseOrders, transfers | businessId, branchIds, items\[\], status, approvals\[\] | businessId+status |
| attendance | staffId, branchId, date, in, out, status, markedBy | staffId+date (unique) |
| leaves, advances, payrollRuns, payslips | staffId, month, lines\[\], status | staffId+month |
| expenses | branchId, category, amount, mode, date, receiptUrl | branchId+date |
| dayClosures | branchId, date, expected{}, counted{}, diff{}, status, approvedBy, reportSentAt | branchId+date (unique) |
| leads | businessId, branchId, phone, source, stage, assignedTo, followUpAt | businessId+stage, followUpAt |
| waConversations, waMessages | businessId, numberId, customerId, direction, templateId, status, cost | conversationId+at |
| campaigns, automations | businessId, templateId, audience, schedule, stats | businessId |
| feedback | billId, customerId, staffIds\[\], rating, comment | branchId+date |
| notifications | userId, type, payload, readAt | userId+createdAt |
| auditLogs | businessId, branchId, userId, billedBy, entity, entityId, action, before, after, reason, ip, at | businessId+at, entity+entityId |
| dailySummaries | branchId, date, sales, collections, tips, counts, byService, byStaff, byBilledBy | branchId+date (unique) |

## 20. Decisions log

All open questions are settled except the launch date.

| Topic | Decision |
| --- | --- |
| Launch date | Not set; nothing built yet. Phases run in relative months (section 2) |
| Roles | Super Admin, Owner, Manager, Branch login; staff have no login |
| Branches | Created only by Super Admin; owner requests deletion; deleted branches are deactivated and kept read-only |
| Branch login | One credential per branch, shared by receptionists; creates bills only; "Billed by" name on every bill |
| Bill edit, cancel, refund | Manager or owner only, with reason |
| GST | Optional per business; when on, one common GSTIN for all branches |
| Commission | Always on post-discount value before GST; no GST on commission |
| Service prices | Base price plus branch-wise prices; owner and managers (assigned branches) can change them |
| Tips | On the bill, paid in cash same day or added to payroll |
| Attendance | Marked by owner or manager; branch login only if a manager allows it |
| PF, ESI, Professional Tax | Optional |
| Loyalty points | Optional, switched on by owner or manager |
| WhatsApp | Glox sets up AiSensy; owner recharges own account |
| Day-end report | Sent to owner only, on WhatsApp, at a set time |
| Pricing | Completely free |
| Reserve with Google | Not offered |
| Data migration | Done manually by Glox |

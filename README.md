# Glox Salon Management System — Backend

A complete, production-grade, multi-tenant backend architecture built specifically for the Glox Salon Management System following the specifications in **PRD v1.0**, **Backend SRS v1.0**, **SRS v1.0**, and **Database Design v1.0**.

---

## 1. System Architecture & Tech Stack

- **Runtime & Language**: Node.js (v20+ LTS / v26) & TypeScript 5.6+ with strict typing.
- **Framework**: Express 4.x with Helmet, CORS, Compression, and custom Request ID tracing.
- **Database**: MongoDB 7.0+ (utilizing Replica Set transactions `withTransaction` for ACID compliance) with Mongoose 8.x.
- **Multi-Tenancy**: Tenant-isolated query filtering via `tenantScopePlugin` enforcing strict `businessId` query scoping.
- **Caching & Locks**: Redis (via `ioredis` with automatic graceful fallback to `ioredis-mock`).
- **Job Processing & Workers**: BullMQ with isolated background queues for WhatsApp messages, automations, day-end closures, PDF generation, and system maintenance.
- **Financial Arithmetic**: Strict integer paise and basis points (bps) with pro-rata distribution to eliminate floating-point drift.
- **Authentication**: JWT access tokens (15m TTL) with rotating cryptographic refresh tokens and token-reuse breach detection (BR-09).

---

## 2. Project Architecture & Directory Layout

Following the clean layered MVC architecture specified in `markdown.md`:

```text
src/
├── config/             # Environment variables, DB connections (env.ts, db.ts)
├── controllers/        # Request handlers (extracts req data, calls services, sends res)
├── services/           # Core business logic and database queries/operations
├── models/             # Database schemas/models & plugins (Mongoose schemas, tenantScopePlugin)
├── routes/             # Express route definitions pointing to controller methods
├── middlewares/        # Custom middlewares (auth, branch, role, permission, validate, errorHandler, rateLimiter)
├── utils/              # Reusable helper functions (money, dates, crypto, errors, masking, logger)
├── validations/        # Request schema validation (Zod schemas)
├── types/              # TypeScript types and Express request context augmentations
├── integrations/       # External adapters (AiSensy WhatsApp, AWS S3, Redis, PDF generation)
├── workers/            # BullMQ queues, worker processors, and scheduler
├── app.ts              # Express app setup (middleware registration, CORS, route mounting)
├── server.ts           # Server entry point (starts HTTP server, connects to DB, graceful shutdown)
└── worker.ts           # Background worker entry point (starts BullMQ queues and scheduler)
```

---

## 3. Environment Setup & Prerequisites

### Prerequisites
1. **Node.js**: v20.x or higher
2. **MongoDB**: v7.0+ configured as a **Replica Set** (required for transactions).
   - If running locally with Docker:
     ```bash
     docker run -d --name mongo-rs -p 27017:27017 mongo:7.0 --replSet rs0
     docker exec -it mongo-rs mongosh --eval "rs.initiate()"
     ```
3. **Redis**: v7.0+
   - If running locally with Docker:
     ```bash
     docker run -d --name redis -p 6379:6379 redis:7.0-alpine
     ```

### Configuration
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Key configuration items in `.env`:
- `MONGODB_URI`: Must include `?replicaSet=rs0`.
- `REDIS_URL`: Redis connection URL.
- `JWT_SECRET`: Minimum 32-character secret key.
- `KMS_KEY_ID`: Master encryption key for phone & customer PII.
- `AISENSY_BASE_URL` & `AISENSY_API_KEY`: AiSensy WhatsApp credentials.

---

## 4. Building and Running

### Install Dependencies
```bash
npm install
```

### Type Checking & Build
```bash
# Verify TypeScript type correctness across all packages and apps
npm run typecheck

# Compile TypeScript to JavaScript distribution files
npm run build
```

### Running the API Server
Start the backend server directly with:
```bash
npm run dev
```
This launches the server with live TypeScript reload using `tsx watch` on `http://localhost:4000`. (If local MongoDB is not running, it automatically boots an in-memory replica set for frictionless local development).

### Running the Background Worker
```bash
# Development mode
npm run dev:worker

# Production mode
npm run start:worker
```

---

## 5. Running Automated Tests

All tests execute against an in-memory MongoDB replica set (`MongoMemoryReplSet`) with full ACID transaction support and in-memory Redis:

```bash
# Run all unit and integration test suites
npm test

# Run tests with code coverage report
npm run test:coverage
```

### Verified Test Suites:
1. `tests/unit/money.test.ts` — Integer paise math, basis points, 50-50 GST split, pro-rata distribution, round-offs.
2. `tests/unit/dates.test.ts` — IST conversion (+05:30), Financial Year calculation, slot clash overlap detection.
3. `tests/unit/billing.compute.test.ts` — Tax compute, pre-tax net commissions (BR-02), redemptions, dues (BR-03).
4. `tests/integration/auth.test.ts` — Login, 5-attempt lockout (BR-09), refresh token rotation, token reuse revocation.
5. `tests/integration/tenant_isolation.test.ts` — Cross-tenant 404 isolation, branch permission enforcement.
6. `tests/integration/dayend.test.ts` — Petty cash expenses, daily closure submission, day-locking (BR-06), owner reopen.
7. `tests/integration/appointment.test.ts` — Booking, slot clash detection (BR-04), status lifecycle transitions.
8. `tests/integration/inventory.test.ts` — PO approval & receiving, stock adjustments, inter-branch transfer dispatch & receive (BR-07).
9. `tests/integration/billing.test.ts` — Preview calculations, invoice numbering (BR-08), stock deduction on sale & restoration on cancel (BR-07, BR-08), refunds.

---

## 6. Business Rules Implemented

- **BR-01 (Financial Arithmetic)**: Integer paise, no floating point. Pro-rata remainder allocation to the highest net line item.
- **BR-02 (Staff Commission Computation)**: Computed on pre-tax net after line and bill discount deductions.
- **BR-03 (Split Payments & Dues)**: Supports multiple payment modes per bill; uncollected amounts recorded as customer dues.
- **BR-04 (Slot Clash & Overlap Prevention)**: Checks branch hours, staff roster, leaves, existing appointments, and staff blocks.
- **BR-05 (Staff Attendance & Overtime)**: Overtime threshold tracking, leave deductions, and statutory deductions (PF, ESI, PT).
- **BR-06 (Day-End Closure & Expense Controls)**: Till cash tracking against petty cash float; day lock prevents further expenses until approved or reopened by owner.
- **BR-07 (Inventory & Stock Reconciliation)**: Retail vs Consumable pools; auto stock deduction on billing and restoration on cancellation; physical audits.
- **BR-08 (Concurrency & Invoice Numbering)**: Atomic counters inside MongoDB transactions with branch prefixes and FY resets.
- **BR-09 (Account Lockout Policy)**: 5 consecutive failed logins trigger a 15-minute lockout.
- **BR-10 (Prepaid & Loyalty Wallet Controls)**: Dedicated ledgers for top-ups, debits, refunds, and redemptions.

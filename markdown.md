Act as a Principal Backend Architect. My current backend codebase has become disorganized and needs to be restructured into a clean, maintainable, scalable, and production-ready architecture following industry best practices.

### Objectives:
1. Reorganize all existing files into a standard layered backend architecture (MVC / Clean Separation of Concerns).
2. Clean up imports/exports, resolve circular dependencies, and isolate business logic from transport layers.
3. Keep the application fully functional without breaking existing database schemas, API routes, or business logic.

### Desired Folder Structure:
Restructure the project inside `src/` (or the project root) to strictly adhere to this layout:

src/
├── config/             # Environment variables, DB connections (e.g., db.js, passport.js)
├── controllers/        # Request handlers (extracts req data, calls services, sends res)
├── services/           # Core business logic and database queries/operations
├── models/             # Database schemas/models (e.g., Mongoose, Prisma, or Sequelize)
├── routes/             # Express route definitions pointing to controller methods
├── middlewares/        # Custom middlewares (auth, validation, error handler, rate limiters)
├── utils/              # Reusable helper functions, formatters, and API response wrappers
├── validations/        # Request schema validation (e.g., Zod, Joi, or express-validator)
├── types/              # TypeScript types/interfaces (if TypeScript is used)
├── app.js              # Express app setup (middleware registration, CORS, route mounting)
└── server.js           # Server entry point (starts server, connects to DB, graceful shutdown)

### Rules & Instructions:
1. **Audit & Move:** Review my current files and map every file to its proper destination according to the structure above.
2. **Separation of Concerns:** 
   - Remove database queries and complex logic from route files and controllers; move that logic into `services/`.
   - Controllers should only parse HTTP input (`req.params`, `req.body`, `req.query`), call the corresponding service, and return standardized JSON responses.
3. **Import Path Fixes:** Update all relative import/export statements (`require` or `import`) across the entire repository to reflect the new paths.
4. **Centralized Error Handling:** Ensure errors are passed to `next(err)` and caught by a centralized error-handling middleware in `middlewares/errorHandler.js`.
5. **Configuration Cleanup:** Ensure hardcoded secrets/ports are extracted to `.env` and loaded securely through `config/`.

### Output Format:
- Provide a step-by-step file relocation mapping (Old Path -> New Path).
- Show the exact code modifications for files where imports or logic separation need updating.
- Provide any shell commands (`mv`, `mkdir -p`) needed to execute the reorganization quickly.

Here is my current project tree / file list and code:
[PASTE YOUR CURRENT FILE LIST OR CODEBASE CONTEXT HERE]
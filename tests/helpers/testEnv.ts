/**
 * MUST be the first import of every test file.
 *
 * Forces a safe, fully isolated environment before any src/ module reads
 * process.env. dotenv never overrides variables that are already set, so the
 * values below win over the developer's .env file (which points at a live
 * Atlas cluster). Tests connect only to an in-memory MongoDB replica set.
 */
import os from 'os';
import path from 'path';

const GUARD_URI = 'mongodb://127.0.0.1:1/__tests_must_never_use_this__';

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = GUARD_URI;
process.env.MONGO_URI = GUARD_URI;
process.env.LOG_LEVEL = 'silent';
process.env.RUN_EMBEDDED_WORKER = 'false';
process.env.RUN_STANDALONE_WORKER = 'true';
process.env.UPLOAD_DIR = path.join(os.tmpdir(), 'glox-test-uploads');
process.env.JWT_SECRET = 'test-only-jwt-secret-at-least-32-characters-long';
process.env.KMS_KEY_ID = 'test-only-kms-key';

export const TEST_GUARD_URI = GUARD_URI;

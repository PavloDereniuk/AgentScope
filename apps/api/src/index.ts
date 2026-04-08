/**
 * AgentScope API public entry.
 *
 * Task 3.1 started with a standalone `app`; task 3.5 replaced it with a
 * `buildApp(deps)` factory so tests can wire in a PGlite database and a
 * fake Privy verifier instead of touching real infrastructure. This
 * module now just re-exports the factory and shared types.
 *
 * Lifecycle (port bind, env loading) lives in `./server.ts`.
 */

export { buildApp, type AppDeps } from './app';
export type { ApiEnv, ApiVariables } from './middleware/auth';

// Provides dummy env for unit tests that import env-validating modules (logger, gateways).
// Runs before any unit test file is imported (vitest setupFiles).
import { setTestEnv } from "./e2e/helpers/env.js";

setTestEnv();

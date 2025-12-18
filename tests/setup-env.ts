// Ensure API keys are present during tests so runOracle doesn't fail early when CI
// runs without real credentials.
import os from 'node:os';
import path from 'node:path';

process.env.OPENAI_API_KEY ||= 'sk-test';
process.env.GEMINI_API_KEY ||= 'gm-test';
process.env.ORACLE_MIN_PROMPT_CHARS ||= '1';
// Avoid writing under ~/.oracle in constrained environments; keep test sessions isolated.
process.env.ORACLE_HOME_DIR ||= path.join(os.tmpdir(), `oracle-tests-${process.pid}`);
delete process.env.ORACLE_ENGINE;
delete process.env.ORACLE_REMOTE_HOST;
delete process.env.ORACLE_REMOTE_TOKEN;

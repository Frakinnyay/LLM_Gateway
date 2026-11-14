/** Two projects: `unit` needs no services; `integration` needs PostgreSQL (pgvector) + Redis (see tests/integration/helpers.ts). */
const transform = {
  '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json', diagnostics: { ignoreCodes: [6059, 18002, 18003, 151002] } }],
};
const base = { preset: 'ts-jest', testEnvironment: 'node', transform };

module.exports = {
  testTimeout: 30000, // global option (not allowed inside a project)
  projects: [
    { ...base, displayName: 'unit', roots: ['<rootDir>/tests/unit'], testMatch: ['**/*.test.ts'] },
    { ...base, displayName: 'integration', roots: ['<rootDir>/tests/integration'], testMatch: ['**/*.test.ts'] },
  ],
};
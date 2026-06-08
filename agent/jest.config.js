/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // We test in isolation; no live Casper / MCP needed.
  testTimeout: 15000,
  // Map src imports so tests can be in `tests/` and still resolve.
  moduleNameMapper: {
    '^(\\.\\.?/)+src/(.*)$': '<rootDir>/src/$2',
  },
  // csprCloud modules use top-level await patterns; allow it.
  globals: {
    'ts-jest': {
      isolatedModules: true,
    },
  },
  // We mock the network, so transformIgnorePatterns stays default.
  setupFiles: ['<rootDir>/tests/setup.ts'],
};

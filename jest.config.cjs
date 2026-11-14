module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  modulePaths: ['<rootDir>/src/node_modules'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup-tenant-header.cjs'],
  collectCoverageFrom: ['src/**/*.js'],
  coverageDirectory: 'coverage',
  coveragePathIgnorePatterns: ['/node_modules/'],
  verbose: true,
};

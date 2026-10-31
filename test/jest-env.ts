// Never sign test tokens with the application's local or production secret.
process.env.JWT_SECRET = 'test-only-jwt-secret-not-for-real-deployments';
// Existing e2e tests and their temporary DB schemas must never share real cache.
process.env.REDIS_URL = '';

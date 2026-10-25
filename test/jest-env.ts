// Never sign test tokens with the application's local or production secret.
process.env.JWT_SECRET = 'test-only-jwt-secret-not-for-real-deployments';

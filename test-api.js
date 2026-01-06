// Quick test script for API endpoints
const apiClient = require('./src/apiClient');

async function test() {
  console.log('Testing DentDoc Desktop App API...\n');
  console.log('API Base URL:', apiClient.getBaseUrl());
  console.log('');

  // Test login
  console.log('1. Testing login...');
  try {
    const email = process.argv[2];
    const password = process.argv[3];

    if (!email || !password) {
      console.log('Usage: node test-api.js <email> <password>');
      process.exit(1);
    }

    const loginResult = await apiClient.login(email, password);
    console.log('✓ Login successful!');
    console.log('  User:', loginResult.user.email);
    console.log('  Minutes:', loginResult.user.minutesRemaining);
    console.log('  Token:', loginResult.token.substring(0, 20) + '...');
    console.log('');

    // Test get user
    console.log('2. Testing get user...');
    const user = await apiClient.getUser(loginResult.token);
    console.log('✓ Get user successful!');
    console.log('  Email:', user.email);
    console.log('  Minutes:', user.minutesRemaining);
    console.log('');

    console.log('All tests passed! ✓');
  } catch (error) {
    console.error('✗ Test failed:', error.message);
    if (error.response) {
      console.error('  Status:', error.response.status);
      console.error('  Data:', error.response.data);
    }
    process.exit(1);
  }
}

test();

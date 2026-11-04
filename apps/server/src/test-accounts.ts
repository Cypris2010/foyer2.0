// Fixed accounts for local testing, created by `test:seed`. Never use them on a
// real installation: the passwords are public (this repository is public).
// The server warns at startup while any of them exists.
import type { Role } from '@foyer/slide-sdk';

export const TEST_DOMAIN = 'test.local';

export const TEST_ACCOUNTS: Array<{ email: string; name: string; role: Role; password: string }> = [
  { email: `admin@${TEST_DOMAIN}`, name: 'Test-Admin', role: 'admin', password: 'test-admin-1234' },
  { email: `redaktion@${TEST_DOMAIN}`, name: 'Test-Redaktion', role: 'editor', password: 'test-redaktion-1234' },
  { email: `ansicht@${TEST_DOMAIN}`, name: 'Test-Ansicht', role: 'viewer', password: 'test-ansicht-1234' },
];

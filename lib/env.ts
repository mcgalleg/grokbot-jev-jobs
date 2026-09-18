import { config } from 'dotenv';

/**
 * Next.js loads .env.local automatically; plain Node scripts do not.
 * Import this first from any script that talks to the Gateway.
 */
config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Add it to .env.local`);
  return value;
}

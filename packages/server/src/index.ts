import { parseArgs } from 'node:util';
import {
  type BootOptions,
  boot,
  computeOwnerProfileId,
  promptHiddenPassword,
  readPasswordStdin,
} from '@owl/daemon';
import { resolveServerConfig } from './config.js';
import { embeddedWebRoot } from './embedded.js';

// Subcommand dispatch — deliberately dumb (no commander) so the default `boot`
// path and the `compute-owner` bootstrap helper never fight over argv parsing.
if (process.argv[2] === 'compute-owner') {
  await runComputeOwner();
} else {
  const options: BootOptions = {
    resolveConfig: resolveServerConfig,
    embeddedWebRoot: embeddedWebRoot(),
  };
  await boot(options);
}

/**
 * `owl-server compute-owner --server-url <url> --email <email> [--password-stdin]`
 * — one-shot login that prints the owner profileId for `[daemon].account_lock`,
 * then discards the token. The startup guard's account_lock error tells
 * operators to run exactly this, so the bin must provide it.
 */
async function runComputeOwner(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      'server-url': { type: 'string' },
      email: { type: 'string' },
      'password-stdin': { type: 'boolean' },
    },
  });
  const serverUrl = values['server-url'];
  const email = values.email;
  if (!serverUrl || !email) {
    console.error(
      'Usage: owl-server compute-owner --server-url <url> --email <email> [--password-stdin]',
    );
    process.exit(1);
  }
  try {
    const password = values['password-stdin']
      ? await readPasswordStdin()
      : await promptHiddenPassword('Password: ');
    const profileId = await computeOwnerProfileId({ serverUrl, email, password });
    // profileId is the ONLY thing on stdout → pipe-friendly.
    console.log(profileId);
  } catch (err) {
    console.error(`compute-owner failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

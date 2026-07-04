import readline from 'node:readline';

// Shared by the daemon CLI (`owl compute-owner`) and the packaged owl-server bin
// (`owl-server compute-owner`), both of which prompt for a skybridge password.

/** Read a password from stdin (everything up to the trailing newline). */
export async function readPasswordStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString('utf-8')
    .replace(/\r?\n$/, '');
}

/** Prompt for a password on a TTY without echoing it. */
export function promptHiddenPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    let prompted = false;
    // Override readline's internal writer to print the prompt once and swallow
    // the echo of typed characters.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (): void => {
      if (!prompted) {
        process.stdout.write(prompt);
        prompted = true;
      }
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

import { createInterface } from 'node:readline';

/** Ask a question on the terminal. Hidden input never echoes what is typed. */
export function ask(question: string, options: { hidden?: boolean } = {}): Promise<string> {
  if (!process.stdin.isTTY) return Promise.reject(new Error('This command needs an interactive terminal (or pass the value as a flag).'));
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (options.hidden) {
      const internal = rl as unknown as { _writeToOutput: (s: string) => void };
      let prompted = false;
      internal._writeToOutput = (s: string) => {
        if (!prompted) {
          process.stdout.write(s);
          prompted = true;
        } else if (s.includes('\n') || s.includes('\r')) {
          process.stdout.write('\n');
        }
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function confirm(question: string, options: { yes?: boolean } = {}): Promise<boolean> {
  if (options.yes) return true;
  if (!process.stdin.isTTY) return false;
  const answer = await ask(`${question} [y/N] `);
  return /^y(es)?$/i.test(answer);
}

/** Read all of stdin (for `--password-stdin` and piped CSV). */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

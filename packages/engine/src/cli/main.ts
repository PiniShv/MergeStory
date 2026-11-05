#!/usr/bin/env node
import { runCli } from './program.ts';

// Writing to a closed pipe (for example "mergestory ... | head") is not an error worth a stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
  });
}

const code = await runCli(process.argv.slice(2));
// Set the code instead of calling process.exit(), so everything written to a pipe is flushed.
process.exitCode = code;
// Safety net: if a stray handle keeps the process alive after the work is done, leave anyway.
setTimeout(() => process.exit(code), 15_000).unref();

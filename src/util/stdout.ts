/**
 * Let a listing script be piped into `head` without crashing.
 *
 * `npm run agent:queue | head -8` closes the pipe once head has what it wants,
 * and the next write raises EPIPE, which Node turns into an unhandled 'error'
 * event and a stack trace. The command did exactly what was asked and still
 * looks like it failed — and worse, the trace lands under the output someone
 * was reading, which is where a real error would have gone.
 *
 * Every other EPIPE is still fatal; only a closed stdout is treated as the
 * normal end of a pipeline.
 */
export function tolerateClosedPipe(): void {
  const quit = (err: NodeJS.ErrnoException): void => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  };
  process.stdout.on('error', quit);
  process.stderr.on('error', quit);
}

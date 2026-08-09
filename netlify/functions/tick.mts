import type { Config } from '@netlify/functions';
import { runTick } from '../lib/core.mjs';

export default async () => {
  const result = await runTick();
  if (result.action !== 'none') {
    console.log(`[tick] ${result.weekKey}: ${result.action} (${result.stage})`);
  }
};

export const config: Config = {
  // Every two minutes. The ladder derives every decision from the clock rather
  // than from timers, so a rung simply fires at the first tick past its time --
  // a sub-two-minute delay nobody will notice. Halving the cadence from once a
  // minute also halves the invocation count against the free tier, which
  // matters when the scheduler runs 24/7 forever.
  schedule: '*/2 * * * *',
};

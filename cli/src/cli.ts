#!/usr/bin/env node
import { main } from './index';

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`✖ ${(err as Error).message}`);
    process.exit(1);
  }
);

#!/usr/bin/env node
'use strict';

require('../lib/cli/vbprobe').main(process.argv.slice(2)).then(
    code => { process.exitCode = code; },
    error => {
        console.error(`vbprobe: ${error instanceof Error ? error.message : error}`);
        process.exitCode = 1;
    },
);

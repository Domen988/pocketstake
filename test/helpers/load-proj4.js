// Node tests: expose the vendored proj4 UMD build as the global that
// src/proj.js expects (the browser gets it from a <script> tag).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.proj4 = require('../../vendor/proj4.js');

/**
 * Register the fixture-resolution hooks before the test files load.
 * Used as: node --import ./tests/loader.mjs --test tests/
 */

import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);

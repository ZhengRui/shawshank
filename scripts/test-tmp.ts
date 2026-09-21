import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Tests build real repositories under tmpdir(); scope them to one root per test file and remove it afterwards.
const root = mkdtempSync(join(tmpdir(), 'shawshank-test-'));
process.env.TMPDIR = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));

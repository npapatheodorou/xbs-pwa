/**
 * Verifies the shipped LZ-UTF8 decompressor against the real lzutf8 library
 * that the official xBrowserSync client uses.
 *
 * This is the test that matters most in this repo: if decompression diverges
 * even slightly, bookmarks silently come out corrupted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import lz from 'lzutf8';

// The exact file the browser loads.
import { decompress, decompressToString } from '../public/js/lzutf8.js';

const roundTrip = (input) => decompressToString(lz.compress(input));

test('empty input', () => {
  assert.equal(decompress(new Uint8Array()).length, 0);
});

test('short and literal strings', () => {
  for (const s of ['a', 'ab', '[]', '{}', ' ', 'hello world']) {
    assert.equal(roundTrip(s), s);
  }
});

test('highly repetitive input (short-range matches)', () => {
  for (const s of ['a'.repeat(5000), 'abc'.repeat(3000), 'xy'.repeat(40)]) {
    assert.equal(roundTrip(s), s);
  }
});

test('long input exercising 2-byte match distances', () => {
  const s = 'The quick brown fox jumps over the lazy dog. '.repeat(4000);
  assert.equal(roundTrip(s), s);
});

test('multi-byte UTF-8: accents, CJK, RTL, emoji', () => {
  const cases = [
    'é',
    'café '.repeat(200),
    '中文字符测试'.repeat(300),
    'مرحبا بالعالم '.repeat(200),
    'Ω≈ç√∫˜µ≤≥÷'.repeat(200),
    '😀',
    '😀🎉❤️'.repeat(300),
    'ñ'.repeat(1000)
  ];
  for (const s of cases) {
    assert.equal(roundTrip(s), s, `failed for ${s.slice(0, 20)}…`);
  }
});

test('lead bytes adjacent to match sequences stay literal', () => {
  // Exercises the ambiguity between a UTF-8 lead byte and a back-reference:
  // both have the top two bits set, and are told apart by the following byte.
  for (let i = 0; i < 200; i++) {
    const s = ('é中😀'.repeat(i % 7) + 'a'.repeat(i)).repeat(3);
    assert.equal(roundTrip(s), s);
  }
});

test('realistic xBrowserSync bookmark trees', () => {
  let id = 1;
  const ALPHA = Array.from(
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_/.:é中😀ñΩ'
  );
  // Deterministic PRNG so a failure is reproducible.
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const randStr = (len) => {
    let s = '';
    for (let i = 0; i < len; i++) s += ALPHA[Math.floor(rand() * ALPHA.length)];
    return s;
  };

  const makeNode = (depth) => {
    if (depth > 0 && rand() < 0.4) {
      return {
        id: id++,
        title: randStr(1 + Math.floor(rand() * 40)),
        children: Array.from({ length: Math.floor(rand() * 5) }, () => makeNode(depth - 1))
      };
    }
    const node = {
      id: id++,
      title: randStr(1 + Math.floor(rand() * 60)),
      url: `https://${randStr(10)}.example.com/${randStr(20)}`
    };
    if (rand() < 0.5) node.description = randStr(Math.floor(rand() * 300));
    if (rand() < 0.5) node.tags = Array.from({ length: Math.floor(rand() * 5) }, () => randStr(8));
    return node;
  };

  for (let i = 0; i < 150; i++) {
    const tree = [
      { id: id++, title: '[xbs] Toolbar', children: Array.from({ length: 5 }, () => makeNode(3)) },
      { id: id++, title: '[xbs] Other', children: Array.from({ length: 5 }, () => makeNode(3)) }
    ];
    const json = JSON.stringify(tree);
    assert.equal(roundTrip(json), json, `tree ${i} mismatch`);
  }
});

test('large payload (1 MB)', () => {
  const s = JSON.stringify(
    Array.from({ length: 8000 }, (_, i) => ({
      id: i,
      title: `Bookmark number ${i} with a reasonably long title`,
      url: `https://example.com/page/${i}`,
      description: 'A description that repeats a lot across entries.',
      tags: ['tag-a', 'tag-b']
    }))
  );
  assert.ok(s.length > 1_000_000);
  assert.equal(roundTrip(s), s);
});

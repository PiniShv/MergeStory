import { describe, expect, it } from 'vitest';
import { parsePatchHunks } from './diff-parser.ts';

const MODIFY = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@ function top() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
 const e = 6;
@@ -20,3 +21,3 @@
 line20
-old21
+new21
 line22
`;

describe('parsePatchHunks on the output of git diff for one file', () => {
  it('reads a modified file with two hunks, ids and line numbers', () => {
    const hunks = parsePatchHunks(MODIFY, 'F1');
    expect(hunks.map((h) => h.id)).toEqual(['F1.H1', 'F1.H2']);
    const first = hunks[0]!;
    expect(first).toMatchObject({
      oldStart: 1,
      oldLines: 4,
      newStart: 1,
      newLines: 5,
      header: 'function top() {',
    });
    expect(first.lines).toEqual([
      { kind: 'ctx', text: 'const a = 1;', oldLine: 1, newLine: 1 },
      { kind: 'del', text: 'const b = 2;', oldLine: 2, newLine: null },
      { kind: 'add', text: 'const b = 3;', oldLine: null, newLine: 2 },
      { kind: 'add', text: 'const c = 4;', oldLine: null, newLine: 3 },
      { kind: 'ctx', text: 'const d = 5;', oldLine: 3, newLine: 4 },
      { kind: 'ctx', text: 'const e = 6;', oldLine: 4, newLine: 5 },
    ]);
    const second = hunks[1]!;
    expect(second.header).toBe('');
    expect(second.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['ctx', 20, 21],
      ['del', 21, null],
      ['add', null, 22],
      ['ctx', 22, 23],
    ]);
  });

  it('takes the file id for the hunk ids, and reads a missing count in the header as one line', () => {
    const text = `diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-x
+y
`;
    const [hunk] = parsePatchHunks(text, 'F7');
    expect(hunk!.id).toBe('F7.H1');
    expect(hunk).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
  });

  it('reads added and deleted files', () => {
    const added = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+one
+two
`;
    expect(parsePatchHunks(added, 'F1')[0]!.lines.map((l) => [l.kind, l.newLine, l.oldLine])).toEqual([
      ['add', 1, null],
      ['add', 2, null],
    ]);
    const deleted = `diff --git a/old.txt b/old.txt
deleted file mode 100644
index e69de29..0000000
--- a/old.txt
+++ /dev/null
@@ -1,3 +0,0 @@
-a
-b
-c
`;
    expect(parsePatchHunks(deleted, 'F1')[0]!.lines.map((l) => l.oldLine)).toEqual([1, 2, 3]);
  });

  it('reads a rename with changes, and has no hunks for a pure rename, a mode change or a binary file', () => {
    const renamed = `diff --git a/old_name.txt b/new_name.txt
similarity index 90%
rename from old_name.txt
rename to new_name.txt
index 92dfa21..d5a68b2 100644
--- a/old_name.txt
+++ b/new_name.txt
@@ -2,3 +2,3 @@
 b
-c
+C
 d
`;
    expect(parsePatchHunks(renamed, 'F1')[0]!.lines.map((l) => l.kind)).toEqual(['ctx', 'del', 'add', 'ctx']);
    expect(
      parsePatchHunks('diff --git a/a b/b\nsimilarity index 100%\nrename from a\nrename to b\n', 'F1'),
    ).toEqual([]);
    expect(parsePatchHunks('diff --git a/m.sh b/m.sh\nold mode 100644\nnew mode 100755\n', 'F1')).toEqual([]);
    expect(
      parsePatchHunks(
        'diff --git a/my image.png b/my image.png\nindex 1..2 100644\nBinary files a/my image.png and b/my image.png differ\n',
        'F1',
      ),
    ).toEqual([]);
  });

  it('ignores the "no newline" marker when numbering lines', () => {
    const text = `diff --git a/n.txt b/n.txt
--- a/n.txt
+++ b/n.txt
@@ -1,2 +1,2 @@
 keep
-last
\\ No newline at end of file
+last!
\\ No newline at end of file
`;
    expect(parsePatchHunks(text, 'F1')[0]!.lines).toEqual([
      { kind: 'ctx', text: 'keep', oldLine: 1, newLine: 1 },
      { kind: 'del', text: 'last', oldLine: 2, newLine: null },
      { kind: 'add', text: 'last!', oldLine: null, newLine: 2 },
    ]);
  });

  it('does not mistake changed lines that look like file headers for headers', () => {
    // The removed line "-- note" prints as "--- note"; the added line "++ plus" prints as "+++ plus".
    const text = `diff --git a/q.sql b/q.sql
--- a/q.sql
+++ b/q.sql
@@ -1,3 +1,3 @@
 select 1;
--- note
+++ plus
 select 2;
`;
    const hunks = parsePatchHunks(text, 'F1');
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.lines.map((l) => [l.kind, l.text])).toEqual([
      ['ctx', 'select 1;'],
      ['del', '-- note'],
      ['add', '++ plus'],
      ['ctx', 'select 2;'],
    ]);
  });

  it('strips carriage returns from CRLF diffs', () => {
    const text =
      'diff --git a/w.txt b/w.txt\r\n--- a/w.txt\r\n+++ b/w.txt\r\n@@ -1,2 +1,2 @@\r\n one\r\n-two\r\n+three\r\n';
    expect(parsePatchHunks(text, 'F1')[0]!.lines.map((l) => l.text)).toEqual(['one', 'two', 'three']);
  });

  it('accepts empty context lines that lost their leading space', () => {
    const text = 'diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1,3 +1,3 @@\n x\n\n-y\n+z\n';
    expect(parsePatchHunks(text, 'F1')[0]!.lines.map((l) => [l.kind, l.text, l.oldLine, l.newLine])).toEqual([
      ['ctx', 'x', 1, 1],
      ['ctx', '', 2, 2],
      ['del', 'y', 3, null],
      ['add', 'z', null, 3],
    ]);
  });

  it('handles pure insertions and pure deletions inside a file', () => {
    const text = `diff --git a/p.txt b/p.txt
--- a/p.txt
+++ b/p.txt
@@ -5,0 +6,2 @@
+inserted1
+inserted2
@@ -10,2 +11,0 @@
-gone1
-gone2
`;
    const hunks = parsePatchHunks(text, 'F1');
    expect(hunks[0]!.lines.map((l) => [l.kind, l.newLine])).toEqual([
      ['add', 6],
      ['add', 7],
    ]);
    expect(hunks[1]!.lines.map((l) => [l.kind, l.oldLine])).toEqual([
      ['del', 10],
      ['del', 11],
    ]);
  });

  it('keeps what it has when a hunk is cut short', () => {
    const text = `diff --git a/t.txt b/t.txt
--- a/t.txt
+++ b/t.txt
@@ -1,5 +1,5 @@
 one
-two
+TWO
`;
    expect(parsePatchHunks(text, 'F1')[0]!.lines).toHaveLength(3);
  });

  it('returns nothing for unrelated text', () => {
    expect(parsePatchHunks('hello\nworld\n', 'F1')).toEqual([]);
  });
});

describe('parsePatchHunks', () => {
  it('reads hunks from a GitHub patch string with the given file id', () => {
    const patch = `@@ -1,3 +1,4 @@ class A {
 a
+b
 c
 d
@@ -30,2 +31,2 @@
-x
+y
 z
\\ No newline at end of file`;
    const hunks = parsePatchHunks(patch, 'F12');
    expect(hunks.map((h) => h.id)).toEqual(['F12.H1', 'F12.H2']);
    expect(hunks[0]).toMatchObject({ header: 'class A {', oldLines: 3, newLines: 4 });
    expect(hunks[0]!.lines.map((l) => [l.kind, l.text, l.oldLine, l.newLine])).toEqual([
      ['ctx', 'a', 1, 1],
      ['add', 'b', null, 2],
      ['ctx', 'c', 2, 3],
      ['ctx', 'd', 3, 4],
    ]);
    expect(hunks[1]!.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['del', 30, null],
      ['add', null, 31],
      ['ctx', 31, 32],
    ]);
  });

  it('ignores text before the first header and returns [] when there is no hunk', () => {
    expect(parsePatchHunks('Binary files differ', 'F1')).toEqual([]);
    expect(parsePatchHunks('', 'F1')).toEqual([]);
    const hunks = parsePatchHunks('noise\n@@ -1 +1 @@\n-a\n+b', 'F3');
    expect(hunks[0]!.id).toBe('F3.H1');
    expect(hunks[0]!.lines).toHaveLength(2);
  });
});

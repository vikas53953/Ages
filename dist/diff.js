/**
 * A unified line diff with hunks (like `git diff`), for /diff. Longest-common-subsequence on the lines between
 * the unchanged start and end; when that middle is too big for the table, the whole middle is shown as one
 * change instead, so a huge file can never make this slow.
 */
/** Middle sizes past this (old lines × new lines) use the one-block fallback. */
const MAX_CELLS = 4_000_000;
function operations(a, b) {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start])
        start += 1;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA -= 1;
        endB -= 1;
    }
    const ops = [];
    for (let i = 0; i < start; i += 1)
        ops.push({ kind: " ", text: a[i], oldLine: i + 1, newLine: i + 1 });
    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);
    const n = midA.length;
    const m = midB.length;
    if (n && m && n * m <= MAX_CELLS) {
        // lcs[i][j] = common length of midA[i..] and midB[j..], one flat table.
        const width = m + 1;
        const lcs = new Uint32Array((n + 1) * width);
        for (let i = n - 1; i >= 0; i -= 1) {
            for (let j = m - 1; j >= 0; j -= 1) {
                lcs[i * width + j] = midA[i] === midB[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < n || j < m) {
            if (i < n && j < m && midA[i] === midB[j]) {
                ops.push({ kind: " ", text: midA[i], oldLine: start + i + 1, newLine: start + j + 1 });
                i += 1;
                j += 1;
            }
            else if (i < n && (j >= m || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
                // Removals first, like git: a replaced line reads "-old" then "+new".
                ops.push({ kind: "-", text: midA[i], oldLine: start + i + 1, newLine: start + j });
                i += 1;
            }
            else {
                ops.push({ kind: "+", text: midB[j], oldLine: start + i, newLine: start + j + 1 });
                j += 1;
            }
        }
    }
    else {
        midA.forEach((text, k) => ops.push({ kind: "-", text, oldLine: start + k + 1, newLine: start }));
        midB.forEach((text, k) => ops.push({ kind: "+", text, oldLine: endA, newLine: start + k + 1 }));
    }
    for (let k = 0; k < a.length - endA; k += 1)
        ops.push({ kind: " ", text: a[endA + k], oldLine: endA + k + 1, newLine: endB + k + 1 });
    return ops;
}
/** Split text into lines the way an editor shows them (CRLF or LF; a final newline is not an extra line). */
export function textLines(text) {
    if (!text)
        return [];
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === "")
        lines.pop();
    return lines;
}
/** Hunks with `context` unchanged lines around each change, and the +/- counts. */
export function unifiedDiff(oldText, newText, context = 3) {
    const ops = operations(textLines(oldText), textLines(newText));
    const stat = { added: ops.filter((op) => op.kind === "+").length, removed: ops.filter((op) => op.kind === "-").length };
    const changed = ops.map((op, index) => (op.kind === " " ? -1 : index)).filter((index) => index >= 0);
    const lines = [];
    // Hunks: runs of changes closer than 2 × context lines share one hunk.
    let index = 0;
    while (index < changed.length) {
        let end = index;
        // Like git: changes with at most 2 × context unchanged lines between them share a hunk.
        while (end + 1 < changed.length && changed[end + 1] - changed[end] <= 2 * context + 1)
            end += 1;
        const from = Math.max(0, changed[index] - context);
        const to = Math.min(ops.length - 1, changed[end] + context);
        const slice = ops.slice(from, to + 1);
        const oldStart = slice.find((op) => op.kind !== "+")?.oldLine ?? slice[0].oldLine;
        const newStart = slice.find((op) => op.kind !== "-")?.newLine ?? slice[0].newLine;
        const oldCount = slice.filter((op) => op.kind !== "+").length;
        const newCount = slice.filter((op) => op.kind !== "-").length;
        lines.push(`@@ -${oldStart}${oldCount === 1 ? "" : `,${oldCount}`} +${newStart}${newCount === 1 ? "" : `,${newCount}`} @@`);
        for (const op of slice)
            lines.push(`${op.kind}${op.text}`);
        index = end + 1;
    }
    return { lines, stat };
}

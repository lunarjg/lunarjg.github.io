# docx-preview 0.4.1 — changes made for Note Viewer

Source: https://github.com/VolodymyrBaydalka/docxjs (npm `docx-preview@0.4.1`, `dist/docx-preview.mjs`),
Apache License 2.0 (see LICENSE). Changes:

1. JSZip is imported from `../jszip/jszip.mjs` (no bundler).
2. Tab stops are measured right after rendering (0 ms instead of 500 ms), so the app can lay out
   pages as soon as rendering ends.
3. `renderHeaderFooter` renders every header/footer variant that can appear in a section (first
   page, even pages, default), each marked `data-nv-hf="<type>"`, and marks the page element with
   `data-nv-first` when it starts a section. `js/convert.js` breaks the text into pages itself and
   picks the right variant for each page.
4. The page element also gets `data-nv-title` when its section has a separate first page
   (Word's "different first page": the first page shows only first-page headers and footers).
5. `h()` creates nodes in the document being rendered into (the app's script-less frame), not in
   the app's own document.
6. A paragraph split by a page break marks its second part `nv-cont` (the app draws it without a
   second list number).
7. `groupByPageBreaks` starts a new page after each part except before a section of type
   "continuous" (same orientation, no page break): Word keeps those on the same page (with
   `ignoreLastRenderedPageBreak` the original made every section a page).
8. `splitBySection`: a paragraph's own `pageBreakBefore` (also `w:val="0"`) wins over its style's.
9. The source map comment is removed.

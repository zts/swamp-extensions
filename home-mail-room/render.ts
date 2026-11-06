/**
 * Renders the top of one PDF page to PNG in-process, with PDFium compiled to
 * WebAssembly, so reading a scanned letter needs no Python and no subprocess.
 *
 * @module
 */
import { PDFiumLibrary } from "npm:@hyzyla/pdfium@3.0.0/inline";
import { encode } from "npm:fast-png@8.0.0";

/** Lowest and highest dpi renderTop accepts. A4 at 600 dpi is ~140MB RGBA. */
export const MIN_DPI = 50;
export const MAX_DPI = 600;

/** What to render: a 1-based page, the share of it from the top, and dpi. */
export interface RenderOptions {
  page: number;
  fraction: number;
  dpi: number;
}

/**
 * The rendered region as PNG, its size in pixels, the whole page's height in
 * pixels, and the page count.
 */
export interface RenderedTop {
  png: Uint8Array;
  width: number;
  height: number;
  pageHeight: number;
  pageCount: number;
}

/** Rows to keep for the top `fraction` of `height`: at least one. */
export function topRows(height: number, fraction: number): number {
  return Math.min(height, Math.max(1, Math.round(height * fraction)));
}

function check(options: RenderOptions) {
  const { fraction, dpi } = options;
  if (!(fraction > 0 && fraction <= 1)) {
    throw new Error(`fraction must be in (0, 1], got ${fraction}`);
  }
  if (!Number.isInteger(dpi) || dpi < MIN_DPI || dpi > MAX_DPI) {
    throw new Error(
      `dpi must be a whole number from ${MIN_DPI} to ${MAX_DPI}, got ${dpi}`,
    );
  }
}

/** Render the top `fraction` of `page` of a PDF at `dpi`, on white. */
export async function renderTop(
  pdf: Uint8Array,
  options: RenderOptions,
): Promise<RenderedTop> {
  check(options);
  const library = await PDFiumLibrary.init({ disableBase64Warning: true });
  try {
    let document;
    try {
      document = await library.loadDocument(pdf);
    } catch (error) {
      throw new Error(
        `not a readable PDF: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    try {
      const pageCount = document.getPageCount();
      const { page } = options;
      if (!Number.isInteger(page) || page < 1 || page > pageCount) {
        throw new Error(
          `page ${page} is out of range: the PDF has ${pageCount} pages`,
        );
      }
      const bitmap = await document.getPage(page - 1).render({
        scale: options.dpi / 72,
        render: "bitmap",
      });
      // The bitmap is RGBA rows from the top, so the top is a prefix of it.
      const height = topRows(bitmap.height, options.fraction);
      const png = encode({
        width: bitmap.width,
        height,
        data: bitmap.data.subarray(0, bitmap.width * height * 4),
        channels: 4,
      });
      return {
        png,
        width: bitmap.width,
        height,
        pageHeight: bitmap.height,
        pageCount,
      };
    } finally {
      document.destroy();
    }
  } finally {
    library.destroy();
  }
}

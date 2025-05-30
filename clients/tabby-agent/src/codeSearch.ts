import * as Engine from "@orama/orama";
import type { Position, Range } from "vscode-languageserver";
import type { DocumentRange } from "./utils/types";
import { extractNonReservedWordList } from "./utils/string";
import { isPositionBefore, isPositionAfter, unionRange, rangeInDocument } from "./utils/range";

export interface Chunk {
  // Which file does the snippet belongs to
  uri: string;
  // (Not Indexed) The offset of the snippet in the file
  range: Range;
  // (Not Indexed) The full text of the snippet
  text: string;
  // The code language id of the snippet
  language: string;
  // The semantic symbols extracted from the snippet
  symbols: string;
}

export interface ChunkingConfig {
  // max count for chunks in memory
  maxChunks: number;
  // chars count per code chunk
  chunkSize: number;
  // lines count overlap between neighbor chunks
  overlapLines: number;
}

export type CodeSearchResultItem = Chunk & {
  score: number;
};

export type CodeSearchResult = CodeSearchResultItem[];

export class CodeSearchEngine {
  constructor(private config: ChunkingConfig) {}

  private db: Engine.AnyOrama | undefined = undefined;
  private indexedDocumentRanges: (DocumentRange & { indexIds: string[] })[] = [];

  private async init() {
    if (this.db) {
      return;
    }
    this.db = await Engine.create({
      schema: {
        uri: "string",
        language: "string",
        symbols: "string",
      },
    });
  }

  private async count(): Promise<number> {
    if (!this.db) {
      return 0;
    }
    return await Engine.count(this.db);
  }

  private async insert(snippets: Chunk[]): Promise<string[]> {
    if (!this.db) {
      await this.init();
    }
    if (this.db) {
      return await Engine.insertMultiple(this.db, snippets);
    }
    return [];
  }

  private async remove(ids: string[]): Promise<number> {
    if (!this.db) {
      return 0;
    }
    return await Engine.removeMultiple(this.db, ids);
  }

  private async chunk(documentRange: DocumentRange): Promise<Chunk[]> {
    const document = documentRange.document;
    const range = rangeInDocument(documentRange.range, document);
    if (!range) {
      return [];
    }
    const chunks: Chunk[] = [];
    let positionStart: Position = range.start;
    let positionEnd;
    do {
      const offset = document.offsetAt(positionStart);
      // move forward chunk size
      positionEnd = document.positionAt(offset + this.config.chunkSize);
      if (isPositionBefore(positionEnd, range.end)) {
        // If have not reached the end, back to the last newline instead
        positionEnd = { line: positionEnd.line, character: 0 };
      }
      if (positionEnd.line <= positionStart.line + this.config.overlapLines) {
        // In case of forward chunk size does not moved enough lines for overlap, force move that much lines
        positionEnd = { line: positionStart.line + this.config.overlapLines + 1, character: 0 };
      }
      if (isPositionAfter(positionEnd, range.end)) {
        // If have passed the end, back to the end
        positionEnd = range.end;
      }

      const chunkRange = { start: positionStart, end: positionEnd };
      const text = document.getText(chunkRange);
      if (text.trim().length > 0) {
        chunks.push({
          uri: document.uri,
          range: chunkRange,
          text: text,
          language: document.languageId,
          symbols: extractNonReservedWordList(text),
        });
      }

      // move the start position to the next chunk start
      positionStart = { line: positionEnd.line - this.config.overlapLines, character: 0 };
    } while (chunks.length < this.config.maxChunks && isPositionBefore(positionEnd, range.end));
    return chunks;
  }

  getIndexedDocumentRange(): DocumentRange[] {
    return this.indexedDocumentRanges;
  }

  /**
   * Index the range of the document.
   *
   * When invoked multiple times with the same document but different ranges,
   * the ranges will be merged and re-chunked.
   *
   * If the indexed chunks in memory is too many, the oldest document will be removed.
   * The removal is by document, all chunks from the document will be removed.
   *
   * @param documentRange The document and specific range to index.
   */
  async index(documentRange: DocumentRange): Promise<void> {
    const { document, range } = documentRange;
    const documentUriString = document.uri.toString();
    let targetRange = range;
    const indexToUpdate = this.indexedDocumentRanges.findIndex(
      (item) => item.document.uri.toString() === documentUriString,
    );
    const documentRangeToUpdate = this.indexedDocumentRanges[indexToUpdate];
    if (documentRangeToUpdate) {
      // FIXME: union is not perfect for merging two ranges have large distance between them
      targetRange = unionRange(targetRange, documentRangeToUpdate.range);
    }
    const chunks = await this.chunk({ document, range: targetRange });
    if (documentRangeToUpdate) {
      await this.remove(documentRangeToUpdate.indexIds);
      this.indexedDocumentRanges.splice(indexToUpdate);
    }
    const indexIds = await this.insert(chunks);
    this.indexedDocumentRanges.push({
      document,
      range: targetRange,
      indexIds,
    });

    // Check chunks count and evict if needed.
    while ((await this.count()) > this.config.maxChunks) {
      const toRemove = this.indexedDocumentRanges.shift();
      if (toRemove) {
        await this.remove(toRemove.indexIds);
      } else {
        break;
      }
    }
  }

  /**
   * Search relevant code snippets that has been indexed.
   * @param query contains words to search.
   * @param options
   * @param options.filepathsFilter only search in these filepaths.
   * @param options.languagesFilter only search in these languages.
   * @param options.limit max number of hits to return.
   * @returns A list of hit results, contains the snippet and score.
   */
  async search(
    query: string,
    options?: {
      filepathsFilter?: string[];
      languagesFilter?: string[];
      limit?: number;
    },
  ): Promise<CodeSearchResult> {
    if (!this.db) {
      return [];
    }
    const searchResult = await Engine.search<Engine.AnyOrama, Chunk>(this.db, {
      term: query,
      properties: ["symbols"],
      where: {
        uri: options?.filepathsFilter,
        language: options?.languagesFilter,
      },
      limit: options?.limit,
    });
    return (
      searchResult.hits
        // manual filtering
        .filter((hit) => {
          if (options?.filepathsFilter && !options?.filepathsFilter.includes(hit.document["uri"])) {
            return false;
          }
          if (options?.languagesFilter && !options?.languagesFilter.includes(hit.document["language"])) {
            return false;
          }
          return true;
        })
        .map((hit) => {
          return {
            ...hit.document,
            score: hit.score || 0, // set score to 0 if it is NaN
          };
        })
        .sort((a, b) => b.score - a.score)
    );
  }
}

import TurndownService from "turndown";

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  td.remove(["script", "style", "iframe", "object", "embed", "noscript"]);
  return td;
}

const turndown = createTurndown();

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}

import { describe, expect, it } from "vitest";
import { extractMentionIds } from "../commentMentions";

const A = "3f2a5b1e-0000-4000-8000-000000000001";
const B = "3f2a5b1e-0000-4000-8000-000000000002";

describe("extractMentionIds", () => {
  it("should find the mentioned ids once, in order", () => {
    expect(extractMentionIds(`Hallo <@${B}> und <@${A}>, nochmal <@${B}>`)).toEqual([B, A]);
  });
  it.each([
    "<@123>",
    `<@${A.toUpperCase()}>`,
    `<@${A}`,
    `@${A}`,
    "",
  ])("should treat %j as plain text", (text) => {
    expect(extractMentionIds(text)).toEqual([]);
  });
  it("should find adjacent tokens", () => {
    expect(extractMentionIds(`<@${A}><@${B}>`)).toEqual([A, B]);
  });
  it("should give the same result for the same input every time", () => {
    const text = `Hallo <@${A}> und <@${B}>`;
    expect(extractMentionIds(text)).toEqual([A, B]);
    expect(extractMentionIds(text)).toEqual([A, B]);
  });
  it("should return nothing for a deleted comment", () => {
    expect(extractMentionIds(null)).toEqual([]);
  });
});
